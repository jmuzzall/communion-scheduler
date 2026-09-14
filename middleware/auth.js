function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
}

function requireMember(req, res, next) {
  if (req.session && req.session.member) return next();
  res.redirect('/member/login');
}

module.exports = { requireAdmin, requireMember };
