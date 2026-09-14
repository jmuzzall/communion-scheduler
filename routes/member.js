const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { requireMember } = require('../middleware/auth');
const { get, all, run, formatCategory } = require('../db');
const { sendNotification, sendEmail } = require('../services/mailer');
const { getServiceHistory } = require('../services/scheduler');
const { formatDate } = require('../services/reminderScheduler');

router.get('/login', (req, res) => {
  res.render('member/login', { error: null, step: 'email', email: '' });
});

router.post('/login', (req, res) => {
  const { email, password, step } = req.body;

  if (step === 'email') {
    const member = get('SELECT * FROM members WHERE email = ?', [email]);
    if (!member) {
      return res.render('member/login', { error: 'No account found with that email address.', step: 'email', email });
    }
    if (!member.password_hash) {
      return res.render('member/login', { error: null, step: 'create_password', email, memberId: member.id, memberName: member.name });
    }
    return res.render('member/login', { error: null, step: 'password', email, memberName: member.name });
  }

  if (step === 'create_password') {
    const member = get('SELECT * FROM members WHERE email = ?', [email]);
    if (!member) return res.render('member/login', { error: 'Member not found.', step: 'email', email: '' });
    const hash = bcrypt.hashSync(password, 10);
    run('UPDATE members SET password_hash = ? WHERE id = ?', [hash, member.id]);
    req.session.member = { id: member.id, name: member.name, email: member.email };
    return res.redirect('/member/portal');
  }

  const member = get('SELECT * FROM members WHERE email = ?', [email]);
  if (!member || !bcrypt.compareSync(password, member.password_hash)) {
    return res.render('member/login', { error: 'Invalid password.', step: 'password', email, memberName: member?.name });
  }
  req.session.member = { id: member.id, name: member.name, email: member.email };
  res.redirect('/member/portal');
});

router.get('/auth', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/member/login');
  const link = get("SELECT * FROM magic_links WHERE token = ? AND used = 0 AND expires_at > datetime('now')", [token]);
  if (!link) return res.render('member/login', { error: 'Invalid or expired link.', step: 'email', email: '' });
  run('UPDATE magic_links SET used = 1 WHERE id = ?', [link.id]);
  const member = get('SELECT * FROM members WHERE id = ?', [link.member_id]);
  if (!member) return res.redirect('/member/login');
  req.session.member = { id: member.id, name: member.name, email: member.email };
  res.redirect('/member/portal');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

router.get('/portal', requireMember, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const assignments = all(
    `SELECT a.*, cd.date, cd.status as cd_status, sc.service_time, sc.location, sc.area
     FROM assignments a
     JOIN communion_dates cd ON a.communion_date_id = cd.id
     JOIN slot_config sc ON a.slot_config_id = sc.id
     WHERE a.member_id = ? AND cd.date >= ?
     ORDER BY cd.date`,
    [req.session.member.id, today]
  );

  const openSignups = all(
    "SELECT * FROM communion_dates WHERE status = 'signup_open' AND date >= ? ORDER BY date",
    [today]
  );

  const pendingTrades = all(
    `SELECT t.*, r.name as requester_name, cd.date as communion_date,
       rs.service_time as req_service, rs.location as req_location, rs.area as req_area,
       ts.service_time as tgt_service, ts.location as tgt_location, ts.area as tgt_area
     FROM trades t
     JOIN members r ON t.requester_id = r.id
     JOIN assignments ra ON t.requester_assignment_id = ra.id
     JOIN assignments ta ON t.target_assignment_id = ta.id
     JOIN communion_dates cd ON ra.communion_date_id = cd.id
     JOIN slot_config rs ON ra.slot_config_id = rs.id
     JOIN slot_config ts ON ta.slot_config_id = ts.id
     WHERE t.target_id = ? AND t.status = 'pending'`,
    [req.session.member.id]
  );

  res.render('member/portal', {
    member: req.session.member,
    assignments,
    openSignups,
    pendingTrades,
    formatDate,
    formatCategory,
  });
});

router.get('/signup/:dateId', requireMember, (req, res) => {
  const cd = get('SELECT * FROM communion_dates WHERE id = ?', [req.params.dateId]);
  if (!cd || cd.status !== 'signup_open') {
    return res.redirect('/member/portal');
  }

  const slots = all('SELECT * FROM slot_config ORDER BY sort_order');
  const existingAssignment = get('SELECT * FROM assignments WHERE member_id = ? AND communion_date_id = ?',
    [req.session.member.id, cd.id]);
  const existingExclusions = all('SELECT * FROM exclusions WHERE member_id = ? AND communion_date_id = ?',
    [req.session.member.id, cd.id]);

  const slotData = slots.map(slot => {
    const assigned = all(
      `SELECT a.*, m.name FROM assignments a JOIN members m ON a.member_id = m.id
       WHERE a.communion_date_id = ? AND a.slot_config_id = ?`,
      [cd.id, slot.id]
    );
    return {
      ...slot,
      assigned,
      filled: assigned.length,
      available: slot.servers_needed - assigned.length,
    };
  });

  const serviceTimesAvail = [...new Set(slots.map(s => s.service_time))];
  const locationsAvail = [...new Set(slots.map(s => s.location))];

  res.render('member/signup', {
    member: req.session.member,
    cd,
    slots: slotData,
    existingAssignment,
    existingExclusions,
    formatDate,
    serviceTimes: serviceTimesAvail,
    locations: locationsAvail,
    success: req.query.success,
    error: req.query.error,
  });
});

router.post('/signup/:dateId/claim', requireMember, (req, res) => {
  const { slot_config_id } = req.body;
  const cd = get('SELECT * FROM communion_dates WHERE id = ?', [req.params.dateId]);
  if (!cd || cd.status !== 'signup_open') {
    return res.redirect('/member/portal');
  }

  const existing = get('SELECT * FROM assignments WHERE member_id = ? AND communion_date_id = ?',
    [req.session.member.id, cd.id]);
  if (existing) {
    return res.redirect('/member/signup/' + req.params.dateId + '?error=You are already signed up for this date');
  }

  const slot = get('SELECT * FROM slot_config WHERE id = ?', [slot_config_id]);
  const filled = get('SELECT COUNT(*) as c FROM assignments WHERE communion_date_id = ? AND slot_config_id = ?',
    [cd.id, slot_config_id]);
  if (filled.c >= slot.servers_needed) {
    return res.redirect('/member/signup/' + req.params.dateId + '?error=That slot is already full');
  }

  const member = get('SELECT * FROM members WHERE id = ?', [req.session.member.id]);
  run('INSERT INTO assignments (member_id, communion_date_id, slot_config_id, assignment_type, member_category_at_assignment) VALUES (?,?,?,?,?)',
    [req.session.member.id, cd.id, slot_config_id, 'voluntary', member.category]);

  run('DELETE FROM exclusions WHERE member_id = ? AND communion_date_id = ?',
    [req.session.member.id, cd.id]);

  res.redirect('/member/signup/' + req.params.dateId + '?success=You are signed up!');
});

router.post('/signup/:dateId/withdraw', requireMember, (req, res) => {
  run('DELETE FROM assignments WHERE member_id = ? AND communion_date_id = ? AND assignment_type = ?',
    [req.session.member.id, req.params.dateId, 'voluntary']);
  res.redirect('/member/signup/' + req.params.dateId + '?success=Signup withdrawn');
});

router.post('/signup/:dateId/exclude', requireMember, (req, res) => {
  const { exclusion_type, exclusion_value } = req.body;
  const cd = get('SELECT * FROM communion_dates WHERE id = ?', [req.params.dateId]);
  if (!cd || cd.status !== 'signup_open') {
    return res.redirect('/member/portal');
  }

  if (exclusion_type === 'full_day') {
    run('DELETE FROM exclusions WHERE member_id = ? AND communion_date_id = ?',
      [req.session.member.id, cd.id]);
    run('INSERT OR IGNORE INTO exclusions (member_id, communion_date_id, exclusion_type) VALUES (?,?,?)',
      [req.session.member.id, cd.id, 'full_day']);
  } else {
    run('INSERT OR IGNORE INTO exclusions (member_id, communion_date_id, exclusion_type, exclusion_value) VALUES (?,?,?,?)',
      [req.session.member.id, cd.id, exclusion_type, exclusion_value]);
  }

  res.redirect('/member/signup/' + req.params.dateId + '?success=Availability updated');
});

router.post('/signup/:dateId/remove-exclusion/:exId', requireMember, (req, res) => {
  run('DELETE FROM exclusions WHERE id = ? AND member_id = ?', [req.params.exId, req.session.member.id]);
  res.redirect('/member/signup/' + req.params.dateId + '?success=Exclusion removed');
});

router.get('/trades', requireMember, (req, res) => {
  const trades = all(
    `SELECT t.*,
       r.name as requester_name, tg.name as target_name,
       cd.date as communion_date,
       rs.service_time as req_service, rs.location as req_location, rs.area as req_area,
       ts.service_time as tgt_service, ts.location as tgt_location, ts.area as tgt_area
     FROM trades t
     JOIN members r ON t.requester_id = r.id
     JOIN members tg ON t.target_id = tg.id
     JOIN assignments ra ON t.requester_assignment_id = ra.id
     JOIN assignments ta ON t.target_assignment_id = ta.id
     JOIN communion_dates cd ON ra.communion_date_id = cd.id
     JOIN slot_config rs ON ra.slot_config_id = rs.id
     JOIN slot_config ts ON ta.slot_config_id = ts.id
     WHERE t.requester_id = ? OR t.target_id = ?
     ORDER BY t.created_at DESC`,
    [req.session.member.id, req.session.member.id]
  );
  res.render('member/trades', { member: req.session.member, trades, formatDate, success: req.query.success, error: req.query.error });
});

router.get('/propose-trade/:assignmentId', requireMember, (req, res) => {
  const myAssignment = get(
    `SELECT a.*, cd.date, cd.id as cd_id, sc.service_time, sc.location, sc.area
     FROM assignments a
     JOIN communion_dates cd ON a.communion_date_id = cd.id
     JOIN slot_config sc ON a.slot_config_id = sc.id
     WHERE a.id = ? AND a.member_id = ?`,
    [req.params.assignmentId, req.session.member.id]
  );
  if (!myAssignment) return res.redirect('/member/portal');

  const otherAssignments = all(
    `SELECT a.*, m.name, sc.service_time, sc.location, sc.area
     FROM assignments a
     JOIN members m ON a.member_id = m.id
     JOIN slot_config sc ON a.slot_config_id = sc.id
     WHERE a.communion_date_id = ? AND a.member_id != ?
     ORDER BY sc.sort_order, m.name`,
    [myAssignment.cd_id, req.session.member.id]
  );

  res.render('member/propose-trade', {
    member: req.session.member,
    myAssignment,
    otherAssignments,
    formatDate,
  });
});

router.post('/propose-trade', requireMember, async (req, res) => {
  const { my_assignment_id, target_assignment_id, message } = req.body;
  const myA = get('SELECT * FROM assignments WHERE id = ? AND member_id = ?', [my_assignment_id, req.session.member.id]);
  const targetA = get('SELECT * FROM assignments WHERE id = ?', [target_assignment_id]);
  if (!myA || !targetA) return res.redirect('/member/trades?error=Invalid assignment');

  const existing = get("SELECT * FROM trades WHERE requester_assignment_id = ? AND status = 'pending'", [my_assignment_id]);
  if (existing) return res.redirect('/member/trades?error=You already have a pending trade for this slot');

  run('INSERT INTO trades (requester_id, requester_assignment_id, target_id, target_assignment_id, message) VALUES (?,?,?,?,?)',
    [req.session.member.id, parseInt(my_assignment_id), targetA.member_id, parseInt(target_assignment_id), message || null]);

  const target = get('SELECT * FROM members WHERE id = ?', [targetA.member_id]);
  const cd = get('SELECT * FROM communion_dates WHERE id = ?', [myA.communion_date_id]);
  const mySlot = get('SELECT * FROM slot_config WHERE id = ?', [myA.slot_config_id]);
  const tgtSlot = get('SELECT * FROM slot_config WHERE id = ?', [targetA.slot_config_id]);
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  if (target) {
    await sendNotification(target, 'trade_proposed', {
      target_name: target.name,
      requester_name: req.session.member.name,
      communion_date: formatDate(cd.date),
      requester_slot: `${mySlot.service_time} — ${mySlot.location}${mySlot.area ? ' (' + mySlot.area + ')' : ''}`,
      target_slot: `${tgtSlot.service_time} — ${tgtSlot.location}${tgtSlot.area ? ' (' + tgtSlot.area + ')' : ''}`,
      message: message ? `<p><strong>Message:</strong> ${message}</p>` : '',
      trade_link: `${appUrl}/member/trades`,
    }, cd.id);
  }

  res.redirect('/member/trades?success=Trade proposed');
});

router.post('/trade/:id/accept', requireMember, async (req, res) => {
  const trade = get("SELECT * FROM trades WHERE id = ? AND target_id = ? AND status = 'pending'",
    [req.params.id, req.session.member.id]);
  if (!trade) return res.redirect('/member/trades?error=Trade not found');

  const reqA = get('SELECT * FROM assignments WHERE id = ?', [trade.requester_assignment_id]);
  const tgtA = get('SELECT * FROM assignments WHERE id = ?', [trade.target_assignment_id]);

  const tempSlot = reqA.slot_config_id;
  run('UPDATE assignments SET slot_config_id = ?, assignment_type = ? WHERE id = ?',
    [tgtA.slot_config_id, 'traded', reqA.id]);
  run('UPDATE assignments SET slot_config_id = ?, assignment_type = ? WHERE id = ?',
    [tempSlot, 'traded', tgtA.id]);

  run("UPDATE trades SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?", [trade.id]);

  const requester = get('SELECT * FROM members WHERE id = ?', [trade.requester_id]);
  const target = get('SELECT * FROM members WHERE id = ?', [trade.target_id]);
  const cd = get('SELECT * FROM communion_dates WHERE id = ?', [reqA.communion_date_id]);
  const newReqSlot = get('SELECT * FROM slot_config WHERE id = ?', [tgtA.slot_config_id]);
  const newTgtSlot = get('SELECT * FROM slot_config WHERE id = ?', [tempSlot]);
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  if (requester) {
    await sendNotification(requester, 'trade_accepted', {
      name: requester.name,
      communion_date: formatDate(cd.date),
      service_time: newReqSlot.service_time,
      location: newReqSlot.location,
      area: newReqSlot.area ? ' — ' + newReqSlot.area : '',
      portal_link: `${appUrl}/member/portal`,
    }, cd.id);
  }
  if (target) {
    await sendNotification(target, 'trade_accepted', {
      name: target.name,
      communion_date: formatDate(cd.date),
      service_time: newTgtSlot.service_time,
      location: newTgtSlot.location,
      area: newTgtSlot.area ? ' — ' + newTgtSlot.area : '',
      portal_link: `${appUrl}/member/portal`,
    }, cd.id);
  }

  const admins = all('SELECT * FROM admins');
  for (const admin of admins) {
    await sendEmail(admin.email,
      'Communion Slot Trade Accepted',
      `<p><strong>${requester?.name}</strong> and <strong>${target?.name}</strong> have traded slots for communion on <strong>${formatDate(cd.date)}</strong>.</p>`,
      `${requester?.name} and ${target?.name} have traded slots for communion on ${formatDate(cd.date)}.`
    );
  }

  res.redirect('/member/trades?success=Trade accepted');
});

router.post('/trade/:id/decline', requireMember, async (req, res) => {
  const trade = get("SELECT * FROM trades WHERE id = ? AND target_id = ? AND status = 'pending'",
    [req.params.id, req.session.member.id]);
  if (!trade) return res.redirect('/member/trades?error=Trade not found');

  run("UPDATE trades SET status = 'declined', resolved_at = datetime('now') WHERE id = ?", [trade.id]);

  const requester = get('SELECT * FROM members WHERE id = ?', [trade.requester_id]);
  const cd = get(
    'SELECT cd.* FROM communion_dates cd JOIN assignments a ON a.communion_date_id = cd.id WHERE a.id = ?',
    [trade.requester_assignment_id]
  );

  if (requester && cd) {
    await sendNotification(requester, 'trade_declined', {
      name: requester.name,
      communion_date: formatDate(cd.date),
      other_name: req.session.member.name,
      portal_link: `${process.env.APP_URL || 'http://localhost:3000'}/member/portal`,
    }, cd.id);
  }

  res.redirect('/member/trades?success=Trade declined');
});

router.post('/trade/:id/cancel', requireMember, (req, res) => {
  run("UPDATE trades SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ? AND requester_id = ? AND status = 'pending'",
    [req.params.id, req.session.member.id]);
  res.redirect('/member/trades?success=Trade cancelled');
});

router.get('/history', requireMember, (req, res) => {
  const history = getServiceHistory(req.session.member.id, 12);
  res.render('member/history', { member: req.session.member, history, formatDate, formatCategory });
});

router.get('/profile', requireMember, (req, res) => {
  const member = get('SELECT * FROM members WHERE id = ?', [req.session.member.id]);
  res.render('member/profile', { member, success: req.query.success, error: req.query.error });
});

router.post('/profile', requireMember, (req, res) => {
  const { phone, notify_email, notify_sms, new_password } = req.body;
  run('UPDATE members SET phone=?, notify_email=?, notify_sms=? WHERE id=?',
    [phone || null, notify_email ? 1 : 0, notify_sms ? 1 : 0, req.session.member.id]);
  if (new_password) {
    run('UPDATE members SET password_hash = ? WHERE id = ?',
      [bcrypt.hashSync(new_password, 10), req.session.member.id]);
  }
  res.redirect('/member/profile?success=Profile updated');
});

module.exports = router;
