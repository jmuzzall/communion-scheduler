// Converts communion-scheduler data into the shared model. Reads from `source` (an uploaded copy of
// communion.db, or the app's own database when it started on one) and writes into `target`.
// Safe to re-run: existing people, Sundays, assignments and swaps are matched instead of duplicated.
// Old admin accounts are not copied.

const CATEGORY_OFFICE = {
  active_elder: ['elder', 1], inactive_elder: ['elder', 0],
  active_deacon: ['deacon', 1], inactive_deacon: ['deacon', 0],
};
const ASSIGNMENT_TYPE = { voluntary: 'voluntary', auto: 'auto', traded: 'swapped' };

function convertCommunion(target, source, rows) {
  const has = (db, name) => rows(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]).length > 0;
  const cols = (db, name) => rows(db, `PRAGMA table_info(${name})`).map(r => r.name);
  if (!has(source, 'communion_dates') || !has(source, 'members')) throw new Error("This file doesn't look like a communion-scheduler database (no members or communion_dates).");
  const assignmentsTable = has(source, 'legacy_assignments') ? 'legacy_assignments'
    : cols(source, 'assignments').includes('communion_date_id') ? 'assignments' : null;
  const tradesTable = has(source, 'legacy_trades') ? 'legacy_trades' : has(source, 'trades') ? 'trades' : null;

  const t = (sql, params) => rows(target, sql, params);
  const one = (sql, params) => t(sql, params)[0] || null;
  const insertId = () => one('SELECT last_insert_rowid() AS id').id;
  const report = { peopleCreated: [], peopleMatched: 0, events: 0, assignments: 0, unavailable: 0, swaps: 0 };

  const personFor = {};
  for (const m of rows(source, 'SELECT * FROM members')) {
    const email = String(m.email || '').trim().toLowerCase();
    if (!email) continue;
    const existing = one('SELECT id, password_hash FROM people WHERE email = ?', [email]);
    if (existing) {
      if (!existing.password_hash && m.password_hash) target.run('UPDATE people SET password_hash = ? WHERE id = ?', [m.password_hash, existing.id]);
      personFor[m.id] = existing.id;
      report.peopleMatched++;
      continue;
    }
    const [office, active] = CATEGORY_OFFICE[m.category] || ['none', 1];
    const campus = ['McLean', 'Herndon'].includes(m.preferred_location) ? m.preferred_location : 'McLean';
    target.run(`INSERT INTO people (name, email, phone, office, active, home_campus, preferred_campus, password_hash, notify_email, notify_sms)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [m.name, email, m.phone || null, office, active, campus, campus, m.password_hash || null, m.notify_email ?? 1, m.notify_sms ?? 0]);
    personFor[m.id] = insertId();
    report.peopleCreated.push(`${m.name} (${email})`);
  }

  const eventFor = {};
  const dateFor = {};
  for (const cd of rows(source, 'SELECT * FROM communion_dates')) {
    dateFor[cd.id] = cd.date;
    target.run('INSERT OR IGNORE INTO service_days (date) VALUES (?)', [cd.date]);
    const dayId = one('SELECT id FROM service_days WHERE date = ?', [cd.date]).id;
    const existing = one("SELECT id FROM ministry_events WHERE ministry = 'communion' AND kind = 'regular' AND service_day_id = ?", [dayId]);
    const status = ['assigned', 'completed'].includes(cd.status) ? 'filled' : 'upcoming';
    if (existing) {
      if (status === 'filled') target.run("UPDATE ministry_events SET status = 'filled' WHERE id = ?", [existing.id]);
      eventFor[cd.id] = existing.id;
      continue;
    }
    target.run("INSERT INTO ministry_events (ministry, service_day_id, kind, status) VALUES ('communion', ?, 'regular', ?)", [dayId, status]);
    eventFor[cd.id] = insertId();
    report.events++;
  }

  const positionFor = {};
  for (const s of rows(source, 'SELECT * FROM slot_config')) {
    const [campus, ...rest] = String(s.location).split(' ');
    const room = rest.join(' ');
    const area = s.area ? `${room}, ${s.area}` : room;
    const pos = one("SELECT id FROM positions WHERE ministry = 'communion' AND event_id IS NULL AND campus = ? AND service_time = ? AND area = ?",
      [campus, s.service_time, area]);
    if (pos) { positionFor[s.id] = pos.id; continue; }
    if (!['McLean', 'Herndon'].includes(campus)) continue;
    target.run("INSERT INTO positions (ministry, campus, service_time, area, needed, sort_order, active) VALUES ('communion',?,?,?,?,?,0)",
      [campus, s.service_time, area, s.servers_needed, s.sort_order || 99]);
    positionFor[s.id] = insertId();
  }

  const assignmentFor = {};
  if (assignmentsTable) {
    for (const a of rows(source, `SELECT * FROM ${assignmentsTable}`)) {
      const ev = eventFor[a.communion_date_id], pos = positionFor[a.slot_config_id], per = personFor[a.member_id];
      if (!ev || !pos || !per) continue;
      const existing = one('SELECT id FROM assignments WHERE event_id = ? AND position_id = ? AND person_id = ?', [ev, pos, per]);
      if (existing) { assignmentFor[a.id] = existing.id; continue; }
      target.run('INSERT INTO assignments (event_id, position_id, person_id, type, created_at) VALUES (?,?,?,?,?)',
        [ev, pos, per, ASSIGNMENT_TYPE[a.assignment_type] || 'voluntary', a.created_at || null]);
      assignmentFor[a.id] = insertId();
      report.assignments++;
    }
  }

  if (has(source, 'exclusions')) {
    for (const x of rows(source, "SELECT * FROM exclusions WHERE exclusion_type = 'full_day'")) {
      const per = personFor[x.member_id], date = dateFor[x.communion_date_id];
      if (!per || !date) continue;
      const dayId = one('SELECT id FROM service_days WHERE date = ?', [date]).id;
      target.run("INSERT OR IGNORE INTO unavailability (person_id, service_day_id, reason, source) VALUES (?,?,?,'self')", [per, dayId, x.reason || null]);
      report.unavailable++;
    }
  }

  if (tradesTable) {
    for (const tr of rows(source, `SELECT * FROM ${tradesTable}`)) {
      const ra = assignmentFor[tr.requester_assignment_id], ta = assignmentFor[tr.target_assignment_id];
      const rp = personFor[tr.requester_id], tp = personFor[tr.target_id];
      if (!ra || !ta || !rp || !tp) continue;
      if (one('SELECT 1 AS x FROM swaps WHERE requester_assignment_id = ? AND target_assignment_id = ?', [ra, ta])) continue;
      target.run(`INSERT INTO swaps (ministry, requester_id, requester_assignment_id, target_id, target_assignment_id, status, message, created_at, resolved_at)
                  VALUES ('communion',?,?,?,?,?,?,?,?)`,
        [rp, ra, tp, ta, tr.status || 'pending', tr.message || null, tr.created_at || null, tr.resolved_at || null]);
      report.swaps++;
    }
  }
  return report;
}

// Runs once when the app starts on a communion-scheduler database file itself.
function migrateLegacyCommunion(db, rows) {
  const hasTable = name => rows(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]).length > 0;
  if (!hasTable('communion_dates') || !hasTable('members')) return;
  if (rows(db, "SELECT 1 FROM meta WHERE key = 'legacy_communion_migrated'").length) return;
  db.run('BEGIN');
  try {
    const report = convertCommunion(db, db, rows);
    db.run("INSERT INTO meta (key, value) VALUES ('legacy_communion_migrated', ?)", [JSON.stringify({ at: new Date().toISOString(), people: report.peopleCreated.length, events: report.events, assignments: report.assignments })]);
    db.run('COMMIT');
    console.log('[Migration] Converted communion-scheduler data:', JSON.stringify({ ...report, peopleCreated: report.peopleCreated.length }));
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

module.exports = { migrateLegacyCommunion, convertCommunion };
