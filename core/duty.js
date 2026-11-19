// Duty Deacon: seasons (collect blackouts → draft → published → archived), the season planner
// ported from election-scheduler, special-service sign-ups, and duty reminders.
const { get, all, run, transaction, lastId } = require('../db');
const cal = require('./calendar');
const engine = require('./engine');
const { isEligible } = require('./eligibility');
const { emailPerson, emailStaff, appUrl } = require('./notify');

const DEFAULT_MAX_SHIFTS = 26;
const SEND_HOUR = 9;
const THURSDAY_HOUR = 14;

function getMeta(key, fallback) {
  const row = get('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(value)]);
}

function settings() {
  return {
    lookback: parseInt(getMeta('duty_lookback_seasons', '2'), 10) || 0,
    thursdayEmail: getMeta('thursday_email', 'on') === 'on',
  };
}

function deacons() {
  return all('SELECT * FROM people ORDER BY name').filter(p => isEligible(p, 'duty'));
}

function maxShifts(personId) {
  const row = get("SELECT max_shifts FROM ministry_prefs WHERE person_id = ? AND ministry = 'duty'", [personId]);
  return row ? row.max_shifts : DEFAULT_MAX_SHIFTS;
}

function setMaxShifts(personId, value) {
  const n = Math.max(0, Math.min(60, parseInt(value, 10) || 0));
  run("INSERT OR REPLACE INTO ministry_prefs (person_id, ministry, max_shifts) VALUES (?, 'duty', ?)", [personId, n]);
}

// ─── Seasons ────────────────────────────────────────
function getSeason(id) {
  return get("SELECT * FROM seasons WHERE id = ? AND ministry = 'duty'", [id]);
}

function listSeasons() {
  return all("SELECT * FROM seasons WHERE ministry = 'duty' ORDER BY start_date DESC");
}

function seasonEvents(seasonId) {
  return all(`SELECT e.*, d.date FROM ministry_events e JOIN service_days d ON d.id = e.service_day_id
              WHERE e.season_id = ? AND e.kind = 'regular' ORDER BY d.date`, [seasonId]);
}

function deadlinePassed(season) {
  return !!season.availability_deadline && cal.todayIso() > season.availability_deadline;
}

function createSeason(actor, { label, start, end, deadline }) {
  const name = String(label || '').trim();
  if (!name) return { error: 'Give the season a name, for example "Spring 2027".' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) return { error: 'Choose a start and end date.' };
  if (start > end) return { error: 'The start date must be before the end date.' };
  if (deadline && deadline > start) return { error: 'The blackout deadline must be on or before the first Sunday.' };
  const overlap = get(`SELECT label FROM seasons WHERE ministry = 'duty' AND status != 'archived' AND NOT (end_date < ? OR start_date > ?)`, [start, end]);
  if (overlap) return { error: `Those dates overlap the season "${overlap.label}".` };

  return transaction(() => {
    run(`INSERT INTO seasons (ministry, label, start_date, end_date, availability_deadline, status) VALUES ('duty', ?, ?, ?, ?, 'collecting')`,
      [name, start, end, deadline || null]);
    const seasonId = lastId();
    const d = new Date(start + 'T12:00:00');
    while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
    let sundays = 0;
    for (; cal.isoDate(d) <= end; d.setDate(d.getDate() + 7)) {
      const iso = cal.isoDate(d);
      run('INSERT OR IGNORE INTO service_days (date) VALUES (?)', [iso]);
      const day = get('SELECT id FROM service_days WHERE date = ?', [iso]);
      const existing = get("SELECT id, season_id FROM ministry_events WHERE ministry = 'duty' AND kind = 'regular' AND service_day_id = ?", [day.id]);
      if (existing) run('UPDATE ministry_events SET season_id = ? WHERE id = ?', [seasonId, existing.id]);
      else run("INSERT INTO ministry_events (ministry, service_day_id, season_id, kind) VALUES ('duty', ?, ?, 'regular')", [day.id, seasonId]);
      sundays++;
    }
    run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)', [actor.id, 'season_create', JSON.stringify({ seasonId, name, start, end, deadline })]);
    return { ok: true, seasonId, sundays };
  });
}

function submitAvailability(person, seasonId, awayDayIds) {
  const season = getSeason(seasonId);
  if (!season) return { error: 'That season was not found.' };
  if (season.status !== 'collecting' || deadlinePassed(season)) return { error: 'Blackout dates for this season are closed. Use My Sundays to mark an away day, and the coordinator will be told.' };
  if (!isEligible(person, 'duty')) return { error: "You aren't on the duty deacon roster." };
  const away = new Set(awayDayIds.map(Number));
  transaction(() => {
    for (const e of seasonEvents(season.id)) {
      if (away.has(e.service_day_id)) {
        run("INSERT OR IGNORE INTO unavailability (person_id, service_day_id, source) VALUES (?, ?, 'self')", [person.id, e.service_day_id]);
      } else {
        run('DELETE FROM unavailability WHERE person_id = ? AND service_day_id = ?', [person.id, e.service_day_id]);
      }
    }
    run('INSERT OR REPLACE INTO season_submissions (season_id, person_id) VALUES (?, ?)', [season.id, person.id]);
  });
  return { ok: true, away: away.size };
}

function submissionStatus(seasonId) {
  const submitted = new Set(all('SELECT person_id FROM season_submissions WHERE season_id = ?', [seasonId]).map(r => r.person_id));
  const days = seasonEvents(seasonId).map(e => e.service_day_id);
  return deacons().map(p => ({
    ...p,
    submitted: submitted.has(p.id),
    maxShifts: maxShifts(p.id),
    awayCount: days.length ? get(`SELECT COUNT(*) AS c FROM unavailability WHERE person_id = ? AND service_day_id IN (${days.map(() => '?').join(',')})`, [p.id, ...days]).c : 0,
    shifts: get(`SELECT COUNT(*) AS c FROM assignments a JOIN ministry_events e ON e.id = a.event_id WHERE e.season_id = ? AND a.person_id = ?`, [seasonId, p.id]).c,
  }));
}

// ─── Planner (ported from election-scheduler) ───────
// Phase 1 fills each Sunday in date order: under max shifts without back-to-back Sundays, then
// allowing back-to-back, then over max shifts as a last resort. Blackouts and one shift per Sunday
// are never broken. Phase 2 hands shifts from the most to the least used deacon where legal.
// Fairness counts this season plus the previous N seasons.
function planSeason(actor, seasonId) {
  const season = getSeason(seasonId);
  if (!season) return { error: 'That season was not found.' };
  if (!['collecting', 'draft'].includes(season.status)) return { error: 'A published season cannot be regenerated. Use the Sunday pages to make changes.' };
  const sundays = seasonEvents(season.id);
  const positions = all("SELECT * FROM positions WHERE ministry = 'duty' AND event_id IS NULL AND active = 1 ORDER BY sort_order");
  const candidates = deacons();
  if (!sundays.length) return { error: 'This season has no Sundays.' };
  if (!candidates.length) return { error: 'No active McLean deacons are on the roster.' };

  const days = sundays.map(e => e.service_day_id);
  const blackout = new Set(all(`SELECT person_id, service_day_id FROM unavailability WHERE service_day_id IN (${days.map(() => '?').join(',')})`, days)
    .map(r => `${r.person_id}-${r.service_day_id}`));
  const cap = {}, effectiveCap = {}, shifts = {}, lastServed = {}, histShifts = {}, histCap = {};
  for (const c of candidates) {
    cap[c.id] = maxShifts(c.id);
    const available = sundays.filter(e => !blackout.has(`${c.id}-${e.service_day_id}`)).length;
    effectiveCap[c.id] = Math.min(cap[c.id], available);
    shifts[c.id] = 0; lastServed[c.id] = -99; histShifts[c.id] = 0; histCap[c.id] = 0;
  }

  const { lookback } = settings();
  const history = lookback ? all(`SELECT id FROM seasons WHERE ministry = 'duty' AND id != ? AND status IN ('published','archived') AND end_date < ?
                                  ORDER BY end_date DESC LIMIT ?`, [season.id, season.start_date, lookback]) : [];
  for (const h of history) {
    for (const r of all(`SELECT a.person_id, COUNT(*) AS c FROM assignments a JOIN ministry_events e ON e.id = a.event_id WHERE e.season_id = ? GROUP BY a.person_id`, [h.id])) {
      if (r.person_id in histShifts) { histShifts[r.person_id] += r.c; histCap[r.person_id] += cap[r.person_id]; }
    }
  }

  const ratio = c => (shifts[c.id] + histShifts[c.id]) / ((effectiveCap[c.id] || 1) + histCap[c.id]);
  const byUtilization = list => [...list].sort((a, b) => (ratio(a) - ratio(b)) || (effectiveCap[a.id] - effectiveCap[b.id]) || (a.id - b.id));
  const plan = [];
  const daily = sundays.map(() => new Set());
  let unfilled = 0;

  sundays.forEach((e, si) => {
    for (const pos of positions) {
      let left = pos.needed;
      const free = c => !blackout.has(`${c.id}-${e.service_day_id}`) && !daily[si].has(c.id);
      const take = c => { plan.push({ si, eventId: e.id, positionId: pos.id, personId: c.id }); shifts[c.id]++; daily[si].add(c.id); lastServed[c.id] = si; left--; };
      for (const c of byUtilization(candidates)) { if (left <= 0) break; if (free(c) && shifts[c.id] < cap[c.id] && lastServed[c.id] !== si - 1) take(c); }
      if (left > 0) for (const c of byUtilization(candidates)) { if (left <= 0) break; if (free(c) && shifts[c.id] < cap[c.id]) take(c); }
      if (left > 0) for (const c of [...candidates].filter(c => free(c) && shifts[c.id] >= cap[c.id]).sort((a, b) => shifts[a.id] - shifts[b.id])) { if (left <= 0) break; take(c); }
      unfilled += left;
    }
  });

  let balanced = 0;
  for (let iter = 0; iter < 500; iter++) {
    const ranked = [...candidates].sort((a, b) => ratio(b) - ratio(a));
    const donor = ranked[0];
    const recipient = ranked.slice(1).reverse().find(c => shifts[c.id] < cap[c.id]);
    if (!donor || !recipient || ratio(donor) - ratio(recipient) < 0.05) break;
    const move = plan.find(p => p.personId === donor.id && !blackout.has(`${recipient.id}-${sundays[p.si].service_day_id}`) &&
      !daily[p.si].has(recipient.id) && !(daily[p.si - 1] && daily[p.si - 1].has(recipient.id)) && !(daily[p.si + 1] && daily[p.si + 1].has(recipient.id)));
    if (!move) break;
    daily[move.si].delete(donor.id); daily[move.si].add(recipient.id);
    shifts[donor.id]--; shifts[recipient.id]++;
    move.personId = recipient.id;
    balanced++;
  }

  transaction(() => {
    const ids = sundays.map(e => e.id);
    run(`DELETE FROM assignments WHERE event_id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const p of plan) run("INSERT INTO assignments (event_id, position_id, person_id, type) VALUES (?,?,?,'planned')", [p.eventId, p.positionId, p.personId]);
    run("UPDATE seasons SET status = 'draft' WHERE id = ?", [season.id]);
    run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)', [actor.id, 'season_plan', JSON.stringify({ seasonId: season.id, assignments: plan.length, unfilled, balanced })]);
  });
  const counts = candidates.map(c => shifts[c.id]);
  return { ok: true, assignments: plan.length, unfilled, balanced, sundays: sundays.length, min: Math.min(...counts), max: Math.max(...counts), history: history.length };
}

async function publishSeason(actor, seasonId) {
  const season = getSeason(seasonId);
  if (!season || season.status !== 'draft') return { error: 'Generate the schedule before publishing.' };
  run("UPDATE seasons SET status = 'published' WHERE id = ?", [season.id]);
  run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)', [actor.id, 'season_publish', JSON.stringify({ seasonId: season.id })]);
  for (const p of deacons()) {
    const dates = all(`SELECT d.date FROM assignments a JOIN ministry_events e ON e.id = a.event_id JOIN service_days d ON d.id = e.service_day_id
                       WHERE e.season_id = ? AND a.person_id = ? ORDER BY d.date`, [season.id, p.id]).map(r => cal.formatDay(r.date));
    await emailPerson(p, `Duty deacon schedule published: ${season.label}`, [
      `Hi ${p.name},`,
      dates.length ? `You're the duty deacon on: ${dates.join('; ')}.` : "You aren't scheduled as duty deacon this season.",
      "If you can't make a date, propose a swap with another deacon in MPC Officer Service.",
    ], { url: `${appUrl()}/duty/season/${season.id}`, label: 'See the full schedule' });
  }
  return { ok: true };
}

function archiveFinishedSeasons() {
  run("UPDATE seasons SET status = 'archived' WHERE ministry = 'duty' AND status = 'published' AND end_date < ?", [cal.todayIso()]);
}

// ─── Special services (Christmas Eve, Good Friday) ──
function createSpecial(actor, { title, date, opens, closes, times }) {
  const name = String(title || '').trim();
  const valid = (times || []).filter(t => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(String(t.time || '').trim()) && parseInt(t.needed, 10) > 0);
  if (!name) return { error: 'Give the service a name, for example "Christmas Eve 2027".' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { error: 'Choose the service date.' };
  if (!opens || !closes || opens > closes) return { error: 'Choose when sign-up opens and closes. It must open before it closes.' };
  if (closes >= date) return { error: 'Sign-up must close before the service date.' };
  if (!valid.length) return { error: 'Add at least one service time, like 4:00 PM, with how many deacons it needs.' };
  return transaction(() => {
    run('INSERT OR IGNORE INTO service_days (date) VALUES (?)', [date]);
    const day = get('SELECT * FROM service_days WHERE date = ?', [date]);
    if (!day.label) run('UPDATE service_days SET label = ? WHERE id = ?', [name, day.id]);
    run("INSERT INTO ministry_events (ministry, service_day_id, kind, title, signup_opens, signup_closes) VALUES ('duty', ?, 'special', ?, ?, ?)",
      [day.id, name, opens, closes]);
    const eventId = lastId();
    valid.forEach((t, i) => run("INSERT INTO positions (ministry, event_id, campus, service_time, area, needed, sort_order) VALUES ('duty', ?, 'McLean', ?, NULL, ?, ?)",
      [eventId, String(t.time).trim().toUpperCase().replace(/\s*(AM|PM)$/, ' $1'), parseInt(t.needed, 10), i + 1]));
    run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)', [actor.id, 'special_create', JSON.stringify({ eventId, name, date })]);
    return { ok: true, eventId };
  });
}

function listSpecials(fromIso) {
  return all(`SELECT e.*, d.date FROM ministry_events e JOIN service_days d ON d.id = e.service_day_id
              WHERE e.ministry = 'duty' AND e.kind = 'special' AND d.date >= ? ORDER BY d.date`, [fromIso]);
}

// ─── Reminders ──────────────────────────────────────
function sent(personId, ref, kind) {
  if (get('SELECT 1 FROM reminder_log WHERE person_id = ? AND ref = ? AND kind = ?', [personId, ref, kind])) return true;
  run('INSERT INTO reminder_log (person_id, ref, kind) VALUES (?,?,?)', [personId, ref, kind]);
  return false;
}

async function deadlineReminders(now) {
  if (now.hour < SEND_HOUR) return;
  for (const season of all("SELECT * FROM seasons WHERE ministry = 'duty' AND status = 'collecting' AND availability_deadline IS NOT NULL")) {
    const kind = now.date === cal.addDays(season.availability_deadline, -2) ? '48h' : now.date === cal.addDays(season.availability_deadline, -1) ? '24h' : null;
    if (!kind) continue;
    const submitted = new Set(all('SELECT person_id FROM season_submissions WHERE season_id = ?', [season.id]).map(r => r.person_id));
    for (const p of deacons().filter(d => !submitted.has(d.id))) {
      if (sent(p.id, `season:${season.id}`, kind)) continue;
      await emailPerson(p, `Reminder: duty deacon blackout dates due ${cal.formatDay(season.availability_deadline)}`, [
        `Hi ${p.name},`,
        `Please mark the Sundays you can't serve in ${season.label} by ${cal.formatLongDay(season.availability_deadline)}. If you don't, you'll be treated as available every Sunday.`,
      ], { url: `${appUrl()}/duty/season/${season.id}`, label: 'Mark my blackout dates' });
    }
  }
}

async function thursdayEmail(now) {
  if (now.weekday !== 'Thu' || now.hour < THURSDAY_HOUR || !settings().thursdayEmail) return;
  const sunday = cal.addDays(now.date, 3);
  const rows = all(`SELECT a.person_id, p.name, e.ministry, e.kind, pos.service_time, pos.campus, pos.area FROM assignments a
                    JOIN people p ON p.id = a.person_id JOIN ministry_events e ON e.id = a.event_id
                    JOIN service_days d ON d.id = e.service_day_id JOIN positions pos ON pos.id = a.position_id
                    WHERE d.date = ? AND e.kind = 'regular' AND ${engine.VISIBLE_SQL} ORDER BY e.ministry, pos.sort_order, p.name`, [sunday]);
  const dutyIds = [...new Set(rows.filter(r => r.ministry === 'duty').map(r => r.person_id))];
  if (!dutyIds.length) return;
  const line = m => rows.filter(r => r.ministry === m).map(r => m === 'duty' ? r.name : `${r.name} (${engine.describePosition(r)})`).join('; ');
  const paragraphs = [`Here is the team for ${cal.formatLongDay(sunday)}.`, `Duty deacons: ${line('duty')}`];
  if (rows.some(r => r.ministry === 'prayer')) paragraphs.push(`Prayer: ${line('prayer')}`);
  if (rows.some(r => r.ministry === 'communion')) paragraphs.push(`Communion: ${line('communion')}`);
  const staff = all(`SELECT DISTINCT p.* FROM people p JOIN role_grants r ON r.person_id = p.id WHERE r.role IN ('staff','super')`);
  const recipients = [...dutyIds.map(id => get('SELECT * FROM people WHERE id = ?', [id])), ...staff.filter(s => !dutyIds.includes(s.id))];
  for (const p of recipients) {
    if (sent(p.id, sunday, 'thursday')) continue;
    await emailPerson(p, `Duty deacons for ${cal.formatDay(sunday)}`, paragraphs, { url: `${appUrl()}/me`, label: 'Open MPC Officer Service' });
  }
}

async function specialReminders(now) {
  if (now.hour < SEND_HOUR) return;
  for (const event of listSpecials(now.date)) {
    const ref = `special:${event.id}`;
    const slots = engine.eventSlots(event);
    const open = slots.reduce((n, s) => n + s.open, 0);
    const serving = new Set(engine.eventAssignments(event.id).map(a => a.person_id));
    const link = { url: `${appUrl()}/duty/specials/${event.id}`, label: 'Sign up' };
    if (now.date === event.signup_opens) {
      for (const p of deacons()) {
        if (sent(p.id, ref, 'open')) continue;
        await emailPerson(p, `Sign-up open: ${event.title}`, [
          `Hi ${p.name},`,
          `Duty deacon sign-up for ${event.title} (${cal.formatLongDay(event.date)}) is open until ${cal.formatLongDay(event.signup_closes)}.`,
          `Times: ${slots.map(s => `${s.service_time} (${s.needed})`).join(', ')}.`,
        ], link);
      }
    }
    if (open && now.date === cal.addDays(event.signup_closes, -2)) {
      for (const p of deacons().filter(d => !serving.has(d.id))) {
        if (sent(p.id, ref, 'closing')) continue;
        await emailPerson(p, `${event.title} still needs ${open} duty deacon${open === 1 ? '' : 's'}`, [
          `Hi ${p.name},`,
          `Sign-up for ${event.title} closes ${cal.formatLongDay(event.signup_closes)} and ${open} ${open === 1 ? 'slot is' : 'slots are'} still open.`,
        ], link);
      }
    }
    if (now.date === cal.addDays(event.signup_closes, 1)) {
      const staff = all(`SELECT DISTINCT p.* FROM people p JOIN role_grants r ON r.person_id = p.id WHERE r.role IN ('staff','super') OR (r.role = 'coordinator' AND (r.ministry IS NULL OR r.ministry = 'duty'))`);
      for (const s of staff) {
        if (sent(s.id, ref, 'closed')) continue;
        await emailPerson(s, `${event.title} sign-up closed${open ? `: ${open} open` : ''}`, [
          `Sign-up for ${event.title} (${cal.formatLongDay(event.date)}) has closed.`,
          ...slots.map(sl => `${sl.service_time}: ${sl.assigned.map(a => a.person_name).join(', ') || 'nobody'}${sl.open ? ` (${sl.open} open)` : ''}`),
          ...(open ? ['Fill the open slots from the Sunday page.'] : []),
        ], { url: `${appUrl()}/admin/duty/${event.id}`, label: 'Open the schedule' });
      }
    }
  }
}

module.exports = {
  settings, setMeta, deacons, maxShifts, setMaxShifts, getSeason, listSeasons, seasonEvents, deadlinePassed,
  createSeason, submitAvailability, submissionStatus, planSeason, publishSeason, archiveFinishedSeasons,
  createSpecial, listSpecials, deadlineReminders, thursdayEmail, specialReminders,
};
