require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const { getDb, generateCommunionDates } = require('./db');
const { startReminderScheduler } = require('./services/reminderScheduler');

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
app.use('/', require('./routes/hub'));

// Communion pages from communion-scheduler, kept until the Communion module moves onto the shared model.
app.use('/admin', require('./routes/admin'));
app.use('/member', require('./routes/member'));

async function start() {
  await getDb();
  require('./core/calendar').ensureSundays(15);

  const currentYear = new Date().getFullYear();
  generateCommunionDates(currentYear);
  generateCommunionDates(currentYear + 1);

  startReminderScheduler();

  app.listen(PORT, () => {
    const staging = require('./core/staging');
    console.log(`MPC Officer Service running on port ${PORT}${staging.isStaging() ? ' (staging: testers only)' : ''}`);
    console.log(`Sign in: http://localhost:${PORT}/signin`);
  });
}

start().catch(console.error);
