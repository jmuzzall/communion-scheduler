const { get, all, run, transaction } = require('../db');

const TZ = 'America/New_York';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Today's date and hour in Eastern time (the server runs on UTC).
function nowEastern() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) % 24, weekday: parts.weekday };
}

function todayIso() {
  return nowEastern().date;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function addMonths(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setMonth(d.getMonth() + n);
  return isoDate(d);
}

// Auto-fill runs on the Friday of the week before the Sunday (nine days ahead), or on Thursday
// when that Friday is a holiday.
function autofillDate(sundayIso) {
  const friday = addDays(sundayIso, -9);
  return require('./holidays').holidayName(friday) ? addDays(friday, -1) : friday;
}

function ensureSundays(monthsAhead = 15) {
  const now = new Date(todayIso() + 'T12:00:00');
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + monthsAhead + 1, 0);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  transaction(() => {
    while (d <= end) {
      run('INSERT OR IGNORE INTO service_days (date) VALUES (?)', [isoDate(d)]);
      d.setDate(d.getDate() + 7);
    }
  });
}

// One regular communion event on the first Sunday of each month.
function ensureCommunionEvents(monthsAhead = 15) {
  const start = new Date(todayIso() + 'T12:00:00');
  transaction(() => {
    for (let i = 0; i <= monthsAhead; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
      const iso = isoDate(d);
      run('INSERT OR IGNORE INTO service_days (date) VALUES (?)', [iso]);
      const day = get('SELECT id FROM service_days WHERE date = ?', [iso]);
      const exists = get("SELECT id FROM ministry_events WHERE ministry = 'communion' AND kind = 'regular' AND service_day_id = ?", [day.id]);
      if (!exists) run("INSERT INTO ministry_events (ministry, service_day_id, kind) VALUES ('communion', ?, 'regular')", [day.id]);
    }
  });
}

// One regular event for the ministry on every Sunday (prayer).
function ensureWeeklyEvents(ministry, monthsAhead = 15) {
  ensureSundays(monthsAhead);
  transaction(() => {
    for (const day of all('SELECT id FROM service_days WHERE date >= ? AND label IS NULL', [todayIso()])) {
      const exists = get("SELECT id FROM ministry_events WHERE ministry = ? AND kind = 'regular' AND service_day_id = ?", [ministry, day.id]);
      if (!exists) run("INSERT INTO ministry_events (ministry, service_day_id, kind) VALUES (?, ?, 'regular')", [ministry, day.id]);
    }
  });
}

function upcomingServiceDays(fromIso, weeks) {
  return all('SELECT * FROM service_days WHERE date >= ? AND date <= ? ORDER BY date', [fromIso, addDays(fromIso, weeks * 7)]);
}

function formatDay(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatLongDay(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

module.exports = {
  ensureSundays, ensureCommunionEvents, ensureWeeklyEvents, upcomingServiceDays, formatDay, formatLongDay,
  todayIso, nowEastern, isoDate, addDays, addMonths, autofillDate,
};
