// Staff and coordinator schedule pages for a sign-up ministry, mounted at /admin/<ministry>.
const express = require('express');
const ExcelJS = require('exceljs');
const { get, all } = require('../db');
const { requireStaffFor } = require('../core/auth');
const engine = require('../core/engine');
const cal = require('../core/calendar');
const { isEligible, MINISTRY_NAMES } = require('../core/eligibility');

function adminScheduleRouter(ministry) {
  const router = express.Router();
  const name = MINISTRY_NAMES[ministry];
  const back = (res, path, key, msg) => res.redirect(`/admin/${ministry}${path}?${key}=${encodeURIComponent(msg)}`);

  router.use(requireStaffFor(ministry));

  router.get('/', (req, res) => {
    const today = cal.todayIso();
    const events = engine.upcomingEvents(ministry, cal.addDays(today, -62), cal.addMonths(today, 6)).map(e => {
      const slots = engine.eventSlots(e);
      return {
        ...e, display: cal.formatDay(e.date), past: e.date < today, open: engine.isOpen(e),
        filled: slots.reduce((n, s) => n + s.filled, 0), needed: slots.reduce((n, s) => n + s.needed, 0),
        autofillOn: cal.formatDay(cal.autofillDate(e.date)),
      };
    });
    res.render('hub/admin-events', { page: 'schedule', ministry, name, events, success: req.query.success || null, error: req.query.error || null });
  });

  router.get('/:eventId(\\d+)', (req, res) => {
    const event = engine.getEvent(req.params.eventId);
    if (!event || event.ministry !== ministry) return back(res, '', 'error', 'That Sunday was not found.');
    const people = all('SELECT * FROM people ORDER BY name').filter(p => isEligible(p, ministry));
    const slots = engine.eventSlots(event).map(slot => {
      const inSlot = new Set(slot.assigned.map(a => a.person_id));
      const options = people.filter(p => !inSlot.has(p.id)).map(p => {
        const clash = engine.dayAssignments(p.id, event.service_day_id).find(a => engine.positionsClash(a, slot));
        const away = engine.awayStatus(p.id, event.service_day_id, ministry);
        const notes = [];
        if (clash) notes.push(`serving ${MINISTRY_NAMES[clash.ministry]} ${engine.describePosition(clash)}`);
        if (away.blocked) notes.push('marked away');
        if (!p.active) notes.push('inactive');
        return { id: p.id, name: p.name, note: notes.join(', ') };
      });
      return { ...slot, label: engine.describePosition(slot), options };
    });
    const changes = all(`SELECT c.*, p.name AS actor FROM assignment_changes c LEFT JOIN people p ON p.id = c.changed_by
                         WHERE c.event_id = ? ORDER BY c.id DESC LIMIT 50`, [event.id])
      .map(c => ({ ...c, info: JSON.parse(c.details || '{}') }));
    const awayPeople = all(`SELECT p.name, u.reason FROM unavailability u JOIN people p ON p.id = u.person_id WHERE u.service_day_id = ? ORDER BY p.name`,
      [event.service_day_id]).filter(u => people.some(p => p.name === u.name));
    res.render('hub/admin-event', {
      page: 'schedule', ministry, name, event, slots, changes, awayPeople,
      display: cal.formatLongDay(event.date), open: engine.isOpen(event), autofillOn: cal.formatDay(cal.autofillDate(event.date)),
      success: req.query.success || null, error: req.query.error || null,
    });
  });

  router.post('/:eventId(\\d+)/assign', (req, res) => {
    const path = `/${req.params.eventId}`;
    const result = engine.staffAssign(req.person, req.params.eventId, req.body.position_id, req.body.person_id, req.body.allow_conflict === 'on');
    if (result.error) return back(res, path, 'error', result.error);
    back(res, path, 'success', result.warning ? `Assigned. ${result.warning}` : 'Assigned.');
  });

  router.post('/remove/:assignmentId(\\d+)', (req, res) => {
    const a = get('SELECT event_id FROM assignments WHERE id = ?', [req.params.assignmentId]);
    const result = engine.staffRemove(req.person, req.params.assignmentId);
    const path = a ? `/${a.event_id}` : '';
    if (result.error) return back(res, path, 'error', result.error);
    back(res, path, 'success', `${result.name} removed.`);
  });

  router.post('/:eventId(\\d+)/autofill', async (req, res) => {
    const path = `/${req.params.eventId}`;
    const event = engine.getEvent(req.params.eventId);
    if (!event || event.ministry !== ministry || event.date <= cal.todayIso()) return back(res, path, 'error', 'Only upcoming Sundays can be auto-filled.');
    const { added } = engine.autofill(event.id, req.person.id);
    if (req.body.notify === 'on') await engine.sendAssignmentNotices(event, added);
    back(res, path, 'success', `Auto-fill assigned ${added.length} ${added.length === 1 ? 'person' : 'people'}. Sign-up for this Sunday is now closed.`);
  });

  router.get('/:eventId(\\d+)/export.xlsx', async (req, res) => {
    const event = engine.getEvent(req.params.eventId);
    if (!event || event.ministry !== ministry) return back(res, '', 'error', 'That Sunday was not found.');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${name} ${event.date}`);
    ws.columns = [
      { header: 'Service time', key: 'time', width: 12 }, { header: 'Campus', key: 'campus', width: 10 },
      { header: 'Area', key: 'area', width: 28 }, { header: 'Name', key: 'name', width: 26 }, { header: 'Email', key: 'email', width: 32 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const slot of engine.eventSlots(event)) {
      for (const a of slot.assigned) ws.addRow({ time: slot.service_time, campus: slot.campus, area: slot.area, name: a.person_name, email: a.person_email });
      for (let i = 0; i < slot.open; i++) ws.addRow({ time: slot.service_time, campus: slot.campus, area: slot.area, name: '(open)' });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${ministry}-${event.date}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  });

  return router;
}

module.exports = { adminScheduleRouter };
