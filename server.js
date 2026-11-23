require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const { getDb } = require('./db');
const { signupRouter } = require('./routes/signup');
const { adminScheduleRouter } = require('./routes/adminSchedule');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.FLY_APP_NAME && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set when running on Fly.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'mpc-officer-service-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));

app.use(require('./core/auth').loadPerson);

app.use('/admin/people', require('./routes/people'));
app.use('/admin/import', require('./routes/import'));
app.use('/admin/board', require('./routes/board'));
app.use('/admin/communion', adminScheduleRouter('communion'));
app.use('/admin/prayer', adminScheduleRouter('prayer'));
app.use('/admin/duty', require('./routes/adminDuty'));
app.use('/admin/duty', adminScheduleRouter('duty'));
app.use('/communion', signupRouter('communion'));
app.use('/prayer', signupRouter('prayer'));
app.use('/duty/specials', signupRouter('duty', { base: '/duty/specials', special: true }));
app.use('/duty', require('./routes/duty'));
app.use('/swaps', require('./routes/swaps'));
app.use('/', require('./routes/hub'));

async function start() {
  await getDb();
  require('./core/calendar').ensureSundays(15);
  require('./core/calendar').ensureCommunionEvents(15);
  require('./core/calendar').ensureWeeklyEvents('prayer', 15);
  require('./core/reminders').startReminders();

  app.listen(PORT, () => {
    const staging = require('./core/staging');
    console.log(`MPC Officer Service running on port ${PORT}${staging.isStaging() ? ' (staging: testers only)' : ''}`);
    console.log(`Sign in: http://localhost:${PORT}/signin`);
    console.log(`[Mailer] Sending email via ${require('./services/mailer').mailMethod()}`);
  });
}

start().catch(err => { console.error(err); process.exit(1); });
