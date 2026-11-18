// Shared tables for MPC Officer Service. Existing communion tables are left in place
// until the Communion module is moved onto this model.

const CAMPUSES = ['McLean', 'Herndon'];

const PRAYER_POSITIONS = [
  ['McLean', '8:45 AM', 'Fellowship Hall', 1],
  ['McLean', '8:45 AM', 'Sanctuary', 2],
  ['McLean', '11:15 AM', 'Fellowship Hall', 3],
  ['McLean', '11:15 AM', 'Sanctuary', 4],
  ['Herndon', '10:45 AM', 'Sanctuary', 5],
];

function initCoreSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    phone TEXT,
    office TEXT NOT NULL DEFAULT 'none' CHECK(office IN ('elder','deacon','none')),
    active INTEGER NOT NULL DEFAULT 1,
    home_campus TEXT NOT NULL DEFAULT 'McLean' CHECK(home_campus IN ('McLean','Herndon')),
    preferred_campus TEXT CHECK(preferred_campus IN ('McLean','Herndon')),
    password_hash TEXT,
    notify_email INTEGER NOT NULL DEFAULT 1,
    notify_sms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS role_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('super','staff','coordinator')),
    ministry TEXT,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS person_login_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ministries (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    style TEXT NOT NULL CHECK(style IN ('signup','season')),
    cadence TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS service_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    label TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ministry TEXT NOT NULL,
    label TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    availability_deadline TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','collecting','published','archived'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ministry_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ministry TEXT NOT NULL,
    service_day_id INTEGER NOT NULL,
    season_id INTEGER,
    kind TEXT NOT NULL DEFAULT 'regular' CHECK(kind IN ('regular','special')),
    title TEXT,
    signup_opens TEXT,
    signup_closes TEXT,
    status TEXT NOT NULL DEFAULT 'upcoming',
    FOREIGN KEY (service_day_id) REFERENCES service_days(id),
    FOREIGN KEY (season_id) REFERENCES seasons(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ministry TEXT NOT NULL,
    event_id INTEGER,
    campus TEXT NOT NULL CHECK(campus IN ('McLean','Herndon')),
    service_time TEXT,
    area TEXT,
    needed INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (event_id) REFERENCES ministry_events(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS unavailability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    service_day_id INTEGER NOT NULL,
    reason TEXT,
    source TEXT NOT NULL DEFAULT 'self' CHECK(source IN ('self','system')),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(person_id, service_day_id),
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
    FOREIGN KEY (service_day_id) REFERENCES service_days(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS availability_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    service_day_id INTEGER NOT NULL,
    ministry TEXT NOT NULL,
    UNIQUE(person_id, service_day_id, ministry),
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
    FOREIGN KEY (service_day_id) REFERENCES service_days(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_person_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  seedMinistries(db);
  seedPositions(db);
}

function count(db, sql, params = []) {
  const res = db.exec(sql, params);
  return res.length ? res[0].values[0][0] : 0;
}

function seedMinistries(db) {
  const rows = [
    ['communion', 'Communion', 'signup', 'first-sunday'],
    ['prayer', 'Prayer', 'signup', 'weekly'],
    ['duty', 'Duty Deacon', 'season', 'weekly'],
  ];
  for (const r of rows) db.run('INSERT OR IGNORE INTO ministries (key, name, style, cadence) VALUES (?,?,?,?)', r);
}

function seedPositions(db) {
  if (count(db, "SELECT COUNT(*) FROM positions WHERE ministry = 'prayer' AND event_id IS NULL") === 0) {
    for (const [campus, time, area, order] of PRAYER_POSITIONS) {
      db.run("INSERT INTO positions (ministry, campus, service_time, area, needed, sort_order) VALUES ('prayer',?,?,?,1,?)",
        [campus, time, area, order]);
    }
  }

  if (count(db, "SELECT COUNT(*) FROM positions WHERE ministry = 'duty' AND event_id IS NULL") === 0) {
    db.run("INSERT INTO positions (ministry, campus, service_time, area, needed, sort_order) VALUES ('duty','McLean',NULL,NULL,2,1)");
  }

  if (count(db, "SELECT COUNT(*) FROM positions WHERE ministry = 'communion' AND event_id IS NULL") === 0) {
    const slots = db.exec('SELECT service_time, location, area, servers_needed, sort_order FROM slot_config ORDER BY sort_order');
    for (const [time, location, area, needed, order] of (slots[0] ? slots[0].values : [])) {
      const [campus, ...rest] = String(location).split(' ');
      if (!CAMPUSES.includes(campus)) continue;
      const room = rest.join(' ');
      db.run("INSERT INTO positions (ministry, campus, service_time, area, needed, sort_order) VALUES ('communion',?,?,?,?,?)",
        [campus, time, area ? `${room}, ${area}` : room, needed, order]);
    }
  }
}

module.exports = { initCoreSchema, CAMPUSES };
