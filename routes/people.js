const express = require('express');
const multer = require('multer');
const router = express.Router();
const { get, all, run } = require('../db');
const { requireRole, rolesFor } = require('../core/auth');
const { parseRoster, previewImport, applyImport } = require('../core/roster');
const { eligibleMinistries, MINISTRY_NAMES } = require('../core/eligibility');
const { CAMPUSES } = require('../core/schema');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.use(requireRole('super'));

const back = (res, key, msg) => res.redirect('/admin/people?' + key + '=' + encodeURIComponent(msg));

router.get('/', (req, res) => {
  const people = all('SELECT * FROM people ORDER BY name').map(p => {
    const roles = rolesFor(p.id).map(r => r.role);
    return { ...p, roles, ministries: eligibleMinistries(p).map(k => MINISTRY_NAMES[k]) };
  });
  const officers = people.filter(p => p.office !== 'none');
  const counts = {
    elders: officers.filter(p => p.office === 'elder').length,
    deacons: officers.filter(p => p.office === 'deacon').length,
    inactive: officers.filter(p => !p.active).length,
    herndon: officers.filter(p => p.home_campus === 'Herndon').length,
  };
  res.render('hub/people', { page: 'people', people, counts, success: req.query.success || null, error: req.query.error || null });
});

router.get('/template.csv', (req, res) => {
  res.type('text/csv').attachment('officer-roster-template.csv')
    .send('Name,Email,Phone,Office,Status,Main Location\nJane Doe,jane@example.com,703-555-0100,Elder,Active,McLean\n');
});

router.post('/import', (req, res) => {
  upload.single('roster')(req, res, err => {
    if (err) return back(res, 'error', 'The file could not be read. Upload a CSV under 2 MB.');
    if (!req.file) return back(res, 'error', 'Choose a CSV file to import.');
    let parsed;
    try {
      parsed = parseRoster(req.file.buffer);
    } catch (e) {
      return back(res, 'error', 'The file is not a readable CSV. Save the spreadsheet as CSV and try again.');
    }
    if (parsed.missingColumns.length) {
      return back(res, 'error', `The file is missing these columns: ${parsed.missingColumns.join(', ').replace('location', 'Main Location')}. The first row must have Name, Email, Phone, Office, Status, Main Location.`);
    }
    req.session.rosterImport = { rows: parsed.rows, errors: parsed.errors, filename: req.file.originalname };
    res.redirect('/admin/people/import/preview');
  });
});

router.get('/import/preview', (req, res) => {
  const pending = req.session.rosterImport;
  if (!pending) return res.redirect('/admin/people');
  res.render('hub/people-preview', { page: 'people', ...previewImport(pending.rows), errors: pending.errors, filename: pending.filename });
});

router.post('/import/confirm', (req, res) => {
  const pending = req.session.rosterImport;
  if (!pending) return back(res, 'error', 'There is no import waiting. Upload the file again.');
  const { added, updated } = applyImport(pending.rows, req.person.id);
  delete req.session.rosterImport;
  back(res, 'success', `Roster imported: ${added} added, ${updated} updated. Nobody was removed.`);
});

router.post('/import/cancel', (req, res) => {
  delete req.session.rosterImport;
  back(res, 'success', 'Import cancelled. Nothing was changed.');
});

// Checks the person form; returns an error message, or null when it's fine.
function personProblem(body, ignoreId) {
  const cleanEmail = String(body.email || '').trim().toLowerCase();
  if (!String(body.name || '').trim()) return 'Enter a name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return 'Enter a valid email address.';
  if (!['elder', 'deacon', 'none'].includes(body.office)) return 'Choose an office.';
  if (!CAMPUSES.includes(body.home_campus)) return 'Choose a main location.';
  const clash = get('SELECT id, name FROM people WHERE email = ? AND id != ?', [cleanEmail, ignoreId || 0]);
  if (clash) return `${clash.name} already uses that email.`;
  return null;
}

function setRoles(personId, body) {
  const setRole = (role, on) => {
    run('DELETE FROM role_grants WHERE person_id = ? AND role = ? AND ministry IS NULL', [personId, role]);
    if (on) run('INSERT INTO role_grants (person_id, role) VALUES (?, ?)', [personId, role]);
  };
  setRole('staff', !!body.role_staff);
  setRole('super', !!body.role_super);
}

const NEW_PERSON = { name: '', email: '', phone: '', office: 'elder', status: 'active', home_campus: 'McLean' };

router.get('/new', (req, res) => {
  res.render('hub/person-edit', { page: 'people', p: NEW_PERSON, isNew: true, roles: [], campuses: CAMPUSES, error: null });
});

router.post('/new', (req, res) => {
  const body = req.body;
  const problem = personProblem(body);
  if (problem) {
    const roles = [body.role_staff && 'staff', body.role_super && 'super'].filter(Boolean);
    return res.render('hub/person-edit', { page: 'people', p: { ...NEW_PERSON, ...body }, isNew: true, roles, campuses: CAMPUSES, error: problem });
  }
  const name = body.name.trim(), email = body.email.trim().toLowerCase();
  run('INSERT INTO people (name, email, phone, office, active, home_campus, preferred_campus) VALUES (?,?,?,?,?,?,?)',
    [name, email, String(body.phone || '').trim() || null, body.office, body.status === 'active' ? 1 : 0, body.home_campus, body.home_campus]);
  const id = get('SELECT id FROM people WHERE email = ?', [email]).id;
  setRoles(id, body);
  run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)',
    [req.person.id, 'person_add', JSON.stringify({ id, office: body.office, status: body.status, home_campus: body.home_campus, staff: !!body.role_staff, super: !!body.role_super })]);
  back(res, 'success', `${name} added. They can sign in with an emailed link from the sign-in page.`);
});

router.get('/:id/edit', (req, res) => {
  const p = get('SELECT * FROM people WHERE id = ?', [req.params.id]);
  if (!p) return back(res, 'error', 'That person was not found.');
  res.render('hub/person-edit', { page: 'people', p, roles: rolesFor(p.id).map(r => r.role), campuses: CAMPUSES, error: null });
});

router.post('/:id', (req, res) => {
  const p = get('SELECT * FROM people WHERE id = ?', [req.params.id]);
  if (!p) return back(res, 'error', 'That person was not found.');
  const { name, email, phone, office, status, home_campus, role_staff, role_super } = req.body;
  const roles = rolesFor(p.id).map(r => r.role);
  const fail = error => res.render('hub/person-edit', { page: 'people', p: { ...p, ...req.body }, roles, campuses: CAMPUSES, error });

  const cleanEmail = String(email || '').trim().toLowerCase();
  const problem = personProblem(req.body, p.id);
  if (problem) return fail(problem);

  const wasSuper = roles.includes('super');
  const superCount = get("SELECT COUNT(DISTINCT person_id) AS c FROM role_grants WHERE role = 'super'").c;
  if (wasSuper && !role_super && (p.id === req.person.id || superCount <= 1)) {
    return fail(p.id === req.person.id ? "You can't remove your own administrator access." : 'At least one administrator is required.');
  }

  run(`UPDATE people SET name = ?, email = ?, phone = ?, office = ?, active = ?, home_campus = ?, updated_at = datetime('now') WHERE id = ?`,
    [name.trim(), cleanEmail, String(phone || '').trim() || null, office, status === 'active' ? 1 : 0, home_campus, p.id]);

  setRoles(p.id, req.body);

  run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)',
    [req.person.id, 'person_edit', JSON.stringify({ id: p.id, office, status, home_campus, staff: !!role_staff, super: !!role_super })]);
  back(res, 'success', `${name.trim()} updated.`);
});

module.exports = router;
