// One-time conversion of a communion-scheduler database into the shared model. Runs only
// when the old tables are present and it hasn't run before. Old admin accounts are not copied.

const CATEGORY_OFFICE = {
  active_elder: ['elder', 1], inactive_elder: ['elder', 0],
  active_deacon: ['deacon', 1], inactive_deacon: ['deacon', 0],
};
const ASSIGNMENT_TYPE = { voluntary: 'voluntary', auto: 'auto', traded: 'swapped' };

function migrateLegacyCommunion(db, rows) {
  const hasTable = name => rows(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]).length > 0;
  if (!hasTable('communion_dates') || !hasTable('members')) return;
  if (rows(db, "SELECT 1 FROM meta WHERE key = 'legacy_communion_migrated'").length) return;

  const one = (sql, params) => rows(db, sql, params)[0] || null;
  const insertId = () => one('SELECT last_insert_rowid() AS id').id;
  const counts = { people: 0, events: 0, assignments: 0, unavailable: 0, swaps: 0 };

  db.run('BEGIN');
  try {
    const personFor = {};
    for (const m of rows(db, 'SELECT * FROM members')) {
      const email = String(m.email || '').trim().toLowerCase();
      if (!email) continue;
      const existing = one('SELECT id, password_hash FROM people WHERE email = ?', [email]);
      if (existing) {
        if (!existing.password_hash && m.password_hash) db.run('UPDATE people SET password_hash = ? WHERE id = ?', [m.password_hash, existing.id]);
        personFor[m.id] = existing.id;
        continue;
      }
      const [office, active] = CATEGORY_OFFICE[m.category] || ['none', 1];
      const campus = ['McLean', 'Herndon'].includes(m.preferred_location) ? m.preferred_location : 'McLean';
      db.run(`INSERT INTO people (name, email, phone, office, active, home_campus, preferred_campus, password_hash, notify_email, notify_sms)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [m.name, email, m.phone || null, office, active, campus, campus, m.password_hash || null, m.notify_email ?? 1, m.notify_sms ?? 0]);
      personFor[m.id] = insertId();
      counts.people++;
    }

    const eventFor = {};
    for (const cd of rows(db, 'SELECT * FROM communion_dates')) {
      db.run('INSERT OR IGNORE INTO service_days (date) VALUES (?)', [cd.date]);
      const dayId = one('SELECT id FROM service_days WHERE date = ?', [cd.date]).id;
      const existing = one("SELECT id FROM ministry_events WHERE ministry = 'communion' AND kind = 'regular' AND service_day_id = ?", [dayId]);
      if (existing) { eventFor[cd.id] = existing.id; continue; }
      const status = ['assigned', 'completed'].includes(cd.status) ? 'filled' : 'upcoming';
      db.run("INSERT INTO ministry_events (ministry, service_day_id, kind, status) VALUES ('communion', ?, 'regular', ?)", [dayId, status]);
      eventFor[cd.id] = insertId();
      counts.events++;
    }

    const positionFor = {};
    for (const s of rows(db, 'SELECT * FROM slot_config')) {
      const [campus, ...rest] = String(s.location).split(' ');
      const room = rest.join(' ');
      const area = s.area ? `${room}, ${s.area}` : room;
      const pos = one("SELECT id FROM positions WHERE ministry = 'communion' AND event_id IS NULL AND campus = ? AND service_time = ? AND area = ?",
        [campus, s.service_time, area]);
      if (pos) { positionFor[s.id] = pos.id; continue; }
      if (!['McLean', 'Herndon'].includes(campus)) continue;
      db.run("INSERT INTO positions (ministry, campus, service_time, area, needed, sort_order, active) VALUES ('communion',?,?,?,?,?,0)",
        [campus, s.service_time, area, s.servers_needed, s.sort_order || 99]);
      positionFor[s.id] = insertId();
    }

    const assignmentFor = {};
    if (hasTable('legacy_assignments')) {
      for (const a of rows(db, 'SELECT * FROM legacy_assignments')) {
        const ev = eventFor[a.communion_date_id], pos = positionFor[a.slot_config_id], per = personFor[a.member_id];
        if (!ev || !pos || !per) continue;
        db.run('INSERT INTO assignments (event_id, position_id, person_id, type, created_at) VALUES (?,?,?,?,?)',
          [ev, pos, per, ASSIGNMENT_TYPE[a.assignment_type] || 'voluntary', a.created_at || null]);
        assignmentFor[a.id] = insertId();
        counts.assignments++;
      }
    }

    if (hasTable('exclusions')) {
      for (const x of rows(db, "SELECT * FROM exclusions WHERE exclusion_type = 'full_day'")) {
        const per = personFor[x.member_id];
        const cd = one('SELECT date FROM communion_dates WHERE id = ?', [x.communion_date_id]);
        if (!per || !cd) continue;
        const dayId = one('SELECT id FROM service_days WHERE date = ?', [cd.date]).id;
        db.run("INSERT OR IGNORE INTO unavailability (person_id, service_day_id, reason, source) VALUES (?,?,?,'self')", [per, dayId, x.reason || null]);
        counts.unavailable++;
      }
    }

    if (hasTable('legacy_trades')) {
      for (const t of rows(db, 'SELECT * FROM legacy_trades')) {
        const ra = assignmentFor[t.requester_assignment_id], ta = assignmentFor[t.target_assignment_id];
        const rp = personFor[t.requester_id], tp = personFor[t.target_id];
        if (!ra || !ta || !rp || !tp) continue;
        db.run(`INSERT INTO swaps (ministry, requester_id, requester_assignment_id, target_id, target_assignment_id, status, message, created_at, resolved_at)
                VALUES ('communion',?,?,?,?,?,?,?,?)`,
          [rp, ra, tp, ta, t.status || 'pending', t.message || null, t.created_at || null, t.resolved_at || null]);
        counts.swaps++;
      }
    }

    db.run("INSERT INTO meta (key, value) VALUES ('legacy_communion_migrated', ?)", [JSON.stringify({ at: new Date().toISOString(), ...counts })]);
    db.run('COMMIT');
    console.log('[Migration] Converted communion-scheduler data:', JSON.stringify(counts));
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

module.exports = { migrateLegacyCommunion };
