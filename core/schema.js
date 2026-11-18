// Shared tables for MPC Officer Service.

const CAMPUSES = ['McLean', 'Herndon'];

// [campus, service time, area, needed, sort order]
const DEFAULT_POSITIONS = {
  communion: [
    ['McLean', '8:45 AM', 'Fellowship Hall', 6, 1],
    ['McLean', '8:45 AM', 'Sanctuary, Main Sanctuary', 8, 2],
    ['McLean', '8:45 AM', 'Sanctuary, Balcony', 2, 3],
    ['McLean', '11:15 AM', 'Fellowship Hall', 6, 4],
    ['McLean', '11:15 AM', 'Sanctuary, Main Sanctuary', 8, 5],
    ['Herndon', '10:45 AM', 'Sanctuary', 5, 6],
  ],
  prayer: [
    ['McLean', '8:45 AM', 'Fellowship Hall', 1, 1],
    ['McLean', '8:45 AM', 'Sanctuary', 1, 2],
    ['McLean', '11:15 AM', 'Fellowship Hall', 1, 3],
    ['McLean', '11:15 AM', 'Sanctuary', 1, 4],
    ['Herndon', '10:45 AM', 'Sanctuary', 1, 5],
  ],
  duty: [
    ['McLean', null, null, 2, 1],
  ],
};

function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function tableColumns(db, table) {
  return rows(db, `PRAGMA table_info(${table})`).map(r => r.name);
}

function initCoreSchema(db) {
  // Old communion-scheduler tables are renamed out of the way before the shared ones are created.
  if (tableColumns(db, 'assignments').includes('communion_date_id')) db.run('ALTER TABLE assignments RENAME TO legacy_assignments');
  if (tableColumns(db, 'trades').length) db.run('ALTER TABLE trades RENAME TO legacy_trades');

  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

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
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','filled')),
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

  db.run(`CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    position_id INTEGER NOT NULL,
    person_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('voluntary','auto','swapped','staff','planned')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES ministry_events(id) ON DELETE CASCADE,
    FOREIGN KEY (position_id) REFERENCES positions(id),
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS swaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ministry TEXT NOT NULL,
    requester_id INTEGER NOT NULL,
    requester_assignment_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    target_assignment_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
    message TEXT,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (requester_id) REFERENCES people(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES people(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS assignment_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    assignment_id INTEGER,
    changed_by INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
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

  db.run(`CREATE TABLE IF NOT EXISTS reminder_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    ref TEXT NOT NULL,
    kind TEXT NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    UNIQUE(person_id, ref, kind)
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
  require('./legacyCommunion').migrateLegacyCommunion(db, rows);
}

function seedMinistries(db) {
  const list = [
    ['communion', 'Communion', 'signup', 'first-sunday'],
    ['prayer', 'Prayer', 'signup', 'weekly'],
    ['duty', 'Duty Deacon', 'season', 'weekly'],
  ];
  for (const r of list) db.run('INSERT OR IGNORE INTO ministries (key, name, style, cadence) VALUES (?,?,?,?)', r);
}

function seedPositions(db) {
  for (const [ministry, list] of Object.entries(DEFAULT_POSITIONS)) {
    const existing = rows(db, 'SELECT COUNT(*) AS c FROM positions WHERE ministry = ? AND event_id IS NULL', [ministry])[0].c;
    if (existing) continue;
    for (const [campus, time, area, needed, order] of list) {
      db.run('INSERT INTO positions (ministry, campus, service_time, area, needed, sort_order) VALUES (?,?,?,?,?,?)',
        [ministry, campus, time, area, needed, order]);
    }
  }
}

module.exports = { initCoreSchema, CAMPUSES };
