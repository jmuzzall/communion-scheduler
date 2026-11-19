// Converts election-scheduler (duty deacon) data into the shared model. Reads from an uploaded
// copy of election.db and writes into `target`. Works with older and newer election-scheduler
// databases (drafts, archives and reminder logs are optional). Safe to re-run.

function convertElection(target, source, rows, todayIso) {
  const has = (db, name) => rows(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]).length > 0;
  const cols = (db, name) => has(db, name) ? rows(db, `PRAGMA table_info(${name})`).map(r => r.name) : [];
  if (!has(source, 'candidates') || !has(source, 'assignments')) throw new Error("This file doesn't look like an election-scheduler database (no candidates or assignments).");

  const t = (sql, params) => rows(target, sql, params);
  const one = (sql, params) => t(sql, params)[0] || null;
  const insertId = () => one('SELECT last_insert_rowid() AS id').id;
  const report = { peopleCreated: [], peopleMatched: 0, admins: [], seasons: [], assignments: 0, unavailable: 0, submissions: 0, swaps: 0, remindersCarried: 0, skipped: [] };
  const dateOnly = v => (v ? String(v).slice(0, 10) : null);
  const addDaysIso = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  // People: deacons and their max shifts
  const personFor = {};
  for (const c of rows(source, 'SELECT * FROM candidates')) {
    const email = String(c.email || '').trim().toLowerCase();
    if (!email) continue;
    let p = one('SELECT id FROM people WHERE email = ?', [email]);
    if (p) report.peopleMatched++;
    else {
      target.run("INSERT INTO people (name, email, office, active, home_campus, preferred_campus) VALUES (?, ?, 'deacon', 1, 'McLean', 'McLean')", [c.name, email]);
      p = { id: insertId() };
      report.peopleCreated.push(`${c.name} (${email})`);
    }
    personFor[c.id] = p.id;
    if (c.max_shifts != null) target.run("INSERT OR REPLACE INTO ministry_prefs (person_id, ministry, max_shifts) VALUES (?, 'duty', ?)", [p.id, c.max_shifts]);
  }
  const personByEmail = email => {
    const p = one('SELECT id FROM people WHERE email = ?', [String(email || '').trim().toLowerCase()]);
    return p ? p.id : null;
  };

  // Admins: super admins stay administrators; other admins become duty coordinators
  if (has(source, 'admins')) {
    for (const a of rows(source, 'SELECT * FROM admins')) {
      const email = String(a.email || '').trim().toLowerCase();
      if (!email) continue;
      let pid = personByEmail(email);
      if (!pid) { target.run("INSERT INTO people (name, email, office) VALUES (?, ?, 'none')", [a.name || email, email]); pid = insertId(); }
      const role = a.is_super ? 'super' : 'coordinator';
      const ministry = a.is_super ? null : 'duty';
      const exists = one('SELECT 1 AS x FROM role_grants WHERE person_id = ? AND role = ? AND ' + (ministry ? 'ministry = ?' : 'ministry IS NULL'), ministry ? [pid, role, ministry] : [pid, role]);
      if (!exists) target.run('INSERT INTO role_grants (person_id, role, ministry) VALUES (?, ?, ?)', [pid, role, ministry]);
      report.admins.push(`${a.name || email}: ${a.is_super ? 'administrator' : 'duty coordinator'}`);
    }
  }

  // Duty headcount: total slots per Sunday across election-scheduler locations
  const duty = one("SELECT * FROM positions WHERE ministry = 'duty' AND event_id IS NULL ORDER BY sort_order LIMIT 1");
  if (has(source, 'locations')) {
    const slots = rows(source, 'SELECT COALESCE(SUM(slots_per_day), 0) AS n FROM locations')[0].n;
    if (slots > 0) target.run('UPDATE positions SET needed = ? WHERE id = ?', [slots, duty.id]);
  }

  const claimedDays = new Set();
  const eventOnDay = (date, seasonId, { claim }) => {
    target.run('INSERT OR IGNORE INTO service_days (date) VALUES (?)', [date]);
    const day = one('SELECT id FROM service_days WHERE date = ?', [date]);
    let ev = one("SELECT * FROM ministry_events WHERE ministry = 'duty' AND kind = 'regular' AND service_day_id = ?", [day.id]);
    if (ev && ev.season_id && ev.season_id !== seasonId && (claimedDays.has(date) || !claim)) return null;
    if (ev) target.run('UPDATE ministry_events SET season_id = ? WHERE id = ?', [seasonId, ev.id]);
    else { target.run("INSERT INTO ministry_events (ministry, service_day_id, season_id, kind) VALUES ('duty', ?, ?, 'regular')", [day.id, seasonId]); ev = { id: insertId() }; }
    if (claim) claimedDays.add(date);
    return ev.id;
  };
  const addSeason = (label, start, end, deadline, status) => {
    const existing = one("SELECT id FROM seasons WHERE ministry = 'duty' AND label = ? AND start_date = ? AND end_date = ?", [label, start, end]);
    if (existing) { target.run('UPDATE seasons SET status = ?, availability_deadline = ? WHERE id = ?', [status, deadline, existing.id]); return existing.id; }
    target.run("INSERT INTO seasons (ministry, label, start_date, end_date, availability_deadline, status) VALUES ('duty', ?, ?, ?, ?, ?)", [label, start, end, deadline, status]);
    report.seasons.push(`${label} (${start} to ${end}, ${status})`);
    return insertId();
  };
  const fillSundays = (seasonId, start, end) => {
    const d = new Date(start + 'T12:00:00');
    while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
    for (; d.toISOString().slice(0, 10) <= end; d.setDate(d.getDate() + 7)) eventOnDay(d.toISOString().slice(0, 10), seasonId, { claim: true });
  };
  const addAssignment = (eventId, personId, map, sourceId) => {
    if (!eventId || !personId) return;
    const existing = one('SELECT id FROM assignments WHERE event_id = ? AND position_id = ? AND person_id = ?', [eventId, duty.id, personId]);
    if (existing) { if (map) map[sourceId] = existing.id; return; }
    target.run("INSERT INTO assignments (event_id, position_id, person_id, type) VALUES (?, ?, ?, 'planned')", [eventId, duty.id, personId]);
    if (map) map[sourceId] = insertId();
    report.assignments++;
  };

  const settings = has(source, 'system_settings') ? rows(source, 'SELECT * FROM system_settings WHERE id = 1')[0] || {} : {};
  const settingCols = cols(source, 'system_settings');
  let inputSeasonId = null;

  // Current season (live schedule)
  const currentRows = rows(source, 'SELECT * FROM assignments ORDER BY date');
  const currentAssignment = {};
  const currentEnd = settings.schedule_start_date && settings.schedule_end_date ? settings.schedule_end_date : null;
  if (currentEnd) {
    const start = settings.schedule_start_date, end = settings.schedule_end_date;
    const status = end < todayIso ? 'archived' : currentRows.length ? 'published' : 'collecting';
    const seasonId = addSeason('Current duty season (imported)', start, end, dateOnly(settings.input_deadline), status);
    fillSundays(seasonId, start, end);
    for (const a of currentRows) addAssignment(eventOnDay(a.date, seasonId, { claim: true }), personFor[a.candidate_id], currentAssignment, a.id);
    inputSeasonId = seasonId;
  }

  // Next season being drafted
  // election-scheduler leaves the draft dates in place after publishing; an empty draft that overlaps
  // the live season is that leftover, not a new season.
  const drafts = has(source, 'draft_assignments') ? rows(source, 'SELECT * FROM draft_assignments ORDER BY date') : [];
  let draftStart = settings.draft_start_date;
  if (draftStart && currentEnd && draftStart <= currentEnd) {
    if (!drafts.length) { report.skipped.push(`Next season (${draftStart} to ${settings.draft_end_date}): left over from planning the current season, with no draft schedule`); draftStart = null; }
    else draftStart = addDaysIso(currentEnd, 7);
  }
  if (settingCols.includes('draft_start_date') && draftStart && settings.draft_end_date && draftStart <= settings.draft_end_date) {
    const seasonId = addSeason('Next duty season (imported draft)', draftStart, settings.draft_end_date,
      dateOnly(settings.draft_input_deadline), drafts.length ? 'draft' : 'collecting');
    fillSundays(seasonId, draftStart, settings.draft_end_date);
    for (const a of drafts) addAssignment(eventOnDay(a.date, seasonId, { claim: true }), personFor[a.candidate_id]);
    inputSeasonId = seasonId;
  }

  // Archived seasons, for history and fairness; days already used by a live season are skipped
  if (has(source, 'schedule_archives') && has(source, 'archive_assignments')) {
    for (const ar of rows(source, 'SELECT * FROM schedule_archives ORDER BY created_at')) {
      const items = rows(source, 'SELECT * FROM archive_assignments WHERE archive_id = ? ORDER BY date', [ar.id]);
      if (!items.length) continue;
      // Date archives by their shifts: election-scheduler sometimes stamped an archive with the next period's dates.
      const start = items[0].date, end = items[items.length - 1].date;
      const label = ar.label || `Archived season ${start}`;
      const mine = one("SELECT id FROM seasons WHERE ministry = 'duty' AND label = ? AND start_date = ? AND end_date = ?", [label, start, end]);
      const owners = new Set(items.map(it => {
        const ev = one("SELECT e.season_id FROM ministry_events e JOIN service_days d ON d.id = e.service_day_id WHERE e.ministry = 'duty' AND e.kind = 'regular' AND d.date = ?", [it.date]);
        return ev && ev.season_id && (!mine || ev.season_id !== mine.id) ? ev.season_id : null;
      }));
      if (!owners.has(null)) {
        const names = [...owners].map(id => (one('SELECT label FROM seasons WHERE id = ?', [id]) || {}).label).filter(Boolean);
        report.skipped.push(`${label}: a copy of ${names.join(', ')} (same Sundays), so it wasn't imported again`);
        continue;
      }
      const seasonId = addSeason(label, start, end, dateOnly(ar.input_deadline), 'archived');
      let skippedDays = 0, unmatched = 0;
      for (const it of items) {
        const pid = personByEmail(it.candidate_email);
        if (!pid) { unmatched++; continue; }
        const ev = eventOnDay(it.date, seasonId, { claim: false });
        if (!ev) { skippedDays++; continue; }
        addAssignment(ev, pid);
      }
      if (skippedDays) report.skipped.push(`${label}: ${skippedDays} shift(s) on Sundays that already belong to another season`);
      if (unmatched) report.skipped.push(`${label}: ${unmatched} shift(s) for people no longer on the roster`);
    }
  }

  // Blackout dates the deacons entered themselves, and who submitted for the input season
  const blackoutCols = cols(source, 'blackout_dates');
  if (blackoutCols.length) {
    const where = blackoutCols.includes('is_system_generated') ? 'WHERE is_system_generated = 0' : '';
    for (const b of rows(source, `SELECT * FROM blackout_dates ${where}`)) {
      const pid = personFor[b.candidate_id];
      if (!pid || new Date(b.date + 'T12:00:00').getDay() !== 0) continue;
      target.run('INSERT OR IGNORE INTO service_days (date) VALUES (?)', [b.date]);
      const day = one('SELECT id FROM service_days WHERE date = ?', [b.date]);
      target.run("INSERT OR IGNORE INTO unavailability (person_id, service_day_id, source) VALUES (?, ?, 'self')", [pid, day.id]);
      report.unavailable++;
    }
  }
  if (inputSeasonId && cols(source, 'candidates').includes('has_submitted_input')) {
    for (const c of rows(source, 'SELECT id FROM candidates WHERE has_submitted_input = 1')) {
      if (!personFor[c.id]) continue;
      target.run('INSERT OR IGNORE INTO season_submissions (season_id, person_id) VALUES (?, ?)', [inputSeasonId, personFor[c.id]]);
      report.submissions++;
    }
  }

  // Thursday team email: carry the coordinator's subject, message, CC list and on/off, unless already set here
  if (settingCols.includes('sunday_email_body')) {
    const setOnce = (key, value) => {
      if (value === undefined || value === null || one('SELECT 1 AS x FROM meta WHERE key = ?', [key])) return;
      target.run('INSERT INTO meta (key, value) VALUES (?, ?)', [key, String(value)]);
      report.thursday = true;
    };
    setOnce('thursday_subject', settings.sunday_email_subject || null);
    setOnce('thursday_message', settings.sunday_email_body || null);
    setOnce('thursday_cc', settings.sunday_email_cc ? String(settings.sunday_email_cc).split(/[\s,;]+/).filter(Boolean).join(', ') : null);
    if (settingCols.includes('sunday_reminder_enabled')) setOnce('thursday_email', settings.sunday_reminder_enabled ? 'on' : 'off');
  }

  // Pending swaps on the live schedule
  if (has(source, 'swap_requests')) {
    for (const s of rows(source, "SELECT * FROM swap_requests WHERE status = 'pending'")) {
      const ra = currentAssignment[s.requester_assignment_id], ta = currentAssignment[s.target_assignment_id];
      const rp = personFor[s.requester_id], tp = personFor[s.target_id];
      if (!ra || !ta || !rp || !tp) continue;
      if (one('SELECT 1 AS x FROM swaps WHERE requester_assignment_id = ? AND target_assignment_id = ?', [ra, ta])) continue;
      target.run("INSERT INTO swaps (ministry, requester_id, requester_assignment_id, target_id, target_assignment_id, status, message, created_at) VALUES ('duty', ?, ?, ?, ?, 'pending', ?, ?)",
        [rp, ra, tp, ta, s.message || null, s.created_at || null]);
      report.swaps++;
    }
  }

  // Reminders already sent, so nobody gets them twice right after launch
  if (has(source, 'duty_reminder_log')) {
    for (const r of rows(source, 'SELECT * FROM duty_reminder_log')) {
      const pid = personFor[r.candidate_id];
      const kind = /final/i.test(r.reminder_type) ? '1day' : '7day';
      if (!pid) continue;
      target.run('INSERT OR IGNORE INTO reminder_log (person_id, ref, kind) VALUES (?, ?, ?)', [pid, r.assignment_date, kind]);
      report.remindersCarried++;
    }
  }
  if (inputSeasonId && has(source, 'reminder_log')) {
    for (const r of rows(source, 'SELECT * FROM reminder_log')) {
      const pid = personFor[r.candidate_id];
      if (!pid || !['48h', '24h'].includes(r.reminder_type)) continue;
      target.run('INSERT OR IGNORE INTO reminder_log (person_id, ref, kind) VALUES (?, ?, ?)', [pid, `season:${inputSeasonId}`, r.reminder_type]);
      report.remindersCarried++;
    }
  }
  return report;
}

module.exports = { convertElection };
