const { get, all } = require('../db');
const staging = require('./staging');

function rolesFor(personId) {
  return all('SELECT role, ministry FROM role_grants WHERE person_id = ?', [personId]);
}

function hasRole(roles, role, ministry) {
  return roles.some(r => r.role === 'super' || (r.role === role && (!ministry || !r.ministry || r.ministry === ministry)));
}

function loadPerson(req, res, next) {
  res.locals.person = null;
  res.locals.roles = [];
  res.locals.isSuper = false;
  res.locals.canManageCommunion = false;
  res.locals.servesIn = [];
  res.locals.isStaging = staging.isStaging();
  const id = req.session && req.session.personId;
  if (id) {
    const person = get('SELECT * FROM people WHERE id = ?', [id]);
    if (person && staging.isAllowed(person.email)) {
      req.person = person;
      req.roles = rolesFor(person.id);
      res.locals.person = person;
      res.locals.roles = req.roles;
      res.locals.isSuper = req.roles.some(r => r.role === 'super');
      res.locals.canManageCommunion = canManage(req.roles, 'communion');
      res.locals.servesIn = require('./eligibility').eligibleMinistries(person);
    } else {
      delete req.session.personId;
    }
  }
  next();
}

function requirePerson(req, res, next) {
  if (req.person) return next();
  res.redirect('/signin');
}

function requireRole(role, ministry) {
  return (req, res, next) => {
    if (!req.person) return res.redirect('/signin');
    if (hasRole(req.roles, role, ministry)) return next();
    res.status(403).render('hub/forbidden', { page: null });
  };
}

// Administrators, staff, and that ministry's coordinators can manage its schedule.
function canManage(roles, ministry) {
  return roles.some(r => r.role === 'super' || r.role === 'staff' || (r.role === 'coordinator' && (!r.ministry || r.ministry === ministry)));
}

function requireStaffFor(ministry) {
  return (req, res, next) => {
    if (!req.person) return res.redirect('/signin');
    if (canManage(req.roles, ministry)) return next();
    res.status(403).render('hub/forbidden', { page: null });
  };
}

function hasSuperAdmin() {
  return !!get("SELECT id FROM role_grants WHERE role = 'super' LIMIT 1");
}

module.exports = { loadPerson, requirePerson, requireRole, requireStaffFor, canManage, hasSuperAdmin, rolesFor };
