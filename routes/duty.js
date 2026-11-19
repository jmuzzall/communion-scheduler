// Deacon pages for Duty Deacon, mounted at /duty.
const express = require('express');
const router = express.Router();
const { all } = require('../db');
const { requirePerson } = require('../core/auth');
const { isEligible } = require('../core/eligibility');
const duty = require('../core/duty');
const engine = require('../core/engine');
const cal = require('../core/calendar');

router.use(requirePerson, (req, res, next) => {
  if (isEligible(req.person, 'duty')) return next();
  res.status(403).render('hub/forbidden', { page: null });
});

const back = (res, path, key, msg) => res.redirect(`/duty${path}?${key}=${encodeURIComponent(msg)}`);

router.get('/', (req, res) => {
  const today = cal.todayIso();
  const seasons = duty.listSeasons().filter(s => s.status !== 'archived' || s.end_date >= cal.addDays(today, -60)).map(s => ({
    ...s,
    range: `${cal.formatDay(s.start_date)} to ${cal.formatDay(s.end_date)}`,
    deadline: s.availability_deadline ? cal.formatDay(s.availability_deadline) : null,
    submitted: !!all('SELECT 1 FROM season_submissions WHERE season_id = ? AND person_id = ?', [s.id, req.person.id]).length,
    myDates: ['published', 'archived'].includes(s.status)
      ? all(`SELECT d.date FROM assignments a JOIN ministry_events e ON e.id = a.event_id JOIN service_days d ON d.id = e.service_day_id
             WHERE e.season_id = ? AND a.person_id = ? ORDER BY d.date`, [s.id, req.person.id]).map(r => cal.formatDay(r.date))
      : [],
  }));
  const specials = duty.listSpecials(cal.addDays(today, 1)).map(e => ({ ...e, display: cal.formatDay(e.date), open: engine.isOpen(e) }));
  res.render('hub/duty', { page: 'duty', seasons, specials, success: req.query.success || null, error: req.query.error || null });
});

router.get('/season/:id(\\d+)', (req, res) => {
  const season = duty.getSeason(req.params.id);
  if (!season) return back(res, '', 'error', 'That season was not found.');
  const today = cal.todayIso();
  const away = new Set(all('SELECT service_day_id FROM unavailability WHERE person_id = ?', [req.person.id]).map(r => r.service_day_id));
  const visible = ['published', 'archived'].includes(season.status);
  const days = duty.seasonEvents(season.id).map(e => ({
    ...e, display: cal.formatDay(e.date), away: away.has(e.service_day_id), past: e.date < today,
    team: visible ? engine.eventAssignments(e.id) : [],
  }));
  const daysLeft = season.availability_deadline
    ? Math.round((new Date(season.availability_deadline + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000) : null;
  res.render('hub/duty-season', {
    page: 'duty', season, days, visible, daysLeft,
    canEdit: season.status === 'collecting' && !duty.deadlinePassed(season),
    submitted: !!all('SELECT 1 FROM season_submissions WHERE season_id = ? AND person_id = ?', [season.id, req.person.id]).length,
    range: `${cal.formatLongDay(season.start_date)} to ${cal.formatLongDay(season.end_date)}`,
    deadline: season.availability_deadline ? cal.formatLongDay(season.availability_deadline) : null,
    success: req.query.success || null, error: req.query.error || null,
  });
});

router.post('/season/:id(\\d+)/availability', (req, res) => {
  const result = duty.submitAvailability(req.person, req.params.id, [].concat(req.body.away || []));
  const path = `/season/${req.params.id}`;
  if (result.error) return back(res, path, 'error', result.error);
  back(res, path, 'success', result.away ? `Saved. You're marked away on ${result.away} Sunday${result.away === 1 ? '' : 's'}; that applies to every ministry.` : "Saved. You're available every Sunday this season.");
});

module.exports = router;
