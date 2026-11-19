// Scheduled jobs, checked every 15 minutes in Eastern time: Friday auto-fill, 7-day and 1-day
// reminders, the two-week "still short" nudge, and the monthly digest of open slots.
const { get, all, run } = require('../db');
const cal = require('./calendar');
const engine = require('./engine');
const { isEligible, MINISTRY_NAMES } = require('./eligibility');
const { emailPerson, appUrl } = require('./notify');

const SIGNUP_MINISTRIES = ['communion', 'prayer'];
const SEND_HOUR = 9;
const AUTOFILL_HOUR = 12;
const CHECK_MS = 15 * 60 * 1000;

function alreadySent(personId, ref, kind) {
  return !!get('SELECT 1 FROM reminder_log WHERE person_id = ? AND ref = ? AND kind = ?', [personId, ref, kind]);
}

function markSent(personId, ref, kind) {
  run('INSERT OR IGNORE INTO reminder_log (person_id, ref, kind) VALUES (?,?,?)', [personId, ref, kind]);
}

async function runAutofills(now) {
  for (const ministry of SIGNUP_MINISTRIES) {
    const due = all(`SELECT e.id, d.date FROM ministry_events e JOIN service_days d ON d.id = e.service_day_id
                     WHERE e.ministry = ? AND e.kind = 'regular' AND e.status = 'upcoming' AND d.date > ?`, [ministry, now.date])
      .filter(e => {
        const fillOn = cal.autofillDate(e.date);
        return now.date > fillOn || (now.date === fillOn && now.hour >= AUTOFILL_HOUR);
      });
    for (const e of due) {
      const { event, added } = engine.autofill(e.id);
      console.log(`[Auto-fill] ${MINISTRY_NAMES[ministry]} ${event.date}: ${added.length} assigned`);
      await engine.sendAssignmentNotices(event, added);
    }
  }
}

async function personalReminders(now) {
  if (now.hour < SEND_HOUR) return;
  for (const [kind, daysAhead] of [['7day', 7], ['1day', 1]]) {
    const date = cal.addDays(now.date, daysAhead);
    const rows = all(`SELECT a.person_id, e.ministry, pos.service_time, pos.campus, pos.area FROM assignments a
                      JOIN ministry_events e ON e.id = a.event_id JOIN service_days d ON d.id = e.service_day_id
                      JOIN positions pos ON pos.id = a.position_id WHERE d.date = ? AND ${engine.VISIBLE_SQL} ORDER BY pos.sort_order`, [date]);
    const byPerson = new Map();
    for (const r of rows) {
      if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, []);
      byPerson.get(r.person_id).push(`${MINISTRY_NAMES[r.ministry]}: ${engine.describePosition(r)}`);
    }
    for (const [personId, duties] of byPerson) {
      if (alreadySent(personId, date, kind)) continue;
      const person = get('SELECT * FROM people WHERE id = ?', [personId]);
      await emailPerson(person, `${daysAhead === 1 ? 'Tomorrow' : 'Next Sunday'}: you're serving on ${cal.formatDay(date)}`, [
        `Hi ${person.name},`,
        `A reminder that you're serving on ${cal.formatLongDay(date)}:`,
        ...duties,
        "If you can't make it, propose a swap in MPC Officer Service as soon as you can.",
      ], { url: `${appUrl()}/me`, label: 'View My Sundays' });
      markSent(personId, date, kind);
    }
  }
}

function openSlotCount(event) {
  return engine.eventSlots(event).reduce((n, s) => n + s.open, 0);
}

async function twoWeekNudges(now) {
  if (now.hour < SEND_HOUR) return;
  const date = cal.addDays(now.date, 14);
  for (const ministry of SIGNUP_MINISTRIES) {
    for (const event of engine.upcomingEvents(ministry, date, date).filter(engine.isOpen)) {
      const open = openSlotCount(event);
      if (!open) continue;
      const serving = new Set(engine.eventAssignments(event.id).map(a => a.person_id));
      const people = all('SELECT * FROM people').filter(p => isEligible(p, ministry) && !serving.has(p.id) &&
        !engine.awayStatus(p.id, event.service_day_id, ministry).blocked);
      for (const person of people) {
        const ref = `event:${event.id}`;
        if (alreadySent(person.id, ref, '2wk')) continue;
        await emailPerson(person, `${MINISTRY_NAMES[ministry]} on ${cal.formatDay(event.date)} still needs ${open} ${open === 1 ? 'person' : 'people'}`, [
          `Hi ${person.name},`,
          `${MINISTRY_NAMES[ministry]} on ${cal.formatLongDay(event.date)} still has ${open} open ${open === 1 ? 'slot' : 'slots'}. If you can serve, please sign up. Any slots still open the Friday before are filled automatically.`,
        ], { url: `${appUrl()}/${ministry}/${event.id}`, label: 'Sign up' });
        markSent(person.id, ref, '2wk');
      }
    }
  }
}

async function monthlyDigest(now) {
  if (!now.date.endsWith('-01') || now.hour < SEND_HOUR) return;
  const ref = now.date.slice(0, 7);
  const windowEnd = cal.addMonths(now.date, engine.SIGNUP_WINDOW_MONTHS);
  const openEvents = SIGNUP_MINISTRIES.flatMap(m => engine.upcomingEvents(m, cal.addDays(now.date, 1), windowEnd)
    .filter(engine.isOpen).map(e => ({ event: e, open: openSlotCount(e) })).filter(x => x.open));
  if (!openEvents.length) return;
  for (const person of all('SELECT * FROM people WHERE notify_email = 1')) {
    if (alreadySent(person.id, ref, 'digest')) continue;
    const lines = openEvents
      .filter(({ event }) => isEligible(person, event.ministry) && !engine.eventAssignments(event.id).some(a => a.person_id === person.id))
      .map(({ event, open }) => `${MINISTRY_NAMES[event.ministry]}, ${cal.formatDay(event.date)}: ${open} open`);
    if (!lines.length) continue;
    await emailPerson(person, 'Open sign-ups for the next three months', [
      `Hi ${person.name},`,
      'These Sundays still have open slots you can sign up for:',
      ...lines,
    ], { url: `${appUrl()}/me`, label: 'Sign up' });
    markSent(person.id, ref, 'digest');
  }
}

async function tick() {
  const now = cal.nowEastern();
  try {
    cal.ensureSundays(15);
    cal.ensureCommunionEvents(15);
    cal.ensureWeeklyEvents('prayer', 15);
    const duty = require('./duty');
    duty.archiveFinishedSeasons();
    await runAutofills(now);
    await personalReminders(now);
    await twoWeekNudges(now);
    await monthlyDigest(now);
    await duty.deadlineReminders(now);
    await duty.thursdayEmail(now);
    await duty.specialReminders(now);
  } catch (err) {
    console.error('[Reminders] Check failed:', err.message);
  }
}

function startReminders() {
  tick();
  setInterval(tick, CHECK_MS);
  console.log('[Reminders] Checking every 15 minutes (Eastern time)');
}

module.exports = { startReminders, tick, runAutofills, personalReminders, twoWeekNudges, monthlyDigest, SIGNUP_MINISTRIES };
