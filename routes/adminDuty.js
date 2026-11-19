// Coordinator pages for Duty Deacon seasons and special services, mounted at /admin/duty.
// Sunday-level editing reuses the shared schedule pages (/admin/duty/:eventId).
const express = require('express');
const ExcelJS = require('exceljs');
const router = express.Router();
const { all } = require('../db');
const { requireStaffFor } = require('../core/auth');
const duty = require('../core/duty');
const engine = require('../core/engine');
const cal = require('../core/calendar');

router.use(requireStaffFor('duty'));

const back = (res, path, key, msg) => res.redirect(`/admin/duty${path}?${key}=${encodeURIComponent(msg)}`);

router.get('/', (req, res) => {
  const today = cal.todayIso();
  const seasons = duty.listSeasons().map(s => {
    const events = duty.seasonEvents(s.id);
    const filled = events.reduce((n, e) => n + engine.eventAssignments(e.id).length, 0);
    return { ...s, sundays: events.length, filled, range: `${cal.formatDay(s.start_date)} to ${cal.formatDay(s.end_date)}` };
  });
  const specials = duty.listSpecials(cal.addDays(today, -60)).map(e => {
    const slots = engine.eventSlots(e);
    return { ...e, display: cal.formatDay(e.date), open: engine.isOpen(e), filled: slots.reduce((n, s) => n + s.filled, 0), needed: slots.reduce((n, s) => n + s.needed, 0),
      window: `${cal.formatDay(e.signup_opens)} to ${cal.formatDay(e.signup_closes)}` };
  });
  res.render('hub/admin-duty', { page: 'schedule', seasons, specials, settings: duty.settings(), success: req.query.success || null, error: req.query.error || null });
});

router.post('/seasons', (req, res) => {
  const result = duty.createSeason(req.person, { label: req.body.label, start: req.body.start, end: req.body.end, deadline: req.body.deadline });
  if (result.error) return back(res, '', 'error', result.error);
  back(res, `/seasons/${result.seasonId}`, 'success', `Season created with ${result.sundays} Sundays. Deacons can now mark their blackout dates.`);
});

router.post('/settings', (req, res) => {
  duty.setMeta('duty_lookback_seasons', Math.max(0, Math.min(10, parseInt(req.body.lookback, 10) || 0)));
  duty.setMeta('thursday_email', req.body.thursday_email === 'on' ? 'on' : 'off');
  back(res, '', 'success', 'Duty settings saved.');
});

router.get('/seasons/:id(\\d+)', (req, res) => {
  const season = duty.getSeason(req.params.id);
  if (!season) return back(res, '', 'error', 'That season was not found.');
  const people = duty.submissionStatus(season.id);
  const events = duty.seasonEvents(season.id).map(e => ({
    ...e, display: cal.formatDay(e.date), slots: engine.eventSlots(e),
    away: all('SELECT p.name FROM unavailability u JOIN people p ON p.id = u.person_id WHERE u.service_day_id = ? ORDER BY p.name', [e.service_day_id]).map(r => r.name),
  }));
  res.render('hub/admin-duty-season', {
    page: 'schedule', season, people, events,
    range: `${cal.formatLongDay(season.start_date)} to ${cal.formatLongDay(season.end_date)}`,
    deadline: season.availability_deadline ? cal.formatLongDay(season.availability_deadline) : null,
    deadlinePassed: duty.deadlinePassed(season),
    submittedCount: people.filter(p => p.submitted).length,
    success: req.query.success || null, error: req.query.error || null,
  });
});

router.post('/seasons/:id(\\d+)/max-shifts', (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    const m = /^max_(\d+)$/.exec(key);
    if (m) duty.setMaxShifts(Number(m[1]), value);
  }
  back(res, `/seasons/${req.params.id}`, 'success', 'Max shifts saved.');
});

router.post('/seasons/:id(\\d+)/plan', (req, res) => {
  const r = duty.planSeason(req.person, req.params.id);
  if (r.error) return back(res, `/seasons/${req.params.id}`, 'error', r.error);
  back(res, `/seasons/${req.params.id}`, 'success',
    `Draft generated: ${r.assignments} shifts over ${r.sundays} Sundays${r.unfilled ? `, ${r.unfilled} left unfilled` : ''}. Each deacon has ${r.min} to ${r.max} shifts${r.history ? ` (fairness counts ${r.history} past season${r.history === 1 ? '' : 's'})` : ''}. Review it, then publish.`);
});

router.post('/seasons/:id(\\d+)/publish', async (req, res) => {
  const r = await duty.publishSeason(req.person, req.params.id);
  if (r.error) return back(res, `/seasons/${req.params.id}`, 'error', r.error);
  back(res, `/seasons/${req.params.id}`, 'success', 'Season published. Every deacon was emailed their dates, and reminders will go out before each Sunday.');
});

router.get('/seasons/:id(\\d+)/export.xlsx', async (req, res) => {
  const season = duty.getSeason(req.params.id);
  if (!season) return back(res, '', 'error', 'That season was not found.');
  const wb = new ExcelJS.Workbook();
  const sched = wb.addWorksheet('Schedule');
  sched.columns = [{ header: 'Sunday', key: 'date', width: 14 }, { header: 'Duty deacons', key: 'names', width: 50 }];
  const blackouts = wb.addWorksheet('Blackout dates');
  blackouts.columns = [{ header: 'Sunday', key: 'date', width: 14 }, { header: 'Away', key: 'names', width: 60 }];
  for (const e of duty.seasonEvents(season.id)) {
    sched.addRow({ date: e.date, names: engine.eventAssignments(e.id).map(a => a.person_name).join(', ') || '(unfilled)' });
    blackouts.addRow({ date: e.date, names: all('SELECT p.name FROM unavailability u JOIN people p ON p.id = u.person_id WHERE u.service_day_id = ? ORDER BY p.name', [e.service_day_id]).map(r => r.name).join(', ') });
  }
  [sched, blackouts].forEach(ws => { ws.getRow(1).font = { bold: true }; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="duty-${season.start_date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

router.post('/specials', (req, res) => {
  const times = [0, 1, 2, 3].map(i => ({ time: req.body[`time_${i}`], needed: req.body[`needed_${i}`] }));
  const r = duty.createSpecial(req.person, { title: req.body.title, date: req.body.date, opens: req.body.opens, closes: req.body.closes, times });
  if (r.error) return back(res, '', 'error', r.error);
  back(res, `/${r.eventId}`, 'success', 'Special service created. Deacons are emailed when sign-up opens.');
});

module.exports = router;
