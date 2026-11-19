// Officer sign-up pages. Mounted at /communion and /prayer for regular Sundays, and at
// /duty/specials for special services (Christmas Eve, Good Friday).
const express = require('express');
const { get } = require('../db');
const { requirePerson } = require('../core/auth');
const engine = require('../core/engine');
const cal = require('../core/calendar');
const { isEligible, MINISTRY_NAMES } = require('../core/eligibility');

function signupRouter(ministry, { base = `/${ministry}`, special = false } = {}) {
  const router = express.Router();
  const name = special ? 'Special services' : MINISTRY_NAMES[ministry];
  const back = (res, path, key, msg) => res.redirect(`${base}${path}?${key}=${encodeURIComponent(msg)}`);
  const wanted = e => (special ? e.kind === 'special' : e.kind === 'regular');

  router.use(requirePerson, (req, res, next) => {
    if (isEligible(req.person, ministry)) return next();
    res.status(403).render('hub/forbidden', { page: null });
  });

  router.get('/', (req, res) => {
    const today = cal.todayIso();
    const until = special ? cal.addMonths(today, 12) : cal.addMonths(today, engine.SIGNUP_WINDOW_MONTHS);
    const events = engine.upcomingEvents(ministry, cal.addDays(today, 1), until).filter(wanted).map(e => {
      const slots = engine.eventSlots(e);
      const mine = engine.eventAssignments(e.id).filter(a => a.person_id === req.person.id)
        .map(a => engine.describePosition(slots.find(s => s.id === a.position_id) || {}));
      return {
        ...e, display: cal.formatDay(e.date), open: engine.isOpen(e), mine,
        covers: [...new Set(slots.filter(s => s.covered).map(s => s.covered))],
        allCovered: slots.length > 0 && slots.every(s => s.covered),
        filled: slots.reduce((n, s) => n + s.filled, 0), needed: slots.filter(s => !s.covered).reduce((n, s) => n + s.needed, 0),
        away: engine.awayStatus(req.person.id, e.service_day_id, ministry),
        window: special && e.signup_opens ? `Sign-up ${cal.formatDay(e.signup_opens)} to ${cal.formatDay(e.signup_closes)}` : null,
      };
    });
    res.render('hub/signup-list', { page: ministry, ministry, name, base, special, events, success: req.query.success || null, error: req.query.error || null });
  });

  router.get('/:eventId(\\d+)', (req, res) => {
    const event = engine.getEvent(req.params.eventId);
    if (!event || event.ministry !== ministry || !wanted(event)) return back(res, '', 'error', 'That service was not found.');
    const preferred = req.person.preferred_campus || req.person.home_campus;
    const mine = engine.dayAssignments(req.person.id, event.service_day_id);
    const slots = engine.eventSlots(event).map(slot => {
      const myAssignment = slot.assigned.find(a => a.person_id === req.person.id);
      const sameMinistry = !myAssignment && mine.find(a => a.ministry === ministry && engine.positionsClash(a, slot));
      const otherMinistry = !myAssignment && mine.find(a => a.ministry !== ministry && engine.positionsClash(a, slot));
      return {
        ...slot, label: engine.describePosition(slot), myAssignment,
        blockedBy: sameMinistry ? engine.describePosition(sameMinistry) : null,
        overlapWith: otherMinistry ? `${MINISTRY_NAMES[otherMinistry.ministry]} at ${engine.describePosition(otherMinistry)}` : null,
      };
    }).sort((a, b) => ((a.campus === preferred ? 0 : 1) - (b.campus === preferred ? 0 : 1)) || (a.sort_order - b.sort_order));

    res.render('hub/signup-event', {
      page: ministry, ministry, name: special ? event.title : name, base, special, event, slots, preferred,
      display: cal.formatLongDay(event.date), open: engine.isOpen(event),
      closesOn: special && event.signup_closes ? cal.formatDay(event.signup_closes) : null,
      away: engine.awayStatus(req.person.id, event.service_day_id, ministry),
      confirm: req.query.confirm ? { positionId: Number(req.query.confirm), warning: req.query.warning } : null,
      success: req.query.success || null, error: req.query.error || null,
    });
  });

  router.post('/:eventId(\\d+)/claim', (req, res) => {
    const path = `/${req.params.eventId}`;
    const result = engine.claim(req.person, req.params.eventId, req.body.position_id, { confirmOverlap: req.body.confirm_overlap === '1' });
    if (result.warning) {
      return res.redirect(`${base}${path}?confirm=${encodeURIComponent(req.body.position_id)}&warning=${encodeURIComponent(result.warning)}`);
    }
    if (result.error) return back(res, path, 'error', result.error);
    back(res, path, 'success', "You're signed up.");
  });

  router.post('/:eventId(\\d+)/opt-in', (req, res) => {
    engine.optIn(req.person, req.params.eventId);
    back(res, `/${req.params.eventId}`, 'success', `You can now sign up for this service. You're still marked away for other ministries.`);
  });

  router.post('/withdraw/:assignmentId(\\d+)', (req, res) => {
    const a = get('SELECT event_id FROM assignments WHERE id = ?', [req.params.assignmentId]);
    const result = engine.withdraw(req.person, req.params.assignmentId);
    const path = a ? `/${a.event_id}` : '';
    if (result.error) return back(res, path, 'error', result.error);
    back(res, path, 'success', 'You withdrew from that slot.');
  });

  return router;
}

module.exports = { signupRouter };
