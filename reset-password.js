// Usage: node reset-password.js email newPassword   (password 8+ characters)
// Works on the existing flexdrive.db, keeps all other data. Restart the server afterwards to clear the login-attempt limit.
const path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const [email, pw] = process.argv.slice(2);
if (!email || !pw || pw.length < 8) { console.log('Usage: node reset-password.js email newPassword(8+ characters)'); process.exit(1); }
const db = new DatabaseSync(process.env.DB || path.join(__dirname, 'flexdrive.db'));
const salt = crypto.randomBytes(16), hash = salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const r = db.prepare('UPDATE users SET pass=? WHERE email=?').run(hash, email.toLowerCase());
if (!r.changes) { console.log('No user with email', email, '\nExisting users:', db.prepare('SELECT email, role FROM users').all().map((u) => u.email + ' (' + u.role + ')').join(', ')); process.exit(1); }
db.prepare('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=?)').run(email.toLowerCase());
console.log('Password updated for', email);
