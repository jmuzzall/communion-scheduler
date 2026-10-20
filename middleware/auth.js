function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
}

function requireMember(req, res, next) {
  if (req.session && req.session.member) return next();
  res.redirect('/member/login');
}

function requireLocationSet(req, res, next) {
  if (!req.session || !req.session.member) return next();
  if (req.session.member.preferred_location) return next();
  const { get } = require('../db');
  const member = get('SELECT preferred_location FROM members WHERE id = ?', [req.session.member.id]);
  if (member && member.preferred_location) {
    req.session.member.preferred_location = member.preferred_location;
    return next();
  }
  res.redirect('/member/set-location');
}

module.exports = { requireAdmin, requireMember, requireLocationSet };
