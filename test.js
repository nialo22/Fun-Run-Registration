// Self-check for the core flow: `node test.js`
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'funrun-'));
process.env.ADMIN_PASSWORD = 'test-password';
process.env.PORT = '0';
const server = require('./server.js');

(async () => {
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, res, text, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null };
  };

  const race = { name: 'Test Run', date: '2999-01-01', venue: 'City Park', categories: [{ name: '5K', fee: '500', slots: 1 }] };
  const runner = catId => ({
    firstName: 'Ana', lastName: '=Cruz', email: 'ana@example.com', phone: '0917 123 4567', birthdate: '1995-04-02',
    sex: 'Female', shirtSize: 'M', categoryId: catId, emergencyName: 'Ben Cruz', emergencyPhone: '0918 765 4321', waiver: true,
  });

  // Organizer routes are locked without a session.
  assert.equal((await call('POST', '/api/admin/events', race)).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  const login = await call('POST', '/api/login', { password: 'test-password' });
  assert.equal(login.status, 200);
  cookie = login.res.headers.get('set-cookie').split(';')[0];

  const made = await call('POST', '/api/admin/events', race);
  assert.equal(made.status, 201);
  const { id, categories: [cat] } = made.json;
  assert.equal((await call('POST', '/api/admin/events', { ...race, categories: [] })).status, 400);

  // The public sees the race and can register once; the single slot then fills.
  cookie = '';
  assert.equal((await call('GET', '/api/events')).json[0].name, 'Test Run');
  assert.equal((await call('POST', `/api/events/${id}/register`, { ...runner(cat.id), waiver: false })).status, 400);
  assert.equal((await call('POST', `/api/events/${id}/register`, { ...runner(cat.id), email: 'nope' })).status, 400);
  const first = await call('POST', `/api/events/${id}/register`, runner(cat.id));
  assert.equal(first.status, 201);
  assert.equal(first.json.bib, 1); // the two rejected forms above did not burn a bib number
  assert.equal((await call('POST', `/api/events/${id}/register`, runner(cat.id))).status, 409);
  assert.equal((await call('GET', `/api/events/${id}`)).json.categories[0].taken, 1);

  // Runner details are organizer-only, and the CSV defuses spreadsheet formulas.
  assert.equal((await call('GET', `/api/admin/events/${id}/registrations`)).status, 401);
  cookie = login.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', `/api/admin/events/${id}/registrations`)).json.registrations[0].category, '5K');
  assert.ok((await call('GET', `/api/admin/events/${id}/registrations.csv`)).text.includes(`"'=Cruz"`));

  // A category with runners can't be dropped; a passed deadline closes registration.
  assert.equal((await call('PUT', `/api/admin/events/${id}`, { ...race, categories: [{ name: '10K' }] })).status, 400);
  const closed = await call('PUT', `/api/admin/events/${id}`, { ...race, deadline: '2000-01-01', categories: [{ ...cat, slots: 0 }] });
  assert.equal(closed.json.open, false);
  assert.equal((await call('POST', `/api/events/${id}/register`, runner(cat.id))).status, 400);

  // Data survives a restart.
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'), 'utf8')).registrations.length, 1);

  console.log('All checks passed.');
  server.close();
})().catch(err => { console.error(err); process.exit(1); });
