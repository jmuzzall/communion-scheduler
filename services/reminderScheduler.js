const { get, all, run } = require('../db');
const { sendNotification } = require('./mailer');
const { autoAssign } = require('./scheduler');

async function checkAndSendReminders() {
  const today = new Date().toISOString().split('T')[0];

  const signupDates = all(
    "SELECT * FROM communion_dates WHERE signup_opens = ? AND status = 'upcoming'",
    [today]
  );
  for (const cd of signupDates) {
    run('UPDATE communion_dates SET status = ? WHERE id = ?', ['signup_open', cd.id]);
    await sendSignupNotices(cd);
  }

  const reminderDates = all(
    "SELECT * FROM communion_dates WHERE reminder_date = ? AND status = 'signup_open'",
    [today]
  );
  for (const cd of reminderDates) {
    await sendReminders(cd);
  }

  const assignmentDates = all(
    "SELECT * FROM communion_dates WHERE assignment_date = ? AND status = 'signup_open'",
    [today]
  );
  for (const cd of assignmentDates) {
    const newAssignments = autoAssign(cd.id);
    await sendAssignmentNotices(cd, newAssignments);
  }

  const completionDates = all(
    "SELECT * FROM communion_dates WHERE date <= ? AND status = 'assigned'",
    [today]
  );
  for (const cd of completionDates) {
    run('UPDATE communion_dates SET status = ? WHERE id = ?', ['completed', cd.id]);
  }
}

async function sendSignupNotices(cd) {
  const members = all('SELECT * FROM members');
  const slots = all('SELECT * FROM slot_config ORDER BY sort_order');
  const slotSummary = slots.map(s =>
    `<li>${s.service_time} — ${s.location}${s.area ? ' (' + s.area + ')' : ''}: ${s.servers_needed} servers</li>`
  ).join('');

  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  for (const m of members) {
    await sendNotification(m, 'signup_notice', {
      name: m.name,
      communion_date: formatDate(cd.date),
      signup_link: `${appUrl}/member/signup/${cd.id}`,
      slot_summary: slotSummary,
    }, cd.id);
  }
}

async function sendReminders(cd) {
  const assigned = all('SELECT member_id FROM assignments WHERE communion_date_id = ?', [cd.id]).map(r => r.member_id);
  const excluded = all("SELECT member_id FROM exclusions WHERE communion_date_id = ? AND exclusion_type = 'full_day'", [cd.id]).map(r => r.member_id);
  const skip = new Set([...assigned, ...excluded]);

  const members = all('SELECT * FROM members').filter(m => !skip.has(m.id));
  const totalSlots = all('SELECT SUM(servers_needed) as total FROM slot_config');
  const filledSlots = all('SELECT COUNT(*) as c FROM assignments WHERE communion_date_id = ?', [cd.id]);
  const openSlots = (totalSlots[0]?.total || 30) - (filledSlots[0]?.c || 0);

  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  for (const m of members) {
    await sendNotification(m, 'signup_reminder', {
      name: m.name,
      communion_date: formatDate(cd.date),
      signup_link: `${appUrl}/member/signup/${cd.id}`,
      open_slots: String(openSlots),
      deadline: formatDate(cd.assignment_date),
    }, cd.id);
  }
}

async function sendAssignmentNotices(cd, newAssignments) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const allAssignments = all(
    `SELECT a.*, m.*, sc.service_time, sc.location, sc.area
     FROM assignments a
     JOIN members m ON a.member_id = m.id
     JOIN slot_config sc ON a.slot_config_id = sc.id
     WHERE a.communion_date_id = ?`,
    [cd.id]
  );

  for (const a of allAssignments) {
    await sendNotification(a, 'assignment_notice', {
      name: a.name,
      communion_date: formatDate(cd.date),
      service_time: a.service_time,
      location: a.location,
      area: a.area ? ' — ' + a.area : '',
      portal_link: `${appUrl}/member/portal`,
    }, cd.id);
  }
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

let intervalId;
function startReminderScheduler() {
  console.log('[Reminders] Scheduler started — checking every 30 minutes');
  checkAndSendReminders().catch(e => console.error('[Reminders] Error:', e));
  intervalId = setInterval(() => {
    checkAndSendReminders().catch(e => console.error('[Reminders] Error:', e));
  }, 30 * 60 * 1000);
}

function stopReminderScheduler() {
  if (intervalId) clearInterval(intervalId);
}

module.exports = { startReminderScheduler, stopReminderScheduler, checkAndSendReminders, sendAssignmentNotices, formatDate };
