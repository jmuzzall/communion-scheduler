const { parse } = require('csv-parse/sync');
const { get, all, run } = require('../db');

const COLUMNS = {
  name: ['name', 'full name'],
  email: ['email', 'email address', 'e-mail'],
  phone: ['phone', 'phone number', 'mobile'],
  office: ['office', 'role', 'type'],
  status: ['status', 'active'],
  location: ['main location', 'location', 'campus', 'main campus'],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pick(row, headers, key) {
  const header = headers.find(h => COLUMNS[key].includes(h.trim().toLowerCase()));
  return header ? String(row[header] || '').trim() : '';
}

function normalize(value, options) {
  const v = value.trim().toLowerCase();
  return options.find(o => o.toLowerCase() === v) || null;
}

// Returns { rows, errors, missingColumns }. Rows are validated and normalized.
function parseRoster(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  const headers = records.length ? Object.keys(records[0]) : [];
  const missingColumns = ['name', 'email', 'office', 'status', 'location']
    .filter(k => !headers.some(h => COLUMNS[k].includes(h.trim().toLowerCase())));
  if (missingColumns.length) return { rows: [], errors: [], missingColumns };

  const rows = [];
  const errors = [];
  const seen = new Set();
  records.forEach((rec, i) => {
    const line = i + 2;
    const name = pick(rec, headers, 'name');
    const email = pick(rec, headers, 'email').toLowerCase();
    const office = normalize(pick(rec, headers, 'office'), ['Elder', 'Deacon']);
    const status = normalize(pick(rec, headers, 'status'), ['Active', 'Inactive']);
    const location = normalize(pick(rec, headers, 'location'), ['McLean', 'Herndon']);
    const problems = [];
    if (!name) problems.push('missing name');
    if (!EMAIL_RE.test(email)) problems.push('missing or invalid email');
    if (!office) problems.push('Office must be Elder or Deacon');
    if (!status) problems.push('Status must be Active or Inactive');
    if (!location) problems.push('Main Location must be McLean or Herndon');
    if (email && seen.has(email)) problems.push('email appears more than once in the file');
    if (problems.length) {
      errors.push({ line, name: name || email || '(blank)', problems });
      return;
    }
    seen.add(email);
    rows.push({
      name, email,
      phone: pick(rec, headers, 'phone') || null,
      office: office.toLowerCase(),
      active: status === 'Active' ? 1 : 0,
      home_campus: location,
    });
  });
  return { rows, errors, missingColumns };
}

const FIELD_LABELS = { name: 'name', phone: 'phone', office: 'office', active: 'status', home_campus: 'main location' };

function changedFields(existing, row) {
  return Object.keys(FIELD_LABELS).filter(f => String(existing[f] ?? '') !== String(row[f] ?? ''));
}

function previewImport(rows) {
  const added = [];
  const updated = [];
  let unchanged = 0;
  const emails = new Set(rows.map(r => r.email));
  for (const r of rows) {
    const existing = get('SELECT * FROM people WHERE email = ?', [r.email]);
    if (!existing) { added.push(r); continue; }
    const changes = changedFields(existing, r);
    if (changes.length) updated.push({ ...r, changes: changes.map(f => FIELD_LABELS[f]) });
    else unchanged++;
  }
  const missing = all("SELECT id, name, email, office, active FROM people WHERE office != 'none' ORDER BY name")
    .filter(p => !emails.has(p.email.toLowerCase()));
  return { added, updated, unchanged, missing };
}

// Adds new people and updates existing ones. Never deletes, and never overwrites a
// person's preferred campus or password.
function applyImport(rows, actorId) {
  let added = 0;
  let updated = 0;
  for (const r of rows) {
    const existing = get('SELECT * FROM people WHERE email = ?', [r.email]);
    if (existing) {
      if (!changedFields(existing, r).length) continue;
      run(`UPDATE people SET name = ?, phone = ?, office = ?, active = ?, home_campus = ?, updated_at = datetime('now') WHERE id = ?`,
        [r.name, r.phone, r.office, r.active, r.home_campus, existing.id]);
      updated++;
    } else {
      run(`INSERT INTO people (name, email, phone, office, active, home_campus, preferred_campus) VALUES (?,?,?,?,?,?,?)`,
        [r.name, r.email, r.phone, r.office, r.active, r.home_campus, r.home_campus]);
      added++;
    }
  }
  run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)',
    [actorId, 'roster_import', JSON.stringify({ added, updated, rows: rows.length })]);
  return { added, updated };
}

module.exports = { parseRoster, previewImport, applyImport };
