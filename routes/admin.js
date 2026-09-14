const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const ExcelJS = require('exceljs');
const { requireAdmin } = require('../middleware/auth');
const { get, all, run, generateCommunionDates, formatCategory } = require('../db');
const { autoAssign, getServiceCounts } = require('../services/scheduler');
const { sendNotification, sendEmail } = require('../services/mailer');
const { sendAssignmentNotices, formatDate, checkAndSendReminders } = require('../services/reminderScheduler');

const upload = multer({ storage: multer.memoryStorage() });

router.get('/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const admin = get('SELECT * FROM admins WHERE email = ?', [email]);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.render('admin/login', { error: 'Invalid email or password' });
  }
  req.session.admin = { id: admin.id, email: admin.email, name: admin.name, is_super: admin.is_super };
  res.redirect('/admin/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

router.get('/dashboard', requireAdmin, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const upcoming = all("SELECT * FROM communion_dates WHERE date >= ? ORDER BY date LIMIT 3", [today]);
  const totalMembers = get('SELECT COUNT(*) as c FROM members');
  const slots = all('SELECT * FROM slot_config ORDER BY sort_order');
  const totalSlots = slots.reduce((sum, s) => sum + s.servers_needed, 0);

  const stats = upcoming.map(cd => {
    const filled = get('SELECT COUNT(*) as c FROM assignments WHERE communion_date_id = ?', [cd.id]);
    const pending = all("SELECT COUNT(*) as c FROM trades WHERE status = 'pending' AND requester_assignment_id IN (SELECT id FROM assignments WHERE communion_date_id = ?)", [cd.id]);
    return {
      ...cd,
      dateFormatted: formatDate(cd.date),
      filled: filled?.c || 0,
      total: totalSlots,
      pendingTrades: pending[0]?.c || 0,
    };
  });

  res.render('admin/dashboard', {
    admin: req.session.admin,
    stats,
    totalMembers: totalMembers?.c || 0,
    totalSlots,
  });
});

router.get('/roster', requireAdmin, (req, res) => {
  const members = all('SELECT * FROM members ORDER BY category, name');
  res.render('admin/roster', { admin: req.session.admin, members, formatCategory, success: req.query.success, error: req.query.error });
});

router.post('/roster/add', requireAdmin, (req, res) => {
  const { name, email, phone, category } = req.body;
  try {
    run('INSERT INTO members (name, email, phone, category) VALUES (?,?,?,?)', [name, email, phone || null, category]);
    res.redirect('/admin/roster?success=Member added');
  } catch (e) {
    res.redirect('/admin/roster?error=' + encodeURIComponent(e.message));
  }
});

router.post('/roster/edit/:id', requireAdmin, (req, res) => {
  const { name, email, phone, category } = req.body;
  run('UPDATE members SET name=?, email=?, phone=?, category=? WHERE id=?', [name, email, phone || null, category, req.params.id]);
  res.redirect('/admin/roster?success=Member updated');
});

router.post('/roster/delete/:id', requireAdmin, (req, res) => {
  run('DELETE FROM members WHERE id = ?', [req.params.id]);
  res.redirect('/admin/roster?success=Member removed');
});

router.post('/roster/import', requireAdmin, upload.single('csv'), (req, res) => {
  try {
    const content = req.file.buffer.toString('utf-8');
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    let added = 0;
    for (const r of records) {
      const name = r.name || r.Name;
      const email = r.email || r.Email;
      const phone = r.phone || r.Phone || null;
      const category = r.category || r.Category || 'active_elder';
      if (name && email) {
        try {
          run('INSERT INTO members (name, email, phone, category) VALUES (?,?,?,?)', [name, email, phone, category]);
          added++;
        } catch (e) { /* duplicate */ }
      }
    }
    res.redirect('/admin/roster?success=' + encodeURIComponent(`${added} members imported`));
  } catch (e) {
    res.redirect('/admin/roster?error=' + encodeURIComponent(e.message));
  }
});

router.get('/schedule', requireAdmin, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const communionDates = all('SELECT * FROM communion_dates ORDER BY date DESC');
  const selectedId = req.query.date_id || (communionDates.find(d => d.date >= today) || communionDates[0])?.id;
  const selected = selectedId ? get('SELECT * FROM communion_dates WHERE id = ?', [selectedId]) : null;

  const slots = all('SELECT * FROM slot_config ORDER BY sort_order');
  let schedule = [];
  if (selected) {
    schedule = slots.map(slot => {
      const assigned = all(
        `SELECT a.*, m.name, m.email, m.category
         FROM assignments a JOIN members m ON a.member_id = m.id
         WHERE a.communion_date_id = ? AND a.slot_config_id = ?
         ORDER BY m.name`,
        [selected.id, slot.id]
      );
      return { slot, assigned, needed: slot.servers_needed, filled: assigned.length };
    });
  }

  res.render('admin/schedule', {
    admin: req.session.admin,
    communionDates,
    selected,
    schedule,
    formatCategory,
    formatDate,
    success: req.query.success,
    error: req.query.error,
  });
});

router.post('/schedule/generate-dates', requireAdmin, (req, res) => {
  const year = parseInt(req.body.year) || new Date().getFullYear();
  generateCommunionDates(year);
  const nextYear = year + 1;
  generateCommunionDates(nextYear);
  res.redirect('/admin/schedule?success=' + encodeURIComponent(`Communion dates generated for ${year} and ${nextYear}`));
});

router.post('/schedule/auto-assign/:id', requireAdmin, async (req, res) => {
  try {
    const cd = get('SELECT * FROM communion_dates WHERE id = ?', [req.params.id]);
    const newAssignments = autoAssign(parseInt(req.params.id));
    if (req.body.notify === 'on') {
      await sendAssignmentNotices(cd, newAssignments);
    }
    res.redirect('/admin/schedule?date_id=' + req.params.id + '&success=' + encodeURIComponent(`${newAssignments.length} members auto-assigned`));
  } catch (e) {
    res.redirect('/admin/schedule?date_id=' + req.params.id + '&error=' + encodeURIComponent(e.message));
  }
});

router.post('/schedule/assign', requireAdmin, (req, res) => {
  const { member_id, communion_date_id, slot_config_id } = req.body;
  const member = get('SELECT * FROM members WHERE id = ?', [member_id]);
  run('INSERT INTO assignments (member_id, communion_date_id, slot_config_id, assignment_type, member_category_at_assignment) VALUES (?,?,?,?,?)',
    [member_id, communion_date_id, slot_config_id, 'voluntary', member?.category]);
  res.redirect('/admin/schedule?date_id=' + communion_date_id + '&success=Assignment added');
});

router.post('/schedule/unassign/:id', requireAdmin, (req, res) => {
  const assignment = get('SELECT * FROM assignments WHERE id = ?', [req.params.id]);
  run('DELETE FROM assignments WHERE id = ?', [req.params.id]);
  res.redirect('/admin/schedule?date_id=' + (assignment?.communion_date_id || '') + '&success=Assignment removed');
});

router.get('/schedule/export', requireAdmin, async (req, res) => {
  const { start, end, date_id } = req.query;
  let assignments;
  if (date_id) {
    assignments = all(
      `SELECT a.*, m.name, m.email, m.phone, m.category, cd.date, sc.service_time, sc.location, sc.area
       FROM assignments a
       JOIN members m ON a.member_id = m.id
       JOIN communion_dates cd ON a.communion_date_id = cd.id
       JOIN slot_config sc ON a.slot_config_id = sc.id
       WHERE a.communion_date_id = ?
       ORDER BY cd.date, sc.sort_order, m.name`, [date_id]);
  } else {
    const startDate = start || '2000-01-01';
    const endDate = end || '2099-12-31';
    assignments = all(
      `SELECT a.*, m.name, m.email, m.phone, m.category, cd.date, sc.service_time, sc.location, sc.area
       FROM assignments a
       JOIN members m ON a.member_id = m.id
       JOIN communion_dates cd ON a.communion_date_id = cd.id
       JOIN slot_config sc ON a.slot_config_id = sc.id
       WHERE cd.date BETWEEN ? AND ?
       ORDER BY cd.date, sc.sort_order, m.name`, [startDate, endDate]);
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Communion Schedule');
  ws.columns = [
    { header: 'Communion Date', key: 'date', width: 15 },
    { header: 'Service Time', key: 'service_time', width: 12 },
    { header: 'Location', key: 'location', width: 25 },
    { header: 'Area', key: 'area', width: 18 },
    { header: 'Member Name', key: 'name', width: 22 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Assignment Type', key: 'assignment_type', width: 16 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Phone', key: 'phone', width: 16 },
  ];

  ws.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3A5C' } };
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
  });

  assignments.forEach((a, i) => {
    const row = ws.addRow({
      date: a.date,
      service_time: a.service_time,
      location: a.location,
      area: a.area || '',
      name: a.name,
      category: formatCategory(a.category || a.member_category_at_assignment),
      assignment_type: a.assignment_type,
      email: a.email,
      phone: a.phone || '',
    });
    if (i % 2 === 1) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4F8' } };
      });
    }
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=communion_schedule.xlsx');
  await wb.xlsx.write(res);
});

router.get('/history', requireAdmin, (req, res) => {
  const completed = all("SELECT * FROM communion_dates WHERE status = 'completed' ORDER BY date DESC");
  const selectedId = req.query.date_id || (completed[0]?.id);
  const selected = selectedId ? get('SELECT * FROM communion_dates WHERE id = ?', [selectedId]) : null;

  let schedule = [];
  if (selected) {
    const slots = all('SELECT * FROM slot_config ORDER BY sort_order');
    schedule = slots.map(slot => {
      const assigned = all(
        `SELECT a.*, m.name, m.email, m.category
         FROM assignments a JOIN members m ON a.member_id = m.id
         WHERE a.communion_date_id = ? AND a.slot_config_id = ?
         ORDER BY m.name`,
        [selected.id, slot.id]
      );
      return { slot, assigned };
    });
  }

  res.render('admin/history', {
    admin: req.session.admin,
    completed,
    selected,
    schedule,
    formatCategory,
    formatDate,
  });
});

router.get('/trades', requireAdmin, (req, res) => {
  const trades = all(
    `SELECT t.*,
       r.name as requester_name, tg.name as target_name,
       ra.slot_config_id as req_slot_id, ta.slot_config_id as tgt_slot_id,
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
     ORDER BY t.created_at DESC`
  );
  res.render('admin/trades', { admin: req.session.admin, trades, formatDate });
});

router.get('/templates', requireAdmin, (req, res) => {
  const templates = all('SELECT * FROM notification_templates ORDER BY template_key');
  res.render('admin/templates', { admin: req.session.admin, templates, success: req.query.success });
});

router.post('/templates/edit/:id', requireAdmin, (req, res) => {
  const { subject, body_html, body_text } = req.body;
  run('UPDATE notification_templates SET subject=?, body_html=?, body_text=?, updated_at=datetime("now") WHERE id=?',
    [subject, body_html, body_text, req.params.id]);
  res.redirect('/admin/templates?success=Template updated');
});

router.get('/notifications', requireAdmin, (req, res) => {
  const logs = all(
    `SELECT nl.*, m.name, m.email, cd.date as communion_date
     FROM notification_log nl
     LEFT JOIN members m ON nl.member_id = m.id
     LEFT JOIN communion_dates cd ON nl.communion_date_id = cd.id
     ORDER BY nl.sent_at DESC LIMIT 100`
  );
  res.render('admin/notifications', { admin: req.session.admin, logs, formatDate });
});

router.get('/send-reminder', requireAdmin, (req, res) => {
  const members = all('SELECT * FROM members ORDER BY name');
  const communionDates = all("SELECT * FROM communion_dates WHERE status IN ('upcoming','signup_open') ORDER BY date");
  res.render('admin/send-reminder', { admin: req.session.admin, members, communionDates, formatDate, success: req.query.success });
});

router.post('/send-reminder', requireAdmin, async (req, res) => {
  const { subject, message, recipients, communion_date_id } = req.body;
  let targets;
  if (recipients === 'all') {
    targets = all('SELECT * FROM members');
  } else if (['active_elder', 'active_deacon', 'inactive_elder', 'inactive_deacon'].includes(recipients)) {
    targets = all('SELECT * FROM members WHERE category = ?', [recipients]);
  } else {
    targets = all('SELECT * FROM members WHERE id = ?', [recipients]);
  }

  for (const m of targets) {
    if (m.notify_email && m.email) {
      await sendEmail(m.email, subject, `<p>${message.replace(/\n/g, '</p><p>')}</p>`, message);
      run('INSERT INTO notification_log (member_id, communion_date_id, notification_type, channel, status) VALUES (?,?,?,?,?)',
        [m.id, communion_date_id || null, 'custom', 'email', 'sent']);
    }
  }

  res.redirect('/admin/send-reminder?success=' + encodeURIComponent(`Reminder sent to ${targets.length} member(s)`));
});

router.get('/fairness', requireAdmin, (req, res) => {
  const counts = getServiceCounts(12);
  res.render('admin/fairness', { admin: req.session.admin, counts, formatCategory });
});

router.post('/trigger-reminders', requireAdmin, async (req, res) => {
  await checkAndSendReminders();
  res.redirect('/admin/dashboard?success=Reminder check triggered');
});

router.post('/open-signups/:dateId', requireAdmin, (req, res) => {
  const cd = get('SELECT * FROM communion_dates WHERE id = ?', [req.params.dateId]);
  if (!cd) return res.redirect('/admin/schedule?error=Date not found');
  const newStatus = cd.status === 'upcoming' ? 'signup_open' : 'upcoming';
  run('UPDATE communion_dates SET status = ? WHERE id = ?', [newStatus, cd.id]);
  res.redirect(`/admin/schedule?date_id=${cd.id}&success=Status changed to ${newStatus}`);
});

router.get('/settings', requireAdmin, (req, res) => {
  const slots = all('SELECT * FROM slot_config ORDER BY sort_order');
  const admins = all('SELECT id, name, email, is_super FROM admins ORDER BY name');
  res.render('admin/settings', { admin: req.session.admin, slots, admins, success: req.query.success, error: req.query.error });
});

router.post('/settings/slot/edit/:id', requireAdmin, (req, res) => {
  const { servers_needed } = req.body;
  run('UPDATE slot_config SET servers_needed = ? WHERE id = ?', [parseInt(servers_needed), req.params.id]);
  res.redirect('/admin/settings?success=Slot updated');
});

router.post('/settings/change-password', requireAdmin, (req, res) => {
  const { current_password, new_password } = req.body;
  const admin = get('SELECT * FROM admins WHERE id = ?', [req.session.admin.id]);
  if (!bcrypt.compareSync(current_password, admin.password_hash)) {
    return res.redirect('/admin/settings?error=Current password incorrect');
  }
  run('UPDATE admins SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(new_password, 10), admin.id]);
  res.redirect('/admin/settings?success=Password changed');
});

router.post('/settings/invite-admin', requireAdmin, (req, res) => {
  const { name, email } = req.body;
  const hash = bcrypt.hashSync('changeme' + Date.now(), 10);
  try {
    run('INSERT INTO admins (name, email, password_hash) VALUES (?,?,?)', [name, email, hash]);
    res.redirect('/admin/settings?success=Admin added — they should change their password on first login');
  } catch (e) {
    res.redirect('/admin/settings?error=' + encodeURIComponent(e.message));
  }
});

module.exports = router;
