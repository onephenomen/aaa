'use strict';
// Amaze Relay: Driver App backend. Node 22.5+, no dependencies.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB || path.join(__dirname, 'flexdrive.db'));
db.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('admin','manager','driver')), first TEXT, last TEXT, phone TEXT,
  license_no TEXT, license_exp TEXT, verified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS loads(id INTEGER PRIMARY KEY, city TEXT, state TEXT, station TEXT, start TEXT, end TEXT,
  total REAL, per_block REAL, blocks INTEGER, hours TEXT, team INTEGER DEFAULT 0, drivers INTEGER DEFAULT 1,
  truck TEXT, equipment TEXT, status TEXT NOT NULL DEFAULT 'available' CHECK(status IN('available','booked')), is_demo INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, driver_id INTEGER NOT NULL REFERENCES users(id),
  load_id INTEGER NOT NULL REFERENCES loads(id), status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN('upcoming','cancelled')), created INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_load ON bookings(load_id) WHERE status='upcoming';
CREATE TABLE IF NOT EXISTS favorites(driver_id INTEGER NOT NULL REFERENCES users(id), load_id INTEGER NOT NULL REFERENCES loads(id), PRIMARY KEY(driver_id,load_id));
CREATE TABLE IF NOT EXISTS support(id INTEGER PRIMARY KEY, driver_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, created INTEGER);
`);

// ---------- helpers ----------
const hashPw = (pw) => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, stored) => { const [s, h] = stored.split(':'); const x = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DUMMY = hashPw('dummy-password-for-timing');
const digits = (v) => String(v || '').replace(/\D/g, '');
try { db.exec('ALTER TABLE users ADD COLUMN phone_digits TEXT'); } catch {} // migration for databases created before sign-up existed
try { db.exec('ALTER TABLE bookings ADD COLUMN approved INTEGER NOT NULL DEFAULT 1'); } catch {} // migration for databases created before admin approval existed; existing bookings stay approved
for (const u of db.prepare('SELECT id,phone FROM users WHERE phone_digits IS NULL').all()) db.prepare('UPDATE users SET phone_digits=? WHERE id=?').run(digits(u.phone), u.id);
const regs = new Map();
const cookieFor = (req, uid) => { const tok = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(sha(tok), uid, Date.now() + 8 * 3600e3); return `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`; };
function createUser(o) {
  const r = db.prepare('INSERT INTO users(email,pass,role,first,last,phone,license_no,license_exp,verified,phone_digits) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(o.email.toLowerCase(), hashPw(o.password), o.role, o.first || '', o.last || '', o.phone || '', o.license_no || '', o.license_exp || '', o.verified ? 1 : 0, digits(o.phone));
  return Number(r.lastInsertRowid);
}
function createLoad(l) {
  const r = db.prepare('INSERT INTO loads(city,state,station,start,end,total,per_block,blocks,hours,team,drivers,truck,equipment,is_demo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(l.city, l.state, l.station || '', l.start, l.end, l.total, l.per_block, l.blocks, l.hours || '', l.team ? 1 : 0, l.drivers || 1, l.truck || '', l.equipment || '', l.is_demo ? 1 : 0);
  return Number(r.lastInsertRowid);
}
const send = (res, code, obj, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...h }); res.end(JSON.stringify(obj)); };
const readJson = (req) => new Promise((ok, no) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 10000) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('json')); } }); });
const cookie = (req, n) => ((req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).find((a) => a[0] === n) || [])[1];
const authUser = (req) => { const t = cookie(req, 'sid'); if (!t) return null; return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(sha(t), Date.now()) || null; };
const loadJson = (l) => ({ id: l.id, city: l.city, state: l.state, station: l.station, start: l.start, end: l.end, total: l.total, perBlock: l.per_block, blocks: l.blocks, hours: l.hours, team: !!l.team, drivers: l.drivers, truck: l.truck, equipment: l.equipment, available: l.status === 'available', demo: !!l.is_demo });
const bookingJson = (b) => { const now = Date.now(); let status = b.bstatus; if (status === 'upcoming') { if (!b.approved) status = 'pending'; else if (now > Date.parse(b.end)) status = 'completed'; else if (now >= Date.parse(b.start)) status = 'in_progress'; } return { id: b.bid, status, approved: !!b.approved, createdAt: b.created, load: loadJson(b) }; };
const BK = 'SELECT l.*, b.id AS bid, b.status AS bstatus, b.created AS created, b.approved AS approved FROM bookings b JOIN loads l ON l.id=b.load_id';
const fails = new Map();
const STATIC = { '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/sw.js': ['sw.js', 'text/javascript'], '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'], '/logo.svg': ['logo.svg', 'image/svg+xml'], '/logo-mark.svg': ['logo-mark.svg', 'image/svg+xml'], '/empty-truck.png': ['empty-truck.png', 'image/png'] };

// ---------- request handler ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  const html = (file) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" }); res.end(fs.readFileSync(path.join(__dirname, 'public', file))); };
  if (m === 'GET' && p === '/') return html('index.html');
  if (m === 'GET' && p === '/admin/login') return html('admin-login.html');
  if (m === 'GET' && STATIC[p]) { res.writeHead(200, { 'Content-Type': STATIC[p][1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', STATIC[p][0]))); }
  if (m === 'GET' && p === '/admin') { // admin UI shell: only for signed-in staff
    const a = authUser(req);
    if (!a) { res.writeHead(302, { Location: '/admin/login' }); return res.end(); }
    if (a.role !== 'admin' && a.role !== 'manager') return send(res, 403, { error: 'Forbidden' });
    return html('admin.html');
  }
  if (!p.startsWith('/api/') && !p.startsWith('/admin')) return send(res, 404, { error: 'Not found' });
  if (m !== 'GET') { // CSRF: custom header (cannot be sent cross-site without CORS, which we never enable) + origin check
    const o = req.headers.origin, fwd = req.headers['x-forwarded-host'], ok = [req.headers.host, fwd, ...(process.env.TRUSTED_HOSTS || '').split(',')].filter(Boolean);
    let bad = req.headers['x-requested-with'] !== 'flexdrive' ? 'missing X-Requested-With header' : '';
    if (!bad && o) { try { if (!ok.includes(new URL(o).host)) bad = 'origin not trusted'; } catch { bad = 'bad origin'; } }
    if (bad) { console.log(`[blocked ${m} ${p}] ${bad} | origin=${o} host=${req.headers.host} x-forwarded-host=${fwd}`); return send(res, 403, { error: 'Forbidden' }); }
  }
  let body = {};
  if (m !== 'GET' && m !== 'DELETE') { try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid request.' }); } }

  if (p === '/api/login' && m === 'POST') {
    const email = String(body.email || '').toLowerCase().slice(0, 200), pw = String(body.password || '').slice(0, 200), key = req.socket.remoteAddress + '|' + email;
    const f = fails.get(key) || { n: 0, t: Date.now() }; if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 5) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    let u;
    if (email.includes('@')) u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    else { const d = digits(email); if (d.length >= 7) { const rows = db.prepare('SELECT * FROM users WHERE phone_digits=?').all(d); if (rows.length === 1) u = rows[0]; } }
    const ok = checkPw(pw, u ? u.pass : DUMMY) && u;
    if (!ok) { f.n++; fails.set(key, f); return send(res, 401, { error: 'Incorrect email or password.' }); }
    fails.delete(key);
    const tok = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(sha(tok), u.id, Date.now() + 8 * 3600e3);
    return send(res, 200, { id: u.id, role: u.role, first: u.first }, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` });
  }
  if (p === '/api/register' && m === 'POST') {
    const ip = req.socket.remoteAddress, now = Date.now(), g = regs.get(ip) || { n: 0, t: now };
    if (now - g.t > 3600e3) { g.n = 0; g.t = now; }
    regs.set(ip, g); if (++g.n > 10) return send(res, 429, { error: 'Too many sign-up attempts. Try again later.' });
    if (body.website) return send(res, 400, { error: 'Invalid request.' }); // honeypot field, humans leave it empty
    const t = (v, n) => typeof v === 'string' && v.trim().length > 0 && v.length <= n, email = String(body.email || '').trim().toLowerCase(), phone = String(body.phone || '').trim();
    if (body.acceptTerms !== true) return send(res, 400, { error: 'Please accept the terms to continue.' });
    if (!t(body.first, 60) || !t(body.last, 60)) return send(res, 400, { error: 'Enter your first and last name.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return send(res, 400, { error: 'Enter a valid email address.' });
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 100) return send(res, 400, { error: 'Password must be 8 to 100 characters.' });
    if (phone && !/^[+0-9 ()-]{5,25}$/.test(phone)) return send(res, 400, { error: 'Enter a valid mobile number.' });
    if (!t(body.licenseNo, 40) || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.licenseExp || '')) || isNaN(Date.parse(body.licenseExp))) return send(res, 400, { error: 'Enter your license number and expiration date.' });
    if (digits(phone).length >= 7 && db.prepare('SELECT 1 FROM users WHERE phone_digits=?').get(digits(phone))) return send(res, 409, { error: 'This mobile number is already registered.' });
    let id; try { id = createUser({ email, password: body.password, role: 'driver', first: body.first.trim(), last: body.last.trim(), phone, license_no: body.licenseNo.trim(), license_exp: body.licenseExp, verified: false }); } catch { return send(res, 409, { error: 'An account with this email already exists.' }); }
    return send(res, 201, { id, role: 'driver', first: body.first.trim() }, { 'Set-Cookie': cookieFor(req, id) });
  }
  const user = authUser(req);
  if (!user) return send(res, 401, { error: 'Your session has expired. Please sign in.' });
  if (p === '/api/logout' && m === 'POST') { db.prepare('DELETE FROM sessions WHERE token=?').run(sha(cookie(req, 'sid'))); return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }

  // ----- admin zone: enforced here, independent of any UI -----
  if (p.startsWith('/api/admin') || p.startsWith('/admin')) {
    if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Forbidden' });
    const isAdmin = user.role === 'admin', one = (sql, ...a) => db.prepare(sql).get(...a);
    if (p === '/api/admin/stats' && m === 'GET') return send(res, 200, {
      drivers: one("SELECT COUNT(*) n FROM users WHERE role='driver'").n, verified: one("SELECT COUNT(*) n FROM users WHERE role='driver' AND verified=1").n,
      loadsAvailable: one("SELECT COUNT(*) n FROM loads WHERE status='available'").n, loadsBooked: one("SELECT COUNT(*) n FROM loads WHERE status='booked'").n,
      bookingsUpcoming: one("SELECT COUNT(*) n FROM bookings WHERE status='upcoming' AND approved=1").n, bookingsPending: one("SELECT COUNT(*) n FROM bookings WHERE status='upcoming' AND approved=0").n, bookedValue: one("SELECT COALESCE(SUM(l.total),0) n FROM bookings b JOIN loads l ON l.id=b.load_id WHERE b.status='upcoming'").n, supportRequests: one('SELECT COUNT(*) n FROM support').n });
    if (p === '/api/admin/drivers' && m === 'GET') return send(res, 200, db.prepare("SELECT id,email,first,last,phone,license_no AS licenseNo,license_exp AS licenseExp,verified,(SELECT COUNT(*) FROM bookings WHERE driver_id=users.id AND status='upcoming') AS bookings FROM users WHERE role='driver' ORDER BY id DESC").all());
    if (p === '/api/admin/drivers' && m === 'POST') {
      const t = (v, n) => typeof v === 'string' && v.trim().length > 0 && v.length <= n, email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200 || !t(body.password, 100) || body.password.length < 8 || !t(body.first, 60) || !t(body.last, 60) || (body.licenseExp && !/^\d{4}-\d{2}-\d{2}$/.test(body.licenseExp))) return send(res, 400, { error: 'Check email, password (8+ characters), names and license date.' });
      try { return send(res, 201, { id: createUser({ email, password: body.password, role: 'driver', first: body.first.trim(), last: body.last.trim(), phone: String(body.phone || '').slice(0, 25), license_no: String(body.licenseNo || '').slice(0, 40), license_exp: body.licenseExp || '', verified: false }) }); }
      catch { return send(res, 409, { error: 'This email is already in use.' }); }
    }
    let r;
    if ((r = p.match(/^\/api\/admin\/drivers\/(\d+)\/(verify|unverify)$/)) && m === 'POST') { if (!isAdmin) return send(res, 403, { error: 'Forbidden' }); db.prepare("UPDATE users SET verified=? WHERE id=? AND role='driver'").run(r[2] === 'verify' ? 1 : 0, +r[1]); return send(res, 200, { ok: true }); }
    if ((r = p.match(/^\/api\/admin\/drivers\/(\d+)\/reset-password$/)) && m === 'POST') {
      if (!isAdmin) return send(res, 403, { error: 'Forbidden' });
      const pw = String(body.password || ''); if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: 'Password must be 8 to 100 characters.' });
      if (!db.prepare("UPDATE users SET pass=? WHERE id=? AND role='driver'").run(hashPw(pw), +r[1]).changes) return send(res, 404, { error: 'Driver not found.' });
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(+r[1]); return send(res, 200, { ok: true });
    }
    if ((r = p.match(/^\/api\/admin\/drivers\/(\d+)$/)) && m === 'DELETE') {
      if (!isAdmin) return send(res, 403, { error: 'Forbidden' });
      const id = +r[1];
      if (!one("SELECT 1 FROM users WHERE id=? AND role='driver'", id)) return send(res, 404, { error: 'Driver not found.' });
      if (one('SELECT 1 FROM bookings WHERE driver_id=?', id)) return send(res, 409, { error: 'This driver has booking history and cannot be deleted. Deactivate the account instead by removing verification.' });
      if (one('SELECT 1 FROM support WHERE driver_id=?', id)) return send(res, 409, { error: 'This driver has support requests on file and cannot be deleted.' });
      db.exec('BEGIN IMMEDIATE');
      db.prepare('DELETE FROM favorites WHERE driver_id=?').run(id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      db.prepare("DELETE FROM users WHERE id=? AND role='driver'").run(id);
      db.exec('COMMIT');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/loads' && m === 'GET') return send(res, 200, db.prepare("SELECT l.*, (SELECT u.first||' '||u.last FROM bookings b JOIN users u ON u.id=b.driver_id WHERE b.load_id=l.id AND b.status='upcoming') AS booked_by FROM loads l ORDER BY l.start DESC").all().map((l) => ({ ...loadJson(l), status: l.status, bookedBy: l.booked_by })));
    if (p === '/api/admin/loads' && m === 'POST') {
      const n = (v) => Number.isFinite(+v) && +v >= 0 ? +v : null, s = (v) => typeof v === 'string' && v.length > 0 && v.length < 100;
      if (!s(body.city) || !s(body.state) || !body.start || !body.end || isNaN(Date.parse(body.start)) || isNaN(Date.parse(body.end)) || Date.parse(body.end) <= Date.parse(body.start) || n(body.total) === null || n(body.per_block) === null || !Number.isInteger(body.blocks) || body.blocks < 1) return send(res, 400, { error: 'Invalid load. Check the fields and dates.' });
      return send(res, 201, { id: createLoad({ ...body, is_demo: 0 }) });
    }
    if ((r = p.match(/^\/api\/admin\/loads\/(\d+)$/)) && m === 'DELETE') {
      if (one('SELECT 1 FROM bookings WHERE load_id=?', +r[1])) return send(res, 409, { error: 'This load has booking history and cannot be deleted.' });
      db.prepare('DELETE FROM favorites WHERE load_id=?').run(+r[1]); db.prepare('DELETE FROM loads WHERE id=?').run(+r[1]); return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/bookings' && m === 'GET') return send(res, 200, db.prepare("SELECT l.*, b.id AS bid, b.status AS bstatus, b.created AS created, b.approved AS approved, u.first||' '||u.last AS driver_name, u.email AS driver_email FROM bookings b JOIN loads l ON l.id=b.load_id JOIN users u ON u.id=b.driver_id ORDER BY b.id DESC").all().map((b) => ({ ...bookingJson(b), driver: b.driver_name, driverEmail: b.driver_email })));
    if ((r = p.match(/^\/api\/admin\/bookings\/(\d+)\/approve$/)) && m === 'POST') {
      const changed = db.prepare("UPDATE bookings SET approved=1 WHERE id=? AND status='upcoming' AND approved=0").run(+r[1]).changes;
      if (!changed) return send(res, 409, { error: 'Booking not found or already approved.' });
      return send(res, 200, { ok: true });
    }
    if ((r = p.match(/^\/api\/admin\/bookings\/(\d+)\/cancel$/)) && m === 'POST') {
      const b = one("SELECT * FROM bookings WHERE id=? AND status='upcoming'", +r[1]); if (!b) return send(res, 409, { error: 'Booking not found or already cancelled.' });
      db.exec('BEGIN IMMEDIATE'); db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(b.id); db.prepare("UPDATE loads SET status='available' WHERE id=?").run(b.load_id); db.exec('COMMIT'); return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/support' && m === 'GET') return send(res, 200, db.prepare("SELECT s.id,s.message,s.created,u.first||' '||u.last AS driver,u.email FROM support s JOIN users u ON u.id=s.driver_id ORDER BY s.id DESC").all());
    return send(res, 404, { error: 'Not found' });
  }

  // ----- driver zone: driver identity ALWAYS comes from the session -----
  if (user.role !== 'driver') return send(res, 403, { error: 'Forbidden' });
  const did = user.id;
  if (p === '/api/me' && m === 'GET') return send(res, 200, { id: did, first: user.first, last: user.last });

  if (p === '/api/loads' && m === 'GET') {
    const fav = new Set(db.prepare('SELECT load_id FROM favorites WHERE driver_id=?').all(did).map((r) => r.load_id));
    return send(res, 200, db.prepare("SELECT * FROM loads WHERE status='available' AND start>? ORDER BY start").all(new Date().toISOString()).map((l) => ({ ...loadJson(l), favorite: fav.has(l.id) })));
  }
  let r;
  if (p === '/api/bookings' && m === 'POST') {
    const lid = Number(body.loadId); if (!Number.isInteger(lid)) return send(res, 400, { error: 'Invalid request.' });
    if (!user.verified) return send(res, 403, { error: 'Your profile must be verified before you can book.' });
    if (!user.license_exp || user.license_exp < new Date().toISOString().slice(0, 10)) return send(res, 403, { error: 'Your driver’s license has expired.' });
    db.exec('BEGIN IMMEDIATE');
    try {
      const l = db.prepare('SELECT * FROM loads WHERE id=?').get(lid);
      if (!l) { db.exec('ROLLBACK'); return send(res, 404, { error: 'Load not found.' }); }
      if (db.prepare("SELECT 1 FROM bookings WHERE load_id=? AND driver_id=? AND status='upcoming'").get(lid, did)) { db.exec('ROLLBACK'); return send(res, 409, { error: 'You have already booked this load.' }); }
      if (db.prepare("UPDATE loads SET status='booked' WHERE id=? AND status='available'").run(lid).changes !== 1) { db.exec('ROLLBACK'); return send(res, 409, { error: 'This load is no longer available.' }); }
      const id = Number(db.prepare('INSERT INTO bookings(driver_id,load_id,created,approved) VALUES(?,?,?,0)').run(did, lid, Date.now()).lastInsertRowid);
      db.exec('COMMIT'); return send(res, 201, { id, status: 'pending' });
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} return send(res, 500, { error: 'Something went wrong. Please try again.' }); }
  }
  if (p === '/api/bookings' && m === 'GET') {
    const st = url.searchParams.get('status');
    return send(res, 200, db.prepare(BK + ' WHERE b.driver_id=? ORDER BY l.start').all(did).map(bookingJson).filter((b) => !st || b.status === st));
  }
  if ((r = p.match(/^\/api\/bookings\/(\d+)(\/cancel)?$/))) {
    const b = db.prepare(BK + ' WHERE b.id=? AND b.driver_id=?').get(+r[1], did); // ownership check
    if (!b) return send(res, 404, { error: 'Booking not found.' });
    if (!r[2] && m === 'GET') return send(res, 200, bookingJson(b));
    if (r[2] && m === 'POST') {
      if (!['upcoming', 'pending'].includes(bookingJson(b).status)) return send(res, 409, { error: 'This booking can no longer be cancelled.' });
      db.exec('BEGIN IMMEDIATE'); db.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND driver_id=?").run(b.bid, did); db.prepare("UPDATE loads SET status='available' WHERE id=?").run(b.id); db.exec('COMMIT');
      return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/favorites' && m === 'GET') return send(res, 200, db.prepare('SELECT l.* FROM favorites f JOIN loads l ON l.id=f.load_id WHERE f.driver_id=?').all(did).map((l) => ({ ...loadJson(l), favorite: true })));
  if ((r = p.match(/^\/api\/favorites\/(\d+)$/))) {
    if (m === 'PUT') { if (!db.prepare('SELECT 1 FROM loads WHERE id=?').get(+r[1])) return send(res, 404, { error: 'Load not found.' }); db.prepare('INSERT OR IGNORE INTO favorites(driver_id,load_id) VALUES(?,?)').run(did, +r[1]); return send(res, 200, { ok: true }); }
    if (m === 'DELETE') { db.prepare('DELETE FROM favorites WHERE driver_id=? AND load_id=?').run(did, +r[1]); return send(res, 200, { ok: true }); }
  }
  if (p === '/api/profile' && m === 'GET') return send(res, 200, { first: user.first, last: user.last, email: user.email, phone: user.phone, licenseNo: user.license_no, licenseExp: user.license_exp, verified: !!user.verified, licenseExpired: !user.license_exp || user.license_exp < new Date().toISOString().slice(0, 10) });
  if (p === '/api/profile' && m === 'PATCH') { // only phone + email are writable; role/verified/etc. are ignored
    const phone = String(body.phone ?? user.phone).trim(), email = String(body.email ?? user.email).trim().toLowerCase();
    if (!/^[+0-9 ()-]{5,25}$/.test(phone) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return send(res, 400, { error: 'Please check your phone number and email.' });
    try { db.prepare('UPDATE users SET phone=?,phone_digits=?,email=? WHERE id=?').run(phone, digits(phone), email, did); } catch { return send(res, 409, { error: 'This email is already in use.' }); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/support' && m === 'POST') { const t = String(body.message || '').trim(); if (t.length < 5 || t.length > 2000) return send(res, 400, { error: 'Please describe your issue (5–2000 characters).' }); db.prepare('INSERT INTO support(driver_id,message,created) VALUES(?,?,?)').run(did, t, Date.now()); return send(res, 201, { ok: true }); }
  if (p === '/api/support' && m === 'GET') return send(res, 200, db.prepare('SELECT id,message,created FROM support WHERE driver_id=? ORDER BY id DESC').all(did));
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Please try again.' }); }));
module.exports = { server, db, createUser, createLoad };
if (require.main === module) { const port = process.env.PORT || 3000; server.listen(port, () => console.log('Amaze Relay on http://localhost:' + port)); }
