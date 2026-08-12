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

app.use('/', authRoutes);
app.use('/', requireLogin, dashboardRoutes);
app.use('/customers', requireLogin, customerRoutes);
app.use('/equipment', requireLogin, equipmentRoutes);
app.use('/calibrations', requireLogin, calibrationRoutes);
app.use('/search', requireLogin, searchRoutes);

app.listen(PORT, () => {
  console.log(`Calibration Tracker running at http://localhost:${PORT}`);
  console.log(`Login with ADMIN_USER/ADMIN_PASS from .env (defaults: admin / admin123)`);
  startScheduler();
});