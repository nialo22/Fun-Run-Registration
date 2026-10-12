// Fun run registration site. No dependencies: `node server.js`
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PW_FILE = path.join(DATA_DIR, 'admin-password.txt');
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.ADMIN_PASSWORD && !fs.existsSync(PW_FILE)) fs.writeFileSync(PW_FILE, crypto.randomBytes(9).toString('base64url'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || fs.readFileSync(PW_FILE, 'utf8').trim();
if (!ADMIN_PASSWORD) throw new Error(`Organizer password is empty. Set ADMIN_PASSWORD or put one in ${PW_FILE}`);

// ponytail: the whole store is one JSON file rewritten on each change. Fine for a few
// thousand registrations on one server process; switch to node:sqlite past that.
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : { events: [], registrations: [] };
function save() {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE); // atomic, so a crash mid-write can't corrupt the store
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEXES = ['Female', 'Male', 'Other'];
const SHIRTS = ['XS', 'S', 'M', 'L', 'XL', '2XL'];
const uid = () => crypto.randomBytes(6).toString('base64url');
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in server local time; set TZ when hosting
const fail = (status, error) => Object.assign(new Error(error), { status });

function text(v, label, max = 200) {
  if (typeof v !== 'string' || !v.trim()) throw fail(400, `${label} is required.`);
  if (v.length > max) throw fail(400, `${label} is too long.`);
  return v.trim();
}
const opt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const oneOf = (v, list, label) => {
  if (!list.includes(v)) throw fail(400, `Choose a ${label}.`);
  return v;
};
const phone = (v, label) => {
  const s = text(v, label, 30);
  if (!/^[+\d][\d\s()-]{5,}$/.test(s)) throw fail(400, `${label} must be a phone number.`);
  return s;
};

const taken = (eventId, catId) => db.registrations.filter(r => r.eventId === eventId && r.categoryId === catId).length;
const publicEvent = ({ nextBib, ...e }) => ({
  ...e,
  open: today() <= e.deadline,
  categories: e.categories.map(c => ({ ...c, taken: taken(e.id, c.id) })),
});
function findEvent(id) {
  const e = db.events.find(e => e.id === id);
  if (!e) throw fail(404, 'This race does not exist.');
  return e;
}

function parseEvent(b, old) {
  const date = text(b.date, 'Race date');
  const deadline = opt(b.deadline, 10) || date;
  if (!ISO_DATE.test(date) || !ISO_DATE.test(deadline)) throw fail(400, 'Dates must look like 2026-12-31.');
  if (deadline > date) throw fail(400, 'The registration deadline must be on or before race day.');
  const time = opt(b.time, 5);
  if (time && !/^\d{2}:\d{2}$/.test(time)) throw fail(400, 'Gun start must be a time.');
  if (!Array.isArray(b.categories) || !b.categories.length) throw fail(400, 'Add at least one race category.');
  if (b.categories.length > 20) throw fail(400, 'A race can have at most 20 categories.');
  const oldIds = old ? old.categories.map(c => c.id) : [];
  const categories = b.categories.map(c => ({
    id: oldIds.includes(c.id) ? c.id : uid(),
    name: text(c.name, 'Category name', 40),
    fee: opt(c.fee, 40),
    slots: Math.max(0, Math.floor(Number(c.slots)) || 0), // 0 = no limit
  }));
  const dropped = old && old.categories.find(c => !categories.some(n => n.id === c.id) && taken(old.id, c.id));
  if (dropped) throw fail(400, `${dropped.name} already has registered runners, so it can't be removed.`);
  return {
    name: text(b.name, 'Event name'),
    date, time, deadline,
    venue: text(b.venue, 'Venue'),
    description: opt(b.description, 5000),
    contact: opt(b.contact, 200),
    categories,
  };
}

function register(e, b) {
  if (today() > e.deadline) throw fail(400, 'Registration for this race has closed.');
  const cat = e.categories.find(c => c.id === b.categoryId);
  if (!cat) throw fail(400, 'Choose a race category.');
  if (cat.slots && taken(e.id, cat.id) >= cat.slots) throw fail(409, `${cat.name} is full. Choose another category.`);
  const email = text(b.email, 'Email');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, 'Enter a valid email address.');
  const birthdate = text(b.birthdate, 'Date of birth');
  if (!ISO_DATE.test(birthdate) || birthdate >= today()) throw fail(400, 'Enter a valid date of birth.');
  if (b.waiver !== true) throw fail(400, 'You need to agree to the waiver to register.');
  const r = {
    id: uid(), eventId: e.id, categoryId: cat.id,
    firstName: text(b.firstName, 'First name', 100),
    lastName: text(b.lastName, 'Last name', 100),
    email, birthdate,
    phone: phone(b.phone, 'Mobile number'),
    sex: oneOf(b.sex, SEXES, 'sex'),
    shirtSize: oneOf(b.shirtSize, SHIRTS, 'shirt size'),
    emergencyName: text(b.emergencyName, 'Emergency contact name', 100),
    emergencyPhone: phone(b.emergencyPhone, 'Emergency contact number'),
    createdAt: new Date().toISOString(),
  };
  r.bib = e.nextBib++; // assigned last so a rejected form never burns a number
  db.registrations.push(r);
  save();
  return { bib: r.bib, name: `${r.firstName} ${r.lastName}`, category: cat.name, event: e.name };
}

const registrationsOf = e => db.registrations
  .filter(r => r.eventId === e.id)
  .map(r => ({ ...r, category: e.categories.find(c => c.id === r.categoryId)?.name || '' }));

// Leading = + - @ would run as a formula when the organizer opens the file in Excel.
const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};
const CSV_COLS = ['bib', 'firstName', 'lastName', 'category', 'email', 'phone', 'birthdate', 'sex', 'shirtSize', 'emergencyName', 'emergencyPhone', 'createdAt'];
const toCsv = rows => '﻿' + [CSV_COLS, ...rows.map(r => CSV_COLS.map(k => r[k]))].map(row => row.map(csvCell).join(',')).join('\r\n');

const sessions = new Set(); // in memory: restarting the server signs the organizer out
const isAdmin = req => sessions.has(/(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1]);
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e5) { reject(fail(413, 'That is too much data.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(fail(400, 'Invalid request.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${pathname}`;
  let m;

  if (route === 'GET /') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')));
  if (route === 'GET /api/events') {
    const upcoming = db.events.filter(e => e.date >= today()).sort((a, b) => a.date.localeCompare(b.date));
    return send(res, 200, upcoming.map(publicEvent));
  }
  if ((m = /^GET \/api\/events\/([\w-]+)$/.exec(route))) return send(res, 200, publicEvent(findEvent(m[1])));
  if ((m = /^POST \/api\/events\/([\w-]+)\/register$/.exec(route))) {
    const body = await readBody(req);
    return send(res, 201, register(findEvent(m[1]), body));
  }

  if (route === 'POST /api/login') {
    const { password } = await readBody(req);
    if (!crypto.timingSafeEqual(sha(password), sha(ADMIN_PASSWORD))) {
      // ponytail: this 1s delay is the only brute-force throttle; add a rate limiter if the password is weak
      await new Promise(r => setTimeout(r, 1000));
      throw fail(401, 'Wrong password.');
    }
    const sid = uid() + uid();
    sessions.add(sid);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/${secure}` });
  }
  if (route === 'POST /api/logout') {
    sessions.delete(/(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) throw fail(401, 'Sign in as the organizer.');

    if (route === 'GET /api/admin/events') {
      return send(res, 200, [...db.events].sort((a, b) => b.date.localeCompare(a.date)).map(publicEvent));
    }
    if (route === 'POST /api/admin/events') {
      const e = { id: uid(), nextBib: 1, ...parseEvent(await readBody(req)) };
      db.events.push(e);
      save();
      return send(res, 201, publicEvent(e));
    }
    if ((m = /^PUT \/api\/admin\/events\/([\w-]+)$/.exec(route))) {
      const e = findEvent(m[1]);
      Object.assign(e, parseEvent(await readBody(req), e));
      save();
      return send(res, 200, publicEvent(e));
    }
    if ((m = /^DELETE \/api\/admin\/events\/([\w-]+)$/.exec(route))) {
      const e = findEvent(m[1]);
      db.events = db.events.filter(x => x !== e);
      db.registrations = db.registrations.filter(r => r.eventId !== e.id);
      save();
      return send(res, 200, { ok: true });
    }
    if ((m = /^GET \/api\/admin\/events\/([\w-]+)\/registrations$/.exec(route))) {
      const e = findEvent(m[1]);
      return send(res, 200, { event: publicEvent(e), registrations: registrationsOf(e) });
    }
    if ((m = /^GET \/api\/admin\/events\/([\w-]+)\/registrations\.csv$/.exec(route))) {
      return send(res, 200, toCsv(registrationsOf(findEvent(m[1]))), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="registrations.csv"',
      });
    }
    if ((m = /^DELETE \/api\/admin\/registrations\/([\w-]+)$/.exec(route))) {
      db.registrations = db.registrations.filter(r => r.id !== m[1]);
      save();
      return send(res, 200, { ok: true });
    }
  }

  throw fail(404, 'Not found.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong on the server.' });
  });
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`Fun run registration running at http://localhost:${server.address().port}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`Organizer password is in ${PW_FILE}`);
});

module.exports = server;
