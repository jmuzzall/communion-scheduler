// Staff-defined reminders for communion and prayer: each rule sends N days before a Sunday, at a set
// Eastern-time hour, to everyone serving that ministry that Sunday. Subject and message use {{placeholders}}.
const { get, all, run, transaction, lastId } = require('../db');

const RULE_MINISTRIES = ['communion', 'prayer'];
const MAX_RULES = 10;
const MAX_DAYS = 60;
const HOURS = Array.from({ length: 16 }, (_, i) => i + 6); // 6 AM to 9 PM

const PLACEHOLDERS = [
  ['{{first_name}}', 'First name', 'Pat'],
  ['{{name}}', 'Full name', 'Pat Example'],
  ['{{ministry}}', 'Communion or Prayer', 'Communion'],
  ['{{date}}', 'The Sunday, written out', 'Sunday, November 29, 2026'],
  ['{{short_date}}', 'The Sunday, short', 'Sun, Nov 29'],
  ['{{positions}}', "Where and when they're serving", '8:45 AM · McLean Fellowship Hall'],
  ['{{link}}', 'Link to their My Sundays page', 'https://…/me'],
];

const DEFAULT_RULES = [
  {
    days_before: 7, send_hour: 9,
    subject: "Next Sunday: you're serving {{ministry}} on {{short_date}}",
    body: "Hi {{first_name}},\n\nA reminder that you're serving {{ministry}} on {{date}}:\n{{positions}}\n\nIf you can't make it, propose a swap in MPC Officer Service as soon as you can.",
  },
  {
    days_before: 1, send_hour: 9,
    subject: "Tomorrow: you're serving {{ministry}}",
    body: "Hi {{first_name}},\n\nA reminder that you're serving {{ministry}} tomorrow, {{date}}:\n{{positions}}\n\nIf something has come up, propose a swap in MPC Officer Service right away.",
  },
];

const WEEKDAY_BEFORE_SUNDAY = ['Sunday', 'Saturday', 'Friday', 'Thursday', 'Wednesday', 'Tuesday', 'Monday'];

function hourLabel(h) {
  return `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
}

// "7 days before (the Sunday before), 9:00 AM" style description of a rule's timing
function describeTiming(rule) {
  const n = rule.days_before;
  const when = n === 0 ? 'Sunday morning' : n === 1 ? 'Saturday, the day before' : `${n} days before (${WEEKDAY_BEFORE_SUNDAY[n % 7]}${n === 7 ? ', a week ahead' : ''})`;
  return `${when}, ${hourLabel(rule.send_hour)}`;
}

function listRules(ministry) {
  const rows = all('SELECT * FROM reminder_rules WHERE ministry = ? ORDER BY days_before DESC, send_hour, id', [ministry]);
  return rows.map(r => ({
    ...r,
    timing: describeTiming(r),
    sentCount: get('SELECT COUNT(*) AS c FROM reminder_log WHERE kind LIKE ?', [`rule:${r.id}:%`]).c,
  }));
}

function getRule(ministry, id) {
  return get('SELECT * FROM reminder_rules WHERE id = ? AND ministry = ?', [id, ministry]);
}

// Returns { error } or { values } from a submitted form.
function validate(body) {
  const days = Number.parseInt(body.days_before, 10);
  const hour = Number.parseInt(body.send_hour, 10);
  const subject = String(body.subject || '').trim();
  const text = String(body.body || '').replace(/\r\n/g, '\n').trim();
  if (!Number.isInteger(days) || days < 0 || days > MAX_DAYS) return { error: `Days before must be a whole number from 0 to ${MAX_DAYS}.` };
  if (!HOURS.includes(hour)) return { error: 'Choose a send time.' };
  if (!subject) return { error: 'Enter a subject.' };
  if (subject.length > 150) return { error: 'Keep the subject under 150 characters.' };
  if (!text) return { error: 'Enter the message.' };
  if (text.length > 5000) return { error: 'Keep the message under 5,000 characters.' };
  const unknown = [...`${subject} ${text}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map(m => `{{${m[1]}}}`)
    .filter(p => !PLACEHOLDERS.some(([key]) => key === p.toLowerCase()));
  if (unknown.length) return { error: `Unknown placeholder: ${[...new Set(unknown)].join(', ')}. Use the ones listed beside the form.` };
  return { values: { days_before: days, send_hour: hour, subject, body: text, enabled: body.enabled ? 1 : 0 } };
}

function createRule(ministry, values, actorId) {
  const count = get('SELECT COUNT(*) AS c FROM reminder_rules WHERE ministry = ?', [ministry]).c;
  if (count >= MAX_RULES) return { error: `A ministry can have up to ${MAX_RULES} reminders. Delete one first.` };
  // Read the new id inside the transaction: saving the file afterwards resets last_insert_rowid().
  const id = transaction(() => {
    run('INSERT INTO reminder_rules (ministry, days_before, send_hour, subject, body, enabled) VALUES (?,?,?,?,?,?)',
      [ministry, values.days_before, values.send_hour, values.subject, values.body, values.enabled]);
    return lastId();
  });
  audit(actorId, 'reminder_rule_add', { ministry, id, days_before: values.days_before, send_hour: values.send_hour });
  return { ok: true, id };
}

function updateRule(ministry, id, values, actorId) {
  if (!getRule(ministry, id)) return { error: 'That reminder was not found.' };
  run(`UPDATE reminder_rules SET days_before = ?, send_hour = ?, subject = ?, body = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    [values.days_before, values.send_hour, values.subject, values.body, values.enabled, id]);
  audit(actorId, 'reminder_rule_edit', { ministry, id, days_before: values.days_before, send_hour: values.send_hour, enabled: values.enabled });
  return { ok: true };
}

function setEnabled(ministry, id, enabled, actorId) {
  if (!getRule(ministry, id)) return { error: 'That reminder was not found.' };
  run(`UPDATE reminder_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`, [enabled ? 1 : 0, id]);
  audit(actorId, enabled ? 'reminder_rule_on' : 'reminder_rule_off', { ministry, id });
  return { ok: true };
}

function deleteRule(ministry, id, actorId) {
  if (!getRule(ministry, id)) return { error: 'That reminder was not found.' };
  run('DELETE FROM reminder_rules WHERE id = ?', [id]);
  audit(actorId, 'reminder_rule_delete', { ministry, id });
  return { ok: true };
}

function audit(actorId, action, details) {
  run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)', [actorId || null, action, JSON.stringify(details)]);
}

function fill(template, values) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => (key.toLowerCase() in values ? values[key.toLowerCase()] : whole));
}

// Builds the email for one person: { subject, paragraphs }. Paragraphs are split on blank lines;
// single line breaks inside a paragraph are kept.
function render(rule, { person, ministry, date, positions, link }) {
  const cal = require('./calendar');
  const { MINISTRY_NAMES } = require('./eligibility');
  const values = {
    first_name: String(person.name || '').trim().split(/\s+/)[0] || person.name,
    name: person.name,
    ministry: MINISTRY_NAMES[ministry],
    date: cal.formatLongDay(date),
    short_date: cal.formatDay(date),
    positions: positions.join('\n'),
    link,
  };
  return {
    subject: fill(rule.subject, values).replace(/\s+/g, ' ').trim(),
    paragraphs: fill(rule.body, values).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean),
  };
}

// Called every 15 minutes. A rule fires on its day once the send hour has passed; each person gets it
// once per Sunday. Changing a rule's timing counts as a new reminder.
async function runRules(now) {
  const cal = require('./calendar');
  const engine = require('./engine');
  const { emailPerson, appUrl } = require('./notify');
  const link = `${appUrl()}/me`;
  for (const rule of all(`SELECT * FROM reminder_rules WHERE enabled = 1 AND ministry IN (${RULE_MINISTRIES.map(() => '?').join(',')})`, RULE_MINISTRIES)) {
    if (now.hour < rule.send_hour) continue;
    const date = cal.addDays(now.date, rule.days_before);
    const rows = all(`SELECT a.person_id, pos.service_time, pos.campus, pos.area FROM assignments a
                      JOIN ministry_events e ON e.id = a.event_id JOIN service_days d ON d.id = e.service_day_id
                      JOIN positions pos ON pos.id = a.position_id
                      WHERE d.date = ? AND e.ministry = ? AND ${engine.VISIBLE_SQL} ORDER BY pos.sort_order`, [date, rule.ministry]);
    const byPerson = new Map();
    for (const r of rows) {
      if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, []);
      byPerson.get(r.person_id).push(engine.describePosition(r));
    }
    const ref = `${date}:${rule.ministry}`, kind = `rule:${rule.id}:${rule.days_before}`;
    for (const [personId, positions] of byPerson) {
      if (get('SELECT 1 AS x FROM reminder_log WHERE person_id = ? AND ref = ? AND kind = ?', [personId, ref, kind])) continue;
      const person = get('SELECT * FROM people WHERE id = ?', [personId]);
      const { subject, paragraphs } = render(rule, { person, ministry: rule.ministry, date, positions, link });
      await emailPerson(person, subject, paragraphs, { url: link, label: 'View My Sundays' });
      run('INSERT OR IGNORE INTO reminder_log (person_id, ref, kind) VALUES (?,?,?)', [personId, ref, kind]);
    }
  }
}

// Sends the rule to the staff member, filled in with sample details, so they can see it in their inbox.
async function sendTest(rule, person) {
  const cal = require('./calendar');
  const { emailAddress, appUrl } = require('./notify');
  const today = cal.todayIso();
  let sunday = cal.addDays(today, 1);
  while (new Date(sunday + 'T12:00:00').getDay() !== 0) sunday = cal.addDays(sunday, 1);
  const sample = rule.ministry === 'prayer' ? '11:15 AM · McLean Sanctuary' : '8:45 AM · McLean Fellowship Hall';
  const link = `${appUrl()}/me`;
  const { subject, paragraphs } = render(rule, { person, ministry: rule.ministry, date: sunday, positions: [sample], link });
  await emailAddress(person.email, `[Test] ${subject}`, paragraphs, { url: link, label: 'View My Sundays' });
}

// Text preview with sample details, for the edit page.
function preview(rule, person) {
  const cal = require('./calendar');
  let sunday = cal.addDays(cal.todayIso(), 1);
  while (new Date(sunday + 'T12:00:00').getDay() !== 0) sunday = cal.addDays(sunday, 1);
  const sample = rule.ministry === 'prayer' ? '11:15 AM · McLean Sanctuary' : '8:45 AM · McLean Fellowship Hall';
  return render(rule, { person, ministry: rule.ministry, date: sunday, positions: [sample], link: '(link to My Sundays)' });
}

module.exports = {
  RULE_MINISTRIES, MAX_RULES, MAX_DAYS, HOURS, PLACEHOLDERS, DEFAULT_RULES,
  hourLabel, describeTiming, listRules, getRule, validate, createRule, updateRule, setEnabled, deleteRule,
  render, runRules, sendTest, preview,
};
