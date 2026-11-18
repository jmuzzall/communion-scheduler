// Swaps for every ministry, mounted at /swaps.
const express = require('express');
const router = express.Router();
const { requirePerson } = require('../core/auth');
const engine = require('../core/engine');
const cal = require('../core/calendar');
const { MINISTRY_NAMES } = require('../core/eligibility');

router.use(requirePerson);

const back = (res, key, msg) => res.redirect(`/swaps?${key}=${encodeURIComponent(msg)}`);

router.get('/', (req, res) => {
  const swaps = engine.swapsFor(req.person.id);
  res.render('hub/swaps', {
    page: 'swaps',
    incoming: swaps.filter(s => s.status === 'pending' && s.target_id === req.person.id),
    outgoing: swaps.filter(s => s.status === 'pending' && s.requester_id === req.person.id),
    past: swaps.filter(s => s.status !== 'pending').slice(0, 20),
    success: req.query.success || null, error: req.query.error || null,
  });
});

router.get('/new/:assignmentId(\\d+)', (req, res) => {
  const data = engine.swapCandidates(req.person, req.params.assignmentId);
  if (!data) return back(res, 'error', 'That assignment was not found.');
  res.render('hub/swap-new', {
    page: 'swaps', mine: data.mine, minePosition: engine.describePosition(data.mine), mineDay: cal.formatLongDay(data.mine.date),
    others: data.others.map(o => ({ ...o, display: cal.formatDay(o.date) })), ministryName: MINISTRY_NAMES[data.mine.ministry],
  });
});

router.post('/propose', async (req, res) => {
  const result = await engine.proposeSwap(req.person, req.body.my_assignment_id, req.body.their_assignment_id, req.body.message);
  if (result.error) return back(res, 'error', result.error);
  back(res, 'success', `Swap request sent to ${result.name}.`);
});

router.post('/:id(\\d+)/accept', async (req, res) => {
  const result = await engine.acceptSwap(req.person, req.params.id);
  if (result.error) return back(res, 'error', result.error);
  back(res, 'success', 'Swap accepted. Your Sundays are updated.');
});

router.post('/:id(\\d+)/decline', async (req, res) => {
  const result = await engine.declineSwap(req.person, req.params.id);
  if (result.error) return back(res, 'error', result.error);
  back(res, 'success', 'Swap declined.');
});

router.post('/:id(\\d+)/cancel', (req, res) => {
  engine.cancelSwap(req.person, req.params.id);
  back(res, 'success', 'Swap request cancelled.');
});

module.exports = router;
