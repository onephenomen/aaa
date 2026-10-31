// Creates DEMO data. Usage: node seed.js [driverPassword] [adminPassword]  (random passwords are printed once if omitted)
const crypto = require('crypto');
const { createUser, createLoad, db } = require('./server');
const pw = () => crypto.randomBytes(9).toString('base64url');
const driver = process.argv[2] || pw(), admin = process.argv[3] || pw(), day = 864e5, d = (n, h) => new Date(Date.now() + n * day + h * 36e5).toISOString();
if (!db.prepare("SELECT 1 FROM users WHERE email='admin@example.com'").get()) {
  createUser({ email: 'admin@example.com', password: admin, role: 'admin', first: 'Admin' });
  createUser({ email: 'driver@example.com', password: driver, role: 'driver', first: 'Alex', last: 'Driver', phone: '+1 555 010 0199', license_no: 'D1234567', license_exp: '2030-05-14', verified: true });
  [['Seattle', 'WA', 'DSE4', 1, 0, 36, 640, 160, 4, '6:00–18:00', 0, 1, '26 ft box truck', 'Liftgate, straps'],
   ['Portland', 'OR', 'DPD2', 2, 5, 12, 410, 205, 2, '5:30–17:30', 1, 2, '53 ft trailer', 'Pallet jack, E-track'],
   ['Tacoma', 'WA', 'DTA1', 3, 7, 8, 280, 140, 2, '7:00–15:00', 0, 1, '16 ft box truck', 'Dolly']].forEach((a) =>
    createLoad({ city: a[0], state: a[1], station: a[2], start: d(a[3], a[4]), end: d(a[3], a[4] + a[5]), total: a[6], per_block: a[7], blocks: a[8], hours: a[9], team: a[10], drivers: a[11], truck: a[12], equipment: a[13], is_demo: 1 }));
  console.log('DEMO accounts (shown once):\n admin@example.com  /', admin, '\n driver@example.com /', driver);
} else console.log('Already seeded.');
