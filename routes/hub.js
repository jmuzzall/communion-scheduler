const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { get, all, run } = require('../db');
const { requirePerson, hasSuperAdmin } = require('../core/auth');
const staging = require('../core/staging');
const { sendEmail } = require('../services/mailer');
const { eligibleMinistries, MINISTRY_NAMES } = require('../core/eligibility');
const { upcomingServiceDays, formatDay, todayIso, addMonths } = require('../core/calendar');
const engine = require('../core/engine');
const { emailStaff, appUrl: siteUrl } = require('../core/notify');
const { CAMPUSES } = require('../core/schema');

const MIN_PASSWORD = 8;
const LINK_HOURS = 24;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appUrl(req) {
  return process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
}

function signIn(req, person) {
  req.session.personId = person.id;
}

function findPerson(email) {
  const p = get('SELECT * FROM people WHERE email = ?', [String(email || '').trim().toLowerCase()]);
  return p && staging.isAllowed(p.email) ? p : null;
}

function notOnRosterMessage() {
  return staging.isStaging()
    ? 'This test copy is open to testers only.'
    : "That email isn't on the officer roster. Use the address the church has on file, or ask an administrator.";
}

function passwordProblem(password, confirm) {
  if (!password || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (confirm !== undefined && password !== confirm) return "The two passwords don't match.";
  return null;
}

router.get('/', (req, res) => {
  if (!hasSuperAdmin()) return res.redirect('/setup');
  res.redirect(req.person ? '/me' : '/signin');
});

// ─── First-time setup ───────────────────────────────
// When SETUP_TOKEN is set, the setup page only works from a link carrying that token.
function setupTokenOk(token) {
  const expected = process.env.SETUP_TOKEN;
  if (!expected) return true;
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/setup', (req, res) => {
  if (hasSuperAdmin()) return res.redirect('/signin');
  if (!setupTokenOk(req.query.token)) return res.status(403).send('Setup needs the setup link from whoever deployed this app.');
  res.render('hub/setup', { error: null, values: {}, token: req.query.token || '' });
});

router.post('/setup', (req, res) => {
  if (hasSuperAdmin()) return res.redirect('/signin');
  if (!setupTokenOk(req.body.token)) return res.status(403).send('Setup needs the setup link from whoever deployed this app.');
  const { name, email, password, confirm, token } = req.body;
  const values = { name, email };
  const cleanEmail = String(email || '').trim().toLowerCase();
  const fail = error => res.render('hub/setup', { error, values, token });
  if (!String(name || '').trim()) return fail('Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return fail('Enter a valid email address.');
  if (!staging.isAllowed(cleanEmail)) return fail('On the test copy, the first administrator must be on the tester list.');
  const problem = passwordProblem(password, confirm);
  if (problem) return fail(problem);

  let person = get('SELECT * FROM people WHERE email = ?', [cleanEmail]);
  const hash = bcrypt.hashSync(password, 10);
  if (person) {
    run('UPDATE people SET password_hash = ? WHERE id = ?', [hash, person.id]);
  } else {
    run('INSERT INTO people (name, email, password_hash) VALUES (?,?,?)', [name.trim(), cleanEmail, hash]);
    person = get('SELECT * FROM people WHERE email = ?', [cleanEmail]);
  }
  run("INSERT INTO role_grants (person_id, role) VALUES (?, 'super')", [person.id]);
  run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)', [person.id, 'setup_super_admin', cleanEmail]);
  signIn(req, person);
  res.redirect('/admin/people?success=' + encodeURIComponent('You are set up as the first administrator. Import the officer roster to get started.'));
});

// ─── Sign in ───────────────────────────────────────
router.get('/signin', (req, res) => {
  if (!hasSuperAdmin()) return res.redirect('/setup');
  if (req.person) return res.redirect('/me');
  res.render('hub/signin', { step: 'email', email: '', name: '', error: null });
});

// People without a password must prove they own the address with an emailed link first;
// they can set a password on their profile afterwards.
router.post('/signin', (req, res) => {
  const { step, email, password } = req.body;
  const person = findPerson(email);
  const render = (s, error) => res.render('hub/signin', { step: s, email: person ? person.email : email, name: person ? person.name : '', error });
  if (!person) return res.render('hub/signin', { step: 'email', email, name: '', error: notOnRosterMessage() });

  if (step === 'email') return render(person.password_hash ? 'password' : 'first', null);

  if (step === 'password') {
    if (!person.password_hash || !bcrypt.compareSync(password || '', person.password_hash)) {
      return render(person.password_hash ? 'password' : 'first', person.password_hash ? 'That password is incorrect. Try again, or email yourself a sign-in link.' : null);
    }
    signIn(req, person);
    return res.redirect('/me');
  }

  render('email', null);
});

router.post('/signin/link', async (req, res) => {
  const person = findPerson(req.body.email);
  if (!person) return res.render('hub/signin', { step: 'email', email: req.body.email, name: '', error: notOnRosterMessage() });
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + LINK_HOURS * 3600 * 1000).toISOString();
  run('INSERT INTO person_login_tokens (person_id, token, expires_at) VALUES (?,?,?)', [person.id, token, expires]);
  const link = `${appUrl(req)}/signin/link/${token}`;
  await sendEmail(person.email, 'Your MPC Officer Service sign-in link',
    `<p>Hi ${escapeHtml(person.name)},</p><p>Use this link to sign in to MPC Officer Service. It works once and expires in ${LINK_HOURS} hours.</p><p><a href="${link}">Sign in</a></p>`,
    `Hi ${person.name}, sign in to MPC Officer Service: ${link} (works once, expires in ${LINK_HOURS} hours)`);
  res.render('hub/signin', { step: 'link_sent', email: person.email, name: person.name, error: null });
});

router.get('/signin/link/:token', (req, res) => {
  const row = get(`SELECT * FROM person_login_tokens WHERE token = ? AND used = 0`, [req.params.token]);
  if (!row || new Date(row.expires_at) < new Date()) {
    return res.render('hub/signin', { step: 'email', email: '', name: '', error: 'That sign-in link has expired or was already used. Enter your email to get a new one.' });
  }
  const person = get('SELECT * FROM people WHERE id = ?', [row.person_id]);
  if (!person || !staging.isAllowed(person.email)) {
    return res.render('hub/signin', { step: 'email', email: '', name: '', error: notOnRosterMessage() });
  }
  run('UPDATE person_login_tokens SET used = 1 WHERE id = ?', [row.id]);
  signIn(req, person);
  res.redirect('/me');
});

router.get('/signout', (req, res) => {
  req.session.destroy(() => res.redirect('/signin'));
});

// ─── My Sundays ────────────────────────────────────
router.get('/me', requirePerson, (req, res) => {
  const today = todayIso();
  const days = upcomingServiceDays(today, 13);
  const until = days.length ? days[days.length - 1].date : today;
  const away = new Map(all('SELECT * FROM unavailability WHERE person_id = ?', [req.person.id]).map(u => [u.service_day_id, u]));
  const duties = engine.upcomingFor(req.person.id, today, until);
  const pendingSwaps = all("SELECT COUNT(*) AS c FROM swaps WHERE target_id = ? AND status = 'pending'", [req.person.id])[0].c;
  const openSignups = ['communion', 'prayer'].filter(m => eligibleMinistries(req.person).includes(m)).map(m => {
    const events = engine.upcomingEvents(m, today, addMonths(today, engine.SIGNUP_WINDOW_MONTHS)).filter(engine.isOpen)
      .filter(e => !engine.eventAssignments(e.id).some(a => a.person_id === req.person.id))
      .filter(e => engine.eventSlots(e).some(s => s.open > 0));
    return { ministry: m, name: MINISTRY_NAMES[m], count: events.length };
  });
  const isDeacon = eligibleMinistries(req.person).includes('duty');
  const dutyPrompts = isDeacon ? all("SELECT * FROM seasons WHERE ministry = 'duty' AND status = 'collecting' AND (availability_deadline IS NULL OR availability_deadline >= ?) ORDER BY start_date", [today])
    .filter(s => !get('SELECT 1 FROM season_submissions WHERE season_id = ? AND person_id = ?', [s.id, req.person.id]))
    .map(s => ({ id: s.id, label: s.label, deadline: s.availability_deadline ? formatDay(s.availability_deadline) : null })) : [];
  const openSpecials = isDeacon ? engine.upcomingEvents('duty', today, addMonths(today, 12)).filter(e => e.kind === 'special' && engine.isOpen(e))
    .filter(e => !engine.eventAssignments(e.id).some(a => a.person_id === req.person.id))
    .map(e => ({ id: e.id, title: e.title })) : [];
  res.render('hub/me', {
    dutyPrompts, openSpecials,
    page: 'me',
    days: days.map(d => ({
      ...d, display: formatDay(d.date), away: away.get(d.id) || null,
      duties: duties.filter(a => a.date === d.date).map(a => ({
        id: a.id, ministry: MINISTRY_NAMES[a.ministry], ministryKey: a.ministry, label: engine.describePosition(a),
      })),
    })),
    ministries: eligibleMinistries(req.person).map(k => MINISTRY_NAMES[k]),
    openSignups, pendingSwaps,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

router.post('/me/away', requirePerson, async (req, res) => {
  const day = get('SELECT * FROM service_days WHERE id = ?', [req.body.service_day_id]);
  if (!day || day.date < todayIso()) return res.redirect('/me?error=' + encodeURIComponent('Choose an upcoming Sunday.'));
  const reason = String(req.body.reason || '').trim().slice(0, 200) || null;
  run('DELETE FROM unavailability WHERE person_id = ? AND service_day_id = ?', [req.person.id, day.id]);
  run("INSERT INTO unavailability (person_id, service_day_id, reason, source) VALUES (?,?,?,'self')", [req.person.id, day.id, reason]);

  // Already scheduled that day: tell staff so they can find a replacement.
  const scheduled = engine.upcomingFor(req.person.id, day.date, day.date);
  if (scheduled.length) {
    await emailStaff(`${req.person.name} marked ${formatDay(day.date)} away but is scheduled`, [
      `${req.person.name} marked ${formatDay(day.date)} away${reason ? ` (${reason})` : ''} and is still scheduled for:`,
      ...scheduled.map(a => `${MINISTRY_NAMES[a.ministry]}: ${engine.describePosition(a)}`),
      'They can propose a swap, or you can reassign the slot from the schedule.',
    ], { url: `${siteUrl()}/admin/board?month=${day.date.slice(0, 7)}`, label: 'Open the month board' });
    return res.redirect('/me?success=' + encodeURIComponent(`Marked away on ${formatDay(day.date)}. You're still scheduled that day, so staff were told; propose a swap if you can.`));
  }
  res.redirect('/me?success=' + encodeURIComponent(`Marked away on ${formatDay(day.date)}. This applies to every ministry.`));
});

router.post('/me/away/:dayId/remove', requirePerson, (req, res) => {
  run('DELETE FROM unavailability WHERE person_id = ? AND service_day_id = ?', [req.person.id, req.params.dayId]);
  run('DELETE FROM availability_exceptions WHERE person_id = ? AND service_day_id = ?', [req.person.id, req.params.dayId]);
  res.redirect('/me?success=' + encodeURIComponent('You are available again that Sunday.'));
});

// ─── Profile ───────────────────────────────────────
router.get('/me/profile', requirePerson, (req, res) => {
  res.render('hub/profile', { page: 'profile', campuses: CAMPUSES, success: req.query.success || null, error: null });
});

router.post('/me/profile', requirePerson, (req, res) => {
  const { preferred_campus, phone, notify_email, notify_sms, new_password, confirm } = req.body;
  if (!CAMPUSES.includes(preferred_campus)) {
    return res.render('hub/profile', { page: 'profile', campuses: CAMPUSES, success: null, error: 'Choose McLean or Herndon.' });
  }
  if (new_password) {
    const problem = passwordProblem(new_password, confirm);
    if (problem) return res.render('hub/profile', { page: 'profile', campuses: CAMPUSES, success: null, error: problem });
    run('UPDATE people SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(new_password, 10), req.person.id]);
  }
  run(`UPDATE people SET preferred_campus = ?, phone = ?, notify_email = ?, notify_sms = ?, updated_at = datetime('now') WHERE id = ?`,
    [preferred_campus, String(phone || '').trim() || null, notify_email ? 1 : 0, notify_sms ? 1 : 0, req.person.id]);
  res.redirect('/me/profile?success=' + encodeURIComponent('Profile saved.'));
});

module.exports = router;
