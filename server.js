require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const { getDb, generateCommunionDates } = require('./db');
const { startReminderScheduler } = require('./services/reminderScheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'communion-scheduler-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));

app.use('/admin', require('./routes/admin'));
app.use('/member', require('./routes/member'));

app.get('/', (req, res) => {
  res.render('home');
});

async function start() {
  await getDb();

  const currentYear = new Date().getFullYear();
  generateCommunionDates(currentYear);
  generateCommunionDates(currentYear + 1);

  startReminderScheduler();

  app.listen(PORT, () => {
    console.log(`Communion Scheduler running on port ${PORT}`);
    console.log(`Admin login: http://localhost:${PORT}/admin/login`);
    console.log(`Member login: http://localhost:${PORT}/member/login`);
  });
}

start().catch(console.error);
