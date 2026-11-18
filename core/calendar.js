const { all, run } = require('../db');

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayIso() {
  return isoDate(new Date());
}

// Every Sunday from the start of this month through the given number of months ahead.
function ensureSundays(monthsAhead = 15) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + monthsAhead + 1, 0);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  while (d <= end) {
    run('INSERT OR IGNORE INTO service_days (date) VALUES (?)', [isoDate(d)]);
    d.setDate(d.getDate() + 7);
  }
}

function upcomingServiceDays(fromIso, weeks) {
  const until = new Date(fromIso + 'T12:00:00');
  until.setDate(until.getDate() + weeks * 7);
  return all('SELECT * FROM service_days WHERE date >= ? AND date <= ? ORDER BY date', [fromIso, isoDate(until)]);
}

function formatDay(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

module.exports = { ensureSundays, upcomingServiceDays, formatDay, todayIso, isoDate };
