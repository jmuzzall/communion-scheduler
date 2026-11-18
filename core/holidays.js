// Holidays that can fall on a Friday: fixed-date federal holidays (and the Friday they are observed
// when they land on a Saturday), plus Good Friday.
function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

const FIXED = [[1, 1, "New Year's Day"], [6, 19, 'Juneteenth'], [7, 4, 'Independence Day'], [11, 11, 'Veterans Day'], [12, 25, 'Christmas Day']];

function holidaysFor(year) {
  const out = {};
  for (const y of [year, year + 1]) {
    for (const [m, d, name] of FIXED) {
      const date = new Date(y, m - 1, d);
      out[iso(y, m, d)] = name;
      if (date.getDay() === 6) {
        const observed = new Date(y, m - 1, d - 1);
        out[iso(observed.getFullYear(), observed.getMonth() + 1, observed.getDate())] = `${name} (observed)`;
      }
    }
  }
  const goodFriday = easterSunday(year);
  goodFriday.setDate(goodFriday.getDate() - 2);
  out[iso(goodFriday.getFullYear(), goodFriday.getMonth() + 1, goodFriday.getDate())] = 'Good Friday';
  return out;
}

function holidayName(isoDate) {
  return holidaysFor(parseInt(isoDate.slice(0, 4), 10))[isoDate] || null;
}

module.exports = { holidayName };
