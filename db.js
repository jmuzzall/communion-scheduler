const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'communion.db');

let db;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  initSchema();
  save();
  return db;
}

function save() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, buffer);
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function initSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_super INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS admin_invite_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    password_hash TEXT,
    category TEXT NOT NULL CHECK(category IN ('active_elder','active_deacon','inactive_elder','inactive_deacon')),
    notify_email INTEGER DEFAULT 1,
    notify_sms INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS magic_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS slot_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_time TEXT NOT NULL,
    location TEXT NOT NULL,
    area TEXT,
    servers_needed INTEGER NOT NULL,
    sort_order INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS communion_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    signup_opens TEXT NOT NULL,
    reminder_date TEXT NOT NULL,
    assignment_date TEXT NOT NULL,
    status TEXT DEFAULT 'upcoming' CHECK(status IN ('upcoming','signup_open','assigned','completed'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    communion_date_id INTEGER NOT NULL,
    slot_config_id INTEGER NOT NULL,
    assignment_type TEXT NOT NULL CHECK(assignment_type IN ('voluntary','auto','traded')),
    member_category_at_assignment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
    FOREIGN KEY (communion_date_id) REFERENCES communion_dates(id),
    FOREIGN KEY (slot_config_id) REFERENCES slot_config(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    communion_date_id INTEGER NOT NULL,
    exclusion_type TEXT NOT NULL CHECK(exclusion_type IN ('full_day','service_time','location')),
    exclusion_value TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
    FOREIGN KEY (communion_date_id) REFERENCES communion_dates(id),
    UNIQUE(member_id, communion_date_id, exclusion_type, exclusion_value)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL,
    requester_assignment_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    target_assignment_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
    message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (requester_id) REFERENCES members(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES members(id) ON DELETE CASCADE,
    FOREIGN KEY (requester_assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
    FOREIGN KEY (target_assignment_id) REFERENCES assignments(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notification_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_key TEXT UNIQUE NOT NULL,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    body_text TEXT NOT NULL,
    description TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    communion_date_id INTEGER,
    notification_type TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('email','sms')),
    status TEXT DEFAULT 'sent' CHECK(status IN ('sent','failed','pending')),
    error_message TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL,
    FOREIGN KEY (communion_date_id) REFERENCES communion_dates(id)
  )`);

  seedDefaults();
  runMigrations();
}

function runMigrations() {
  const cols = (table) => {
    const result = db.exec(`PRAGMA table_info(${table})`);
    if (!result.length) return [];
    return result[0].values.map(r => r[1]);
  };

  if (!cols('members').includes('preferred_location')) {
    db.run('ALTER TABLE members ADD COLUMN preferred_location TEXT');
  }

  if (!cols('exclusions').includes('reason')) {
    db.run('ALTER TABLE exclusions ADD COLUMN reason TEXT');
  }

  const hasMcLean = get("SELECT COUNT(*) as c FROM slot_config WHERE location LIKE 'McLean%'");
  if (!hasMcLean || hasMcLean.c === 0) {
    const mcLeanSlots = [
      ['8:45 AM', 'McLean Fellowship Hall', null, 6, 1],
      ['8:45 AM', 'McLean Sanctuary', 'Main Sanctuary', 8, 2],
      ['8:45 AM', 'McLean Sanctuary', 'Balcony', 2, 3],
      ['11:15 AM', 'McLean Fellowship Hall', null, 6, 4],
      ['11:15 AM', 'McLean Sanctuary', 'Main Sanctuary', 8, 5],
    ];
    for (const [time, loc, area, needed, order] of mcLeanSlots) {
      db.run('INSERT INTO slot_config (service_time, location, area, servers_needed, sort_order) VALUES (?,?,?,?,?)',
        [time, loc, area, needed, order]);
    }
  }

  const hasHerndon = get("SELECT COUNT(*) as c FROM slot_config WHERE location LIKE 'Herndon%'");
  if (!hasHerndon || hasHerndon.c === 0) {
    db.run('INSERT INTO slot_config (service_time, location, area, servers_needed, sort_order) VALUES (?,?,?,?,?)',
      ['10:45 AM', 'Herndon Sanctuary', null, 5, 6]);
  }

  save();
}

function seedDefaults() {
  const hasSlots = get('SELECT COUNT(*) as c FROM slot_config');
  if (hasSlots && hasSlots.c === 0) {
    const slots = [
      ['8:45 AM', 'McLean Fellowship Hall', null, 6, 1],
      ['8:45 AM', 'McLean Sanctuary', 'Main Sanctuary', 8, 2],
      ['8:45 AM', 'McLean Sanctuary', 'Balcony', 2, 3],
      ['11:15 AM', 'McLean Fellowship Hall', null, 6, 4],
      ['11:15 AM', 'McLean Sanctuary', 'Main Sanctuary', 8, 5],
      ['10:45 AM', 'Herndon Sanctuary', null, 5, 6],
    ];
    for (const [time, loc, area, needed, order] of slots) {
      db.run('INSERT INTO slot_config (service_time, location, area, servers_needed, sort_order) VALUES (?,?,?,?,?)',
        [time, loc, area, needed, order]);
    }
  }

  const hasTemplates = get('SELECT COUNT(*) as c FROM notification_templates');
  if (hasTemplates && hasTemplates.c === 0) {
    const templates = [
      ['signup_notice', 'Communion Server Signup Now Open',
        '<p>Dear {{name}},</p><p>The signup window for communion service on <strong>{{communion_date}}</strong> is now open. Please visit the link below to sign up for a slot or mark any dates you are unavailable.</p><p><a href="{{signup_link}}">Sign Up Now</a></p><p>Slots available:</p><ul>{{slot_summary}}</ul><p>Thank you for serving!</p>',
        'Dear {{name}},\n\nThe signup window for communion service on {{communion_date}} is now open. Please visit {{signup_link}} to sign up.\n\nThank you for serving!',
        'Sent 3 weeks before communion when signup window opens'],
      ['signup_reminder', 'Reminder: Communion Server Signup',
        '<p>Dear {{name}},</p><p>This is a reminder that communion service signup for <strong>{{communion_date}}</strong> is still open. There are <strong>{{open_slots}}</strong> slots remaining.</p><p><a href="{{signup_link}}">Sign Up Now</a></p><p>The signup window closes on {{deadline}}.</p>',
        'Dear {{name}},\n\nReminder: Communion signup for {{communion_date}} is still open. {{open_slots}} slots remaining. Visit {{signup_link}} to sign up.\n\nDeadline: {{deadline}}',
        'Sent 2 weeks before communion as a reminder'],
      ['assignment_notice', 'Your Communion Service Assignment',
        '<p>Dear {{name}},</p><p>You have been assigned to serve communion on <strong>{{communion_date}}</strong>.</p><p><strong>Service:</strong> {{service_time}}<br><strong>Location:</strong> {{location}}{{area}}</p><p>If you are unable to serve, you may propose a trade with another server through the app.</p><p><a href="{{portal_link}}">View Your Assignment</a></p>',
        'Dear {{name}},\n\nYou have been assigned to serve communion on {{communion_date}}.\n\nService: {{service_time}}\nLocation: {{location}}{{area}}\n\nView your assignment: {{portal_link}}',
        'Sent after auto-assignment on the Friday before communion'],
      ['trade_proposed', 'Communion Slot Trade Request',
        '<p>Dear {{target_name}},</p><p><strong>{{requester_name}}</strong> has proposed a slot trade for communion on <strong>{{communion_date}}</strong>.</p><p><strong>Their slot:</strong> {{requester_slot}}<br><strong>Your slot:</strong> {{target_slot}}</p>{{message}}<p><a href="{{trade_link}}">Review Trade Request</a></p>',
        'Dear {{target_name}},\n\n{{requester_name}} has proposed a slot trade for communion on {{communion_date}}.\n\nTheir slot: {{requester_slot}}\nYour slot: {{target_slot}}\n\nReview: {{trade_link}}',
        'Sent when a member proposes a trade'],
      ['trade_accepted', 'Communion Slot Trade Accepted',
        '<p>Dear {{name}},</p><p>The slot trade for communion on <strong>{{communion_date}}</strong> has been accepted.</p><p><strong>Your new assignment:</strong><br>Service: {{service_time}}<br>Location: {{location}}{{area}}</p><p><a href="{{portal_link}}">View Updated Assignment</a></p>',
        'Dear {{name}},\n\nThe slot trade for communion on {{communion_date}} has been accepted.\n\nYour new assignment:\nService: {{service_time}}\nLocation: {{location}}{{area}}\n\nView: {{portal_link}}',
        'Sent to both parties when a trade is accepted'],
      ['trade_declined', 'Communion Slot Trade Declined',
        '<p>Dear {{name}},</p><p>Your proposed slot trade for communion on <strong>{{communion_date}}</strong> with {{other_name}} has been declined.</p><p>Your original assignment remains unchanged.</p><p><a href="{{portal_link}}">View Your Assignment</a></p>',
        'Dear {{name}},\n\nYour proposed slot trade for communion on {{communion_date}} with {{other_name}} has been declined. Your assignment is unchanged.\n\nView: {{portal_link}}',
        'Sent when a trade is declined'],
    ];
    for (const [key, subject, html, text, desc] of templates) {
      db.run('INSERT INTO notification_templates (template_key, subject, body_html, body_text, description) VALUES (?,?,?,?,?)',
        [key, subject, html, text, desc]);
    }
  }

  const hasAdmin = get('SELECT COUNT(*) as c FROM admins');
  if (hasAdmin && hasAdmin.c === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run('INSERT INTO admins (name, email, password_hash, is_super) VALUES (?,?,?,1)',
      ['Administrator', 'admin@mcleanpres.org', hash]);
  }
}

function generateCommunionDates(year) {
  const dates = [];
  for (let month = 0; month < 12; month++) {
    let d = new Date(year, month, 1);
    while (d.getDay() !== 0) {
      d.setDate(d.getDate() + 1);
    }
    const communionDate = new Date(d);
    const signupOpens = new Date(communionDate);
    signupOpens.setDate(signupOpens.getDate() - 21);
    const reminderDate = new Date(communionDate);
    reminderDate.setDate(reminderDate.getDate() - 14);
    const assignmentDate = new Date(communionDate);
    assignmentDate.setDate(assignmentDate.getDate() - 8);
    while (assignmentDate.getDay() !== 5) {
      assignmentDate.setDate(assignmentDate.getDate() - 1);
    }

    const fmt = (dt) => dt.toISOString().split('T')[0];
    const existing = get('SELECT id FROM communion_dates WHERE date = ?', [fmt(communionDate)]);
    if (!existing) {
      db.run('INSERT INTO communion_dates (date, signup_opens, reminder_date, assignment_date) VALUES (?,?,?,?)',
        [fmt(communionDate), fmt(signupOpens), fmt(reminderDate), fmt(assignmentDate)]);
    }
    dates.push(fmt(communionDate));
  }
  save();
  return dates;
}

function getCategoryPriority(category) {
  const order = { active_elder: 1, active_deacon: 2, inactive_elder: 3, inactive_deacon: 4 };
  return order[category] || 99;
}

function formatCategory(cat) {
  const labels = {
    active_elder: 'Active Elder',
    active_deacon: 'Active Deacon',
    inactive_elder: 'Inactive Elder',
    inactive_deacon: 'Inactive Deacon'
  };
  return labels[cat] || cat;
}

module.exports = { getDb, save, run, get, all, generateCommunionDates, getCategoryPriority, formatCategory };
