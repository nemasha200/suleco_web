require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

require('./db'); // initializes DB + tables on startup

const { startScheduler } = require('./utils/scheduler');
const { requireLogin } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const customerRoutes = require('./routes/customers');
const equipmentRoutes = require('./routes/equipment');
const calibrationRoutes = require('./routes/calibrations');
const publicRoutes = require('./routes/public');
const searchRoutes = require('./routes/search');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'calibration-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
}));

// Public QR landing page — mounted BEFORE the requireLogin routes on purpose.
// A phone scanning an equipment sticker has no admin session, so /q/:token
// must stay reachable without one. Everything below this line still requires
// a login exactly as before.
app.use('/', publicRoutes);

app.use('/', authRoutes);
app.use('/', requireLogin, dashboardRoutes);
app.use('/customers', requireLogin, customerRoutes);
app.use('/equipment', requireLogin, equipmentRoutes);
app.use('/calibrations', requireLogin, calibrationRoutes);
app.use('/search', requireLogin, searchRoutes);

// Listening on 0.0.0.0 (rather than just localhost) is what lets a phone on
// the same WiFi actually open the link inside a scanned QR code.
app.listen(PORT, '0.0.0.0', () => {
  const { getBaseUrl } = require('./utils/baseUrl');
  console.log(`Calibration Tracker running at http://localhost:${PORT}`);
  console.log(`Login with ADMIN_USER/ADMIN_PASS from .env (defaults: admin / admin123)`);
  console.log(`QR codes will point to: ${getBaseUrl(null)}`);
  console.log(`(Set PUBLIC_BASE_URL in .env if that address is wrong.)`);
  startScheduler();
});