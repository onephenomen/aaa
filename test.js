process.env.DB = ':memory:';
const assert = require('assert');
const { server, createUser, createLoad } = require('./server');
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'flexdrive' };
let port, n = 0;
async function call(method, path, body, cookie) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j, c: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (e, p) => (await call('POST', '/api/login', { email: e, password: p })).c;
const t = async (name, fn) => { try { await fn(); n++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n    ', e.message); process.exitCode = 1; } };
(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); port = server.address().port;
  const future = (d, h = 6) => new Date(Date.now() + d * 864e5 + h * 36e5).toISOString();
  const mk = (city, d) => createLoad({ city, state: 'WA', start: future(d), end: future(d, 18), total: 500, per_block: 125, blocks: 4 });
  const L1 = mk('A', 1), L2 = mk('B', 2), L3 = mk('C', 3);
  createUser({ email: 'a@x.io', password: 'pwA-123456', role: 'driver', first: 'Ann', license_exp: '2030-01-01', verified: true });
  createUser({ email: 'b@x.io', password: 'pwB-123456', role: 'driver', first: 'Bob', license_exp: '2030-01-01', verified: true });
  createUser({ email: 'u@x.io', password: 'pwU-123456', role: 'driver', first: 'Una', license_exp: '2030-01-01', verified: false });
  createUser({ email: 'x@x.io', password: 'pwX-123456', role: 'driver', first: 'Old', license_exp: '2020-01-01', verified: true });
  createUser({ email: 'adm@x.io', password: 'pwM-123456', role: 'admin' });
  const A = await login('a@x.io', 'pwA-123456'), B = await login('b@x.io', 'pwB-123456'), ADM = await login('adm@x.io', 'pwM-123456');

  await t('wrong password rejected', async () => assert.equal((await call('POST', '/api/login', { email: 'a@x.io', password: 'nope' })).s, 401));
  await t('unauthenticated API gets 401', async () => assert.equal((await call('GET', '/api/loads')).s, 401));
  await t('mutation without CSRF header gets 403', async () => assert.equal((await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', body: '{}' })).status, 403));
  await t('driver sees available loads', async () => assert.equal((await call('GET', '/api/loads', null, A)).j.length, 3));
  await t('driver cannot call admin API (403)', async () => { assert.equal((await call('GET', '/api/admin/drivers', null, A)).s, 403); assert.equal((await call('POST', '/api/admin/loads', { city: 'x' }, A)).s, 403); assert.equal((await call('POST', '/api/admin/drivers/1/verify', null, A)).s, 403); });
  await t('driver cannot open /admin URL (403)', async () => assert.equal((await call('GET', '/admin', null, A)).s, 403));
  await t('anonymous /admin redirects to staff login', async () => { const r = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: 'manual' }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/admin/login'); });
  await t('admin can open /admin panel', async () => { const r = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { Cookie: ADM } }); assert.equal(r.status, 200); assert.ok((await r.text()).includes('Load Board')); });
  await t('admin can list drivers', async () => assert.equal((await call('GET', '/api/admin/drivers', null, ADM)).s, 200));
  await t('admin blocked from driver endpoints (strict separation)', async () => assert.equal((await call('GET', '/api/loads', null, ADM)).s, 403));
  await t('booking succeeds and is persisted', async () => { const r = await call('POST', '/api/bookings', { loadId: L1 }, A); assert.equal(r.s, 201); const l = await call('GET', '/api/bookings', null, A); assert.equal(l.j.length, 1); assert.equal(l.j[0].status, 'upcoming'); });
  await t('booked load disappears from load board', async () => assert.equal((await call('GET', '/api/loads', null, B)).j.some((x) => x.id === L1), false));
  await t('other driver booking same load gets 409', async () => assert.equal((await call('POST', '/api/bookings', { loadId: L1 }, B)).s, 409));
  await t('duplicate booking by same driver gets 409', async () => assert.equal((await call('POST', '/api/bookings', { loadId: L1 }, A)).s, 409));
  await t('concurrent booking: exactly one winner', async () => { const r = await Promise.all([call('POST', '/api/bookings', { loadId: L2 }, A), call('POST', '/api/bookings', { loadId: L2 }, B)]); assert.deepEqual(r.map((x) => x.s).sort(), [201, 409]); });
  await t('client-supplied driverId is ignored', async () => { const r = await call('POST', '/api/bookings', { loadId: L3, driverId: 1, status: 'completed', total: 1 }, B); assert.equal(r.s, 201); const mine = (await call('GET', '/api/bookings', null, B)).j; assert.ok(mine.some((x) => x.load.id === L3 && x.status === 'upcoming')); assert.equal(mine.find((x) => x.load.id === L3).load.total, 500); });
  await t('driver A cannot read driver B booking (404)', async () => { const bid = (await call('GET', '/api/bookings', null, B)).j.find((x) => x.load.id === L3).id; assert.equal((await call('GET', '/api/bookings/' + bid, null, A)).s, 404); });
  await t('driver A cannot cancel driver B booking (404)', async () => { const bid = (await call('GET', '/api/bookings', null, B)).j.find((x) => x.load.id === L3).id; assert.equal((await call('POST', `/api/bookings/${bid}/cancel`, null, A)).s, 404); });
  await t('My Bookings lists only own bookings', async () => { const a = (await call('GET', '/api/bookings', null, A)).j; assert.ok(a.every((x) => [L1, L2, L3].includes(x.load.id))); assert.ok(!a.some((x) => x.load.id === L3)); });
  await t('cancel frees the load', async () => { const bid = (await call('GET', '/api/bookings', null, A)).j.find((x) => x.load.id === L1).id; assert.equal((await call('POST', `/api/bookings/${bid}/cancel`, null, A)).s, 200); assert.ok((await call('GET', '/api/loads', null, B)).j.some((x) => x.id === L1)); assert.equal((await call('GET', '/api/bookings?status=cancelled', null, A)).j.length, 1); });
  await t('favorites are private per driver', async () => { assert.equal((await call('PUT', '/api/favorites/' + L1, null, A)).s, 200); assert.equal((await call('GET', '/api/favorites', null, A)).j.length, 1); assert.equal((await call('GET', '/api/favorites', null, B)).j.length, 0); assert.equal((await call('DELETE', '/api/favorites/' + L1, null, A)).s, 200); assert.equal((await call('GET', '/api/favorites', null, A)).j.length, 0); });
  await t('profile: only phone/email editable, role & verified ignored', async () => { const u = await login('u@x.io', 'pwU-123456'); assert.equal((await call('PATCH', '/api/profile', { phone: '+1 555 000 1111', verified: true, role: 'admin', license_no: 'ZZZ' }, u)).s, 200); const p = (await call('GET', '/api/profile', null, u)).j; assert.equal(p.verified, false); assert.equal(p.phone, '+1 555 000 1111'); assert.equal((await call('GET', '/api/admin/drivers', null, u)).s, 403); });
  await t('unverified driver cannot book', async () => { const u = await login('u@x.io', 'pwU-123456'); assert.equal((await call('POST', '/api/bookings', { loadId: L1 }, u)).s, 403); });
  await t('driver with expired license cannot book', async () => { const x = await login('x@x.io', 'pwX-123456'); assert.equal((await call('POST', '/api/bookings', { loadId: L1 }, x)).s, 403); });
  await t('support requests are private', async () => { assert.equal((await call('POST', '/api/support', { message: 'Need help with booking' }, A)).s, 201); assert.equal((await call('GET', '/api/support', null, A)).j.length, 1); assert.equal((await call('GET', '/api/support', null, B)).j.length, 0); });

  createUser({ email: 'mgr@x.io', password: 'pwG-123456', role: 'manager' });
  const MGR = await login('mgr@x.io', 'pwG-123456');
  await t('driver blocked from every new admin endpoint', async () => { for (const [m, u] of [['GET', '/api/admin/stats'], ['GET', '/api/admin/loads'], ['GET', '/api/admin/bookings'], ['GET', '/api/admin/support'], ['POST', '/api/admin/drivers'], ['DELETE', '/api/admin/loads/1'], ['POST', '/api/admin/bookings/1/cancel']]) assert.equal((await call(m, u, null, A)).s, 403, u); });
  await t('admin stats and listings work', async () => { assert.equal((await call('GET', '/api/admin/stats', null, ADM)).j.drivers, 4); assert.ok((await call('GET', '/api/admin/loads', null, ADM)).j.length >= 3); assert.ok((await call('GET', '/api/admin/bookings', null, ADM)).j.length >= 1); });
  await t('admin creates driver who starts unverified and cannot book', async () => { const r = await call('POST', '/api/admin/drivers', { email: 'new@x.io', password: 'longpass1', first: 'New', last: 'Guy', licenseExp: '2030-01-01' }, ADM); assert.equal(r.s, 201); const c = await login('new@x.io', 'longpass1'); assert.equal((await call('GET', '/api/profile', null, c)).j.verified, false); assert.equal((await call('POST', '/api/bookings', { loadId: L1 }, c)).s, 403); });
  await t('admin create driver rejects weak password and duplicate email', async () => { assert.equal((await call('POST', '/api/admin/drivers', { email: 'w@x.io', password: 'short', first: 'a', last: 'b' }, ADM)).s, 400); assert.equal((await call('POST', '/api/admin/drivers', { email: 'new@x.io', password: 'longpass1', first: 'a', last: 'b' }, ADM)).s, 409); });
  await t('only admin (not manager) can verify; verified driver can then book', async () => { const id = (await call('GET', '/api/admin/drivers', null, ADM)).j.find((d) => d.email === 'new@x.io').id; assert.equal((await call('POST', `/api/admin/drivers/${id}/verify`, null, MGR)).s, 403); assert.equal((await call('POST', `/api/admin/drivers/${id}/verify`, null, ADM)).s, 200); const c = await login('new@x.io', 'longpass1'); assert.equal((await call('POST', '/api/bookings', { loadId: L1 }, c)).s, 201); });
  await t('manager can read admin data', async () => assert.equal((await call('GET', '/api/admin/stats', null, MGR)).s, 200));
  await t('admin cannot delete a load with booking history; can delete a fresh one', async () => { assert.equal((await call('DELETE', '/api/admin/loads/' + L1, null, ADM)).s, 409); const n = await call('POST', '/api/admin/loads', { city: 'Z', state: 'WA', start: future(5), end: future(5, 10), total: 100, per_block: 50, blocks: 2 }, ADM); assert.equal(n.s, 201); assert.equal((await call('DELETE', '/api/admin/loads/' + n.j.id, null, ADM)).s, 200); });
  await t('admin load validation rejects end before start', async () => assert.equal((await call('POST', '/api/admin/loads', { city: 'Z', state: 'WA', start: future(5, 10), end: future(5), total: 1, per_block: 1, blocks: 1 }, ADM)).s, 400));
  await t('admin can cancel a booking and the load frees up', async () => { const b = (await call('GET', '/api/admin/bookings', null, ADM)).j.find((x) => x.status === 'upcoming'); assert.equal((await call('POST', `/api/admin/bookings/${b.id}/cancel`, null, ADM)).s, 200); assert.equal((await call('POST', `/api/admin/bookings/${b.id}/cancel`, null, ADM)).s, 409); });
  await t('PWA files are served publicly', async () => { for (const u of ['/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/admin/login']) assert.equal((await fetch(`http://127.0.0.1:${port}${u}`)).status, 200, u); });

  const REG = { first: 'Sam', last: 'Rider', email: 'sam@x.io', phone: '+1 (555) 222-3344', password: 'samPass123', licenseNo: 'L777', licenseExp: '2031-01-01', acceptTerms: true };
  await t('registration creates an unverified DRIVER and signs in; role in payload is ignored', async () => { const r = await call('POST', '/api/register', { ...REG, role: 'admin', verified: true }); assert.equal(r.s, 201); assert.equal(r.j.role, 'driver'); const p = await call('GET', '/api/profile', null, r.c); assert.equal(p.s, 200); assert.equal(p.j.verified, false); assert.equal((await call('GET', '/api/admin/stats', null, r.c)).s, 403); assert.equal((await call('POST', '/api/bookings', { loadId: L1 }, r.c)).s, 403); });
  await t('registration validates input', async () => { for (const bad of [{ acceptTerms: false }, { password: 'short' }, { email: 'nope' }, { first: '' }, { licenseExp: 'tomorrow' }, { licenseNo: '' }]) assert.equal((await call('POST', '/api/register', { ...REG, email: 'v@x.io', phone: '', ...bad })).s, 400, JSON.stringify(bad)); });
  await t('registration rejects duplicate email and phone', async () => { assert.equal((await call('POST', '/api/register', REG)).s, 409); assert.equal((await call('POST', '/api/register', { ...REG, email: 'other@x.io' })).s, 409); });
  await t('honeypot field blocks bots', async () => assert.equal((await call('POST', '/api/register', { ...REG, email: 'bot@x.io', phone: '', website: 'http://spam' })).s, 400));
  await t('sign in works with email (any case) and with mobile number', async () => { assert.ok(await login('SAM@x.io', 'samPass123')); assert.ok(await login('+1 555 222 3344', 'samPass123')); assert.equal((await call('POST', '/api/login', { email: '5552223344', password: 'wrong-pass' })).s, 401); });
  await t('admin resets a driver password (manager cannot); old password and sessions stop working', async () => { const id = (await call('GET', '/api/admin/drivers', null, ADM)).j.find((d) => d.email === 'sam@x.io').id; const old = await login('sam@x.io', 'samPass123'); assert.equal((await call('POST', `/api/admin/drivers/${id}/reset-password`, { password: 'newPass9999' }, MGR)).s, 403); assert.equal((await call('POST', `/api/admin/drivers/${id}/reset-password`, { password: 'short' }, ADM)).s, 400); assert.equal((await call('POST', `/api/admin/drivers/${id}/reset-password`, { password: 'newPass9999' }, ADM)).s, 200); assert.equal((await call('GET', '/api/profile', null, old)).s, 401); assert.equal((await call('POST', '/api/login', { email: 'sam@x.io', password: 'samPass123' })).s, 401); assert.ok(await login('sam@x.io', 'newPass9999')); assert.equal((await call('POST', `/api/admin/drivers/${id}/reset-password`, { password: 'newPass9999' }, A)).s, 403); });
  await t('sign-up is rate limited', async () => { let hit = false; for (let i = 0; i < 12; i++) if ((await call('POST', '/api/register', { ...REG, email: `r${i}@x.io`, phone: '' , acceptTerms: false })).s === 429) hit = true; assert.ok(hit); });
  await t('logout invalidates session', async () => { assert.equal((await call('POST', '/api/logout', null, B)).s, 200); assert.equal((await call('GET', '/api/loads', null, B)).s, 401); });
  server.close(); console.log(`\n${n} passed`);
})();
