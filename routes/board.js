// Staff month board across every ministry, mounted at /admin/board.
const express = require('express');
const ExcelJS = require('exceljs');
const router = express.Router();
const { get, all } = require('../db');
const { canManage } = require('../core/auth');
const engine = require('../core/engine');
const cal = require('../core/calendar');
const { MINISTRY_NAMES } = require('../core/eligibility');

router.use((req, res, next) => {
  if (!req.person) return res.redirect('/signin');
  if (['communion', 'prayer', 'duty'].some(m => canManage(req.roles, m))) return next();
  res.status(403).render('hub/forbidden', { page: null });
});

function monthBounds(month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : cal.todayIso().slice(0, 7);
  const start = `${m}-01`;
  const end = cal.addDays(cal.addMonths(start, 1), -1);
  return { month: m, start, end, prev: cal.addMonths(start, -1).slice(0, 7), next: cal.addMonths(start, 1).slice(0, 7) };
}

function summarize(slots) {
  const covered = slots.filter(s => s.covered);
  const live = slots.filter(s => !s.covered);
  return {
    filled: live.reduce((n, s) => n + s.filled, 0),
    needed: live.reduce((n, s) => n + s.needed, 0),
    open: live.reduce((n, s) => n + s.open, 0),
    covered: covered.length && !live.length ? covered[0].covered : null,
  };
}

// Builds the board: columns and one row per service day with events.
function buildBoard(start, end) {
  const prayerPositions = all("SELECT * FROM positions WHERE ministry = 'prayer' AND event_id IS NULL AND active = 1 ORDER BY sort_order");
  const columns = [
    { key: 'duty', ministry: 'duty', label: 'Duty Deacons', sub: 'McLean' },
    ...prayerPositions.map(p => ({ key: `prayer-${p.id}`, ministry: 'prayer', positionId: p.id, label: 'Prayer', sub: `${p.campus === 'Herndon' ? 'Herndon ' : ''}${p.service_time}${p.campus === 'McLean' ? ' ' + p.area : ''}` })),
    { key: 'communion-McLean', ministry: 'communion', campus: 'McLean', label: 'Communion', sub: 'McLean' },
    { key: 'communion-Herndon', ministry: 'communion', campus: 'Herndon', label: 'Communion', sub: 'Herndon' },
  ];
  const days = all(`SELECT DISTINCT d.* FROM service_days d JOIN ministry_events e ON e.service_day_id = d.id
                    WHERE d.date >= ? AND d.date <= ? ORDER BY d.date`, [start, end]);
  const rows = days.map(day => {
    const events = all('SELECT e.*, ? AS date FROM ministry_events e WHERE e.service_day_id = ?', [day.date, day.id]);
    const cells = {};
    for (const col of columns) {
      const evs = events.filter(e => e.ministry === col.ministry);
      if (!evs.length) { cells[col.key] = null; continue; }
      const groups = [];
      let draft = false;
      for (const e of evs) {
        const season = e.season_id ? get('SELECT status FROM seasons WHERE id = ?', [e.season_id]) : null;
        if (season && !['published', 'archived'].includes(season.status)) draft = true;
        let slots = engine.eventSlots(e);
        if (col.positionId) slots = slots.filter(s => s.id === col.positionId);
        if (col.campus) slots = slots.filter(s => s.campus === col.campus);
        if (!slots.length) continue;
        for (const s of slots) {
          const label = e.kind === 'special' ? `${e.title} ${s.service_time}` : col.ministry === 'communion' ? `${s.service_time} ${s.area}` : null;
          groups.push({ label, eventId: e.id, slot: s });
        }
      }
      if (!groups.length) { cells[col.key] = null; continue; }
      cells[col.key] = { ...summarize(groups.map(g => g.slot)), groups, draft, eventId: groups[0].eventId };
    }
    return { ...day, display: new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), cells };
  });
  return { columns, rows };
}

router.get('/', (req, res) => {
  if (['summary', 'names'].includes(req.query.view)) req.session.boardView = req.query.view;
  const view = req.session.boardView || 'summary';
  const bounds = monthBounds(req.query.month);
  const { columns, rows } = buildBoard(bounds.start, bounds.end);
  res.render('hub/board', {
    page: 'board', view, columns, rows, ...bounds,
    monthName: new Date(bounds.start + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  });
});

router.get('/export.xlsx', async (req, res) => {
  const bounds = monthBounds(req.query.month);
  const { columns, rows } = buildBoard(bounds.start, bounds.end);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(bounds.month);
  ws.columns = [{ header: 'Date', key: 'date', width: 16 }, ...columns.map(c => ({ header: `${c.label} ${c.sub}`, key: c.key, width: 30 }))];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const out = { date: r.label ? `${r.date} ${r.label}` : r.date };
    for (const c of columns) {
      const cell = r.cells[c.key];
      if (!cell) { out[c.key] = ''; continue; }
      out[c.key] = cell.covered ? `${cell.covered} (covering)` : cell.groups.map(g => {
        const names = g.slot.assigned.map(a => a.person_name).concat(Array(g.slot.open).fill('(open)'));
        return (g.label ? `${g.label}: ` : '') + names.join(', ');
      }).join('\n');
    }
    ws.addRow(out).alignment = { wrapText: true, vertical: 'top' };
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="schedule-${bounds.month}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

router.get('/people', (req, res) => {
  const today = cal.todayIso();
  const since = cal.addDays(today, -365);
  const until = cal.addMonths(today, 3);
  const counts = all(`SELECT a.person_id, e.ministry, SUM(CASE WHEN d.date < ? THEN 1 ELSE 0 END) AS past, SUM(CASE WHEN d.date >= ? THEN 1 ELSE 0 END) AS upcoming
                      FROM assignments a JOIN ministry_events e ON e.id = a.event_id JOIN service_days d ON d.id = e.service_day_id
                      WHERE d.date >= ? AND d.date <= ? AND ${engine.VISIBLE_SQL} GROUP BY a.person_id, e.ministry`, [today, today, since, until]);
  const people = all("SELECT * FROM people WHERE office != 'none' ORDER BY name").map(p => {
    const mine = counts.filter(c => c.person_id === p.id);
    const by = m => mine.find(c => c.ministry === m) || { past: 0, upcoming: 0 };
    return { ...p, communion: by('communion'), prayer: by('prayer'), duty: by('duty'),
      totalPast: mine.reduce((n, c) => n + c.past, 0), totalUpcoming: mine.reduce((n, c) => n + c.upcoming, 0) };
  }).sort((a, b) => (b.totalPast + b.totalUpcoming) - (a.totalPast + a.totalUpcoming) || a.name.localeCompare(b.name));
  res.render('hub/board-people', { page: 'board', people, names: MINISTRY_NAMES });
});

module.exports = router;
