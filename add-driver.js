// Usage: node add-driver.js email password FirstName   (creates a verified driver)
const { createUser } = require('./server');
const [email, password, first] = process.argv.slice(2);
if (!email || !password || password.length < 8) { console.log('Usage: node add-driver.js email password(8+) FirstName'); process.exit(1); }
createUser({ email, password, role: 'driver', first: first || 'Driver', last: 'Driver', phone: '+1 555 010 0100', license_no: 'D0000001', license_exp: '2030-01-01', verified: true });
console.log('Created', email);
