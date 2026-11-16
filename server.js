import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, allSettings, tx } from './src/db.js';
import { hashSecret, verifySecret, createSession, destroySession, requireAdmin, requireBorrower, optionalBorrower, rateLimit, ensureAdmin } from './src/auth.js';
import { normPhone, prettyPhone, listProducts, parseProduct, validateProduct, loanView, createSchedule, recordPayment, notify, ageFromIC } from './src/loans.js';
import { track, firePostback, EVN } from './src/tracking.js';
import { vapidPublicKey, audienceLoans, sendToAudience, fillTemplate, startScheduler, CH_LABEL, RM } from './src/messaging.js';
import { todayMY, r2 } from './public/js/loanmath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const fmtD = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const mask = t => !t ? '' : '••••••••' + String(t).slice(-4);
const isMasked = v => typeof v === 'string' && v.startsWith('••••');
const getLoan = id => db.prepare('SELECT * FROM loans WHERE id=?').get(Number(id));
const getBorrower = id => db.prepare('SELECT * FROM borrowers WHERE id=?').get(id);

/* =================== PUBLIC + BORROWER API =================== */
app.get('/api/config', (req, res) => {
  const tr = getSetting('tracking');
  res.json({
    company: getSetting('company'), licence: getSetting('licence'), phone: getSetting('phone'),
    bank: { name: getSetting('bank_name'), accountName: getSetting('bank_account_name'), accountNo: getSetting('bank_account_no') },
    pixels: { meta: tr.meta.pixel || null, tt: tr.tt.pixel || null }, map: tr.map, vapidKey: vapidPublicKey(),
  });
});
app.get('/api/products', (req, res) => res.json(listProducts(true)));

app.post('/api/apply', (req, res) => {
  const b = req.body || {};
  const p = parseProduct(db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(b.productId)));
  if (!p) return bad(res, 'Please choose a loan product');
  const amount = Number(b.amount), months = Number(b.months);
  if (!(amount >= p.min && amount <= p.max)) return bad(res, `Amount must be between RM${p.min} and RM${p.max}`);
  if (!p.tenures.includes(months)) return bad(res, 'Please choose a repayment period');
  if (!p.freqs.includes(b.freq)) return bad(res, 'Please choose how often to pay');
  const plan = b.plan === 'stepup' ? 'stepup' : 'equal';
  if (!b.consent) return bad(res, 'Please confirm the declaration');

  let borrowerId = optionalBorrower(req);
  if (!borrowerId) {
    const name = String(b.name || '').trim(), phone = normPhone(b.phone);
    if (name.length < 3) return bad(res, 'Please enter your full name');
    if (!/^601\d{8,9}$/.test(phone)) return bad(res, 'Please enter a valid Malaysian mobile number');
    const age = ageFromIC(b.ic);
    if (age == null) return bad(res, 'Please enter your 12-digit MyKad number');
    if (age < 18) return bad(res, 'You must be 18 or older to apply');
    if (!/^\d{6}$/.test(String(b.pin || ''))) return bad(res, 'Choose a 6-digit PIN');
    if (db.prepare('SELECT 1 FROM borrowers WHERE phone=?').get(phone)) return bad(res, 'This number already has an account. Please log in first.', 409);
    const email = String(b.email || '').trim();
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Please check your email address');
    borrowerId = db.prepare('INSERT INTO borrowers(name,phone,email,ic,income,employment,pin_hash) VALUES(?,?,?,?,?,?,?)')
      .run(name.slice(0, 120), phone, email || null, String(b.ic).replace(/\D/g, ''), Number(b.income) || null, String(b.employment || '').slice(0, 60), hashSecret(b.pin)).lastInsertRowid;
    createSession(res, req, 'borrower', borrowerId);
  }
  if (db.prepare("SELECT 1 FROM loans WHERE borrower_id=? AND status IN ('pending','approved')").get(borrowerId))
    return bad(res, 'You already have an application being processed', 409);

  const src = ['organic', 'tiktok', 'meta', 'affiliate', 'google', 'referral'].includes(b.source) ? b.source : 'organic';
  const s = v => (v ? String(v).slice(0, 300) : null);
  const info = db.prepare(`INSERT INTO loans(borrower_id,product_id,product_name,secured,amount,rate,months,freq,plan,source,click_id,utm,fbp,fbc,ttp,ip,ua)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(borrowerId, p.id, p.name, p.secured ? 1 : 0, amount, p.rate, months, b.freq, plan, src,
    s(b.clickId), s(b.utm), s(b.fbp), s(b.fbc), s(b.ttp), req.ip, s(req.headers['user-agent']));
  const ref = 'L' + info.lastInsertRowid;
  db.prepare('UPDATE loans SET ref=? WHERE id=?').run(ref, info.lastInsertRowid);
  notify(borrowerId, 'Application received', `Thanks! We've received your application ${ref} for RM${amount.toLocaleString('en-MY')}. Our team will review it and contact you.`);
  track('lead', { loan: getLoan(info.lastInsertRowid), borrower: getBorrower(borrowerId) });
  res.json({ ref, eventId: `lead_${ref}` });
});

app.post('/api/login', (req, res) => {
  const phone = normPhone(req.body?.phone);
  if (!rateLimit('b:' + phone) || !rateLimit('ip:' + req.ip, 30)) return bad(res, 'Too many attempts. Please try again in 15 minutes.', 429);
  const bor = db.prepare('SELECT * FROM borrowers WHERE phone=?').get(phone);
  if (!bor || !verifySecret(String(req.body?.pin || ''), bor.pin_hash)) return bad(res, 'Wrong phone number or PIN', 401);
  createSession(res, req, 'borrower', bor.id);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { destroySession(req, res, 'borrower'); res.json({ ok: true }); });

app.get('/api/me', requireBorrower, (req, res) => {
  const bor = getBorrower(req.borrowerId);
  if (!bor) return bad(res, 'Please log in', 401);
  const loans = db.prepare('SELECT * FROM loans WHERE borrower_id=? ORDER BY id DESC').all(bor.id).map(l => loanView(l));
  const notes = db.prepare('SELECT id,title,body,read,created_at FROM notifications WHERE borrower_id=? ORDER BY id DESC LIMIT 50').all(bor.id);
  res.json({ name: bor.name, phone: prettyPhone(bor.phone), loans, notifications: notes, hasPush: !!db.prepare('SELECT 1 FROM push_subs WHERE borrower_id=?').get(bor.id) });
});
app.post('/api/notifications/read', requireBorrower, (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE borrower_id=?').run(req.borrowerId); res.json({ ok: true });
});
app.post('/api/push/subscribe', requireBorrower, (req, res) => {
  const s = req.body || {};
  if (!s.endpoint || !s.keys?.p256dh) return bad(res, 'Invalid subscription');
  db.prepare('INSERT INTO push_subs(borrower_id,endpoint,p256dh,auth) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET borrower_id=excluded.borrower_id')
    .run(req.borrowerId, s.endpoint, s.keys.p256dh, s.keys.auth);
  res.json({ ok: true });
});

/* =================== ADMIN API =================== */
const A = express.Router();
A.post('/login', (req, res) => {
  const u = String(req.body?.username || '');
  if (!rateLimit('a:' + u) || !rateLimit('aip:' + req.ip, 20)) return bad(res, 'Too many attempts. Please try again in 15 minutes.', 429);
  const a = db.prepare('SELECT * FROM admins WHERE username=?').get(u);
  if (!a || !verifySecret(String(req.body?.password || ''), a.pass_hash)) return bad(res, 'Wrong username or password', 401);
  createSession(res, req, 'admin', a.id); res.json({ ok: true });
});
A.post('/logout', (req, res) => { destroySession(req, res, 'admin'); res.json({ ok: true }); });
A.use(requireAdmin);
A.get('/me', (req, res) => res.json(db.prepare('SELECT id,username FROM admins WHERE id=?').get(req.adminId)));
A.post('/password', (req, res) => {
  const a = db.prepare('SELECT * FROM admins WHERE id=?').get(req.adminId);
  if (!verifySecret(String(req.body?.current || ''), a.pass_hash)) return bad(res, 'Current password is wrong');
  if (String(req.body?.next || '').length < 10) return bad(res, 'New password needs at least 10 characters');
  db.prepare('UPDATE admins SET pass_hash=? WHERE id=?').run(hashSecret(req.body.next), a.id);
  res.json({ ok: true });
});

function adminLoanRow(l) {
  const v = loanView(l, { withInst: false });
  const b = getBorrower(l.borrower_id);
  return { ...v, borrower: { id: b.id, name: b.name, phone: prettyPhone(b.phone) } };
}
A.get('/stats', (req, res) => {
  const all = db.prepare('SELECT * FROM loans').all().map(l => loanView(l, { withInst: false }));
  const act = all.filter(l => ['active', 'overdue'].includes(l.state));
  const bySource = {}; all.forEach(l => { bySource[l.source] = (bySource[l.source] || 0) + 1; });
  const today = todayMY();
  const dueSoon = db.prepare('SELECT * FROM loans WHERE status=\'active\'').all().map(adminLoanRow)
    .filter(l => l.next && l.next.due <= addDaysStr(today, 7)).sort((a, b) => a.next.due.localeCompare(b.next.due)).slice(0, 12);
  res.json({
    pending: all.filter(l => l.state === 'pending').length, approved: all.filter(l => l.state === 'approved').length,
    active: act.length, overdue: act.filter(l => l.state === 'overdue').length,
    disbursed: r2(act.reduce((a, l) => a + l.amount, 0)), outstanding: r2(act.reduce((a, l) => a + (l.balance || 0), 0)),
    collected: r2(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments').get().s), bySource, dueSoon, today,
  });
});
function addDaysStr(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

A.get('/loans', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  let rows = db.prepare('SELECT * FROM loans ORDER BY id DESC LIMIT 1000').all().map(adminLoanRow);
  if (req.query.state && req.query.state !== 'all') rows = rows.filter(l => l.state === req.query.state);
  if (q) rows = rows.filter(l => l.ref.toLowerCase().includes(q) || l.borrower.name.toLowerCase().includes(q) || l.borrower.phone.includes(q));
  res.json(rows);
});
A.get('/loans/:id', (req, res) => {
  const l = getLoan(req.params.id); if (!l) return bad(res, 'Not found', 404);
  const b = getBorrower(l.borrower_id);
  res.json({
    ...loanView(l), borrower: { id: b.id, name: b.name, phone: prettyPhone(b.phone), email: b.email, ic: b.ic, income: b.income, employment: b.employment, since: b.created_at },
    payments: db.prepare('SELECT * FROM payments WHERE loan_id=? ORDER BY id DESC').all(l.id),
    reminders: db.prepare('SELECT * FROM reminder_log WHERE loan_id=? ORDER BY id DESC LIMIT 30').all(l.id),
    events: db.prepare('SELECT id,created_at,ev,dest,status FROM events WHERE loan_ref=? ORDER BY id DESC LIMIT 30').all(l.ref),
    tracking: { utm: l.utm, fbc: l.fbc, fbp: l.fbp, ttp: l.ttp, ip: l.ip },
  });
});
A.post('/loans/:id/decide', (req, res) => {
  const l = getLoan(req.params.id); if (!l) return bad(res, 'Not found', 404);
  if (l.status !== 'pending') return bad(res, 'This application has already been decided');
  const decision = req.body?.decision === 'approve' ? 'approved' : 'rejected';
  db.prepare("UPDATE loans SET status=?, decided_at=datetime('now'), notes=? WHERE id=?").run(decision, String(req.body?.note || '').slice(0, 500) || null, l.id);
  notify(l.borrower_id, decision === 'approved' ? 'Loan approved 🎉' : 'Application update',
    decision === 'approved' ? `Good news! Your ${l.product_name} of RM${l.amount.toLocaleString('en-MY')} (${l.ref}) is approved. We'll transfer the money to you shortly.` : `We couldn't approve application ${l.ref} this time. You're welcome to apply again later.`);
  if (decision === 'approved') track('approved', { loan: getLoan(l.id), borrower: getBorrower(l.borrower_id) });
  res.json({ ok: true });
});
A.post('/loans/:id/disburse', (req, res) => {
  const l = getLoan(req.params.id); if (!l) return bad(res, 'Not found', 404);
  if (l.status !== 'approved') return bad(res, 'Only approved loans can be disbursed');
  const start = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.startDate || '') ? req.body.startDate : todayMY();
  createSchedule(l.id, start);
  const v = loanView(getLoan(l.id), { withInst: false });
  notify(l.borrower_id, 'Money sent', `RM${l.amount.toLocaleString('en-MY')} has been sent to you. Your first payment of ${RM(v.next.amount)} is due on ${fmtD(v.next.due)}.`);
  track('disbursed', { loan: getLoan(l.id), borrower: getBorrower(l.borrower_id) });
  res.json({ ok: true });
});
A.post('/loans/:id/payments', (req, res) => {
  const l = getLoan(req.params.id); if (!l) return bad(res, 'Not found', 404);
  if (l.status !== 'active') return bad(res, 'Payments can only be recorded on active loans');
  const amount = r2(Number(req.body?.amount));
  if (!(amount > 0)) return bad(res, 'Enter the amount received');
  const bal = loanView(l, { withInst: false }).balance;
  if (amount > bal + 0.005) return bad(res, `That's more than the remaining balance (${RM(bal)})`);
  const { applied, paymentId } = recordPayment(l.id, amount, req.body?.method, req.body?.reference, req.adminId);
  const after = loanView(getLoan(l.id), { withInst: false });
  notify(l.borrower_id, 'Payment received', `We received ${RM(applied)} for loan ${l.ref}. ${after.state === 'closed' ? 'Your loan is now fully repaid. Thank you!' : `Remaining balance: ${RM(after.balance)}.`}`);
  if (after.state === 'closed') db.prepare("UPDATE loans SET status='closed' WHERE id=?").run(l.id);
  track('repayment', { loan: getLoan(l.id), borrower: getBorrower(l.borrower_id), value: applied, eventId: `repayment_${l.ref}_${paymentId}` });
  res.json({ ok: true, applied });
});
A.post('/borrowers/:id/reset-pin', (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!/^\d{6}$/.test(pin)) return bad(res, 'PIN must be 6 digits');
  db.prepare('UPDATE borrowers SET pin_hash=? WHERE id=?').run(hashSecret(pin), Number(req.params.id));
  db.prepare("DELETE FROM sessions WHERE kind='borrower' AND user_id=?").run(Number(req.params.id));
  res.json({ ok: true });
});

// products
A.get('/products', (req, res) => res.json(listProducts(false)));
A.post('/products', (req, res) => {
  const v = validateProduct(req.body || {}); if (v.error) return bad(res, v.error);
  const p = v.product; const sort = (db.prepare('SELECT MAX(sort) m FROM products').get().m || 0) + 1;
  const id = db.prepare('INSERT INTO products(name,descr,secured,rate,min_amt,max_amt,tenures,freqs,active,sort) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(p.name, p.descr, p.secured, p.rate, p.min_amt, p.max_amt, p.tenures, p.freqs, p.active, sort).lastInsertRowid;
  res.json({ id });
});
A.put('/products/:id', (req, res) => {
  const v = validateProduct(req.body || {}); if (v.error) return bad(res, v.error);
  const p = v.product;
  if (!p.active && !db.prepare('SELECT 1 FROM products WHERE active=1 AND id<>?').get(Number(req.params.id))) return bad(res, 'Keep at least one product live in the app');
  db.prepare('UPDATE products SET name=?,descr=?,secured=?,rate=?,min_amt=?,max_amt=?,tenures=?,freqs=?,active=? WHERE id=?')
    .run(p.name, p.descr, p.secured, p.rate, p.min_amt, p.max_amt, p.tenures, p.freqs, p.active, Number(req.params.id));
  res.json({ ok: true });
});
A.delete('/products/:id', (req, res) => {
  if (db.prepare('SELECT 1 FROM loans WHERE product_id=?').get(Number(req.params.id))) return bad(res, 'This product has loans. Hide it instead of deleting.');
  db.prepare('DELETE FROM products WHERE id=?').run(Number(req.params.id)); res.json({ ok: true });
});

// reminders
const cleanChannels = c => (Array.isArray(c) ? c : []).filter(x => ['push', 'sms', 'wa', 'email'].includes(x));
A.post('/reminders/preview', (req, res) => {
  const { audience, loanId, template } = req.body || {};
  const loans = audienceLoans(audience, loanId);
  const first = loans[0];
  res.json({ count: loans.length, names: loans.slice(0, 5).map(l => l.b_name), sample: first ? { name: first.b_name, text: fillTemplate(String(template || ''), first, getBorrower(first.borrower_id)) } : null });
});
A.post('/reminders/send', async (req, res) => {
  const { audience, loanId, template, runAt } = req.body || {};
  const channels = cleanChannels(req.body?.channels);
  if (!channels.length) return bad(res, 'Pick at least one channel');
  if (!String(template || '').trim()) return bad(res, 'Write a message');
  if (runAt) {
    const t = new Date(runAt); if (isNaN(t) || t < new Date()) return bad(res, 'Pick a time in the future');
    db.prepare('INSERT INTO scheduled_reminders(audience,loan_id,channels,template,run_at) VALUES(?,?,?,?,?)').run(audience, loanId || null, JSON.stringify(channels), template, t.toISOString());
    return res.json({ scheduled: true });
  }
  const n = await sendToAudience({ audience, loanId, channels, template });
  res.json({ sent: n });
});
A.get('/reminders/log', (req, res) => res.json(db.prepare(`SELECT r.*, l.ref, b.name FROM reminder_log r LEFT JOIN loans l ON l.id=r.loan_id LEFT JOIN borrowers b ON b.id=l.borrower_id ORDER BY r.id DESC LIMIT 100`).all()));
A.get('/reminders/scheduled', (req, res) => res.json(db.prepare('SELECT * FROM scheduled_reminders WHERE done=0 ORDER BY run_at').all()));
A.delete('/reminders/scheduled/:id', (req, res) => { db.prepare('DELETE FROM scheduled_reminders WHERE id=? AND done=0').run(Number(req.params.id)); res.json({ ok: true }); });
A.get('/reminders/rules', (req, res) => res.json({ rules: getSetting('auto_rules'), sendHour: getSetting('send_hour') }));
A.put('/reminders/rules', (req, res) => {
  const cur = getSetting('auto_rules');
  const incoming = Array.isArray(req.body?.rules) ? req.body.rules : [];
  const next = cur.map(r => { const n = incoming.find(x => x.key === r.key); return n ? { ...r, on: !!n.on, channels: cleanChannels(n.channels), template: String(n.template || r.template).slice(0, 1000) } : r; });
  setSetting('auto_rules', next);
  const h = Number(req.body?.sendHour); if (h >= 0 && h <= 23) setSetting('send_hour', h);
  res.json({ ok: true });
});

// settings
A.get('/settings', (req, res) => {
  const s = allSettings(); delete s.tracking; delete s.auto_rules;
  s.messaging = { webhook_url: s.messaging.webhook_url, webhook_secret: mask(s.messaging.webhook_secret) };
  res.json(s);
});
A.put('/settings', (req, res) => {
  const b = req.body || {};
  for (const k of ['company', 'licence', 'phone', 'domain', 'bank_name', 'bank_account_name', 'bank_account_no']) if (typeof b[k] === 'string') setSetting(k, b[k].trim().slice(0, 200));
  if (b.messaging) {
    const m = getSetting('messaging');
    if (typeof b.messaging.webhook_url === 'string') m.webhook_url = b.messaging.webhook_url.trim();
    if (typeof b.messaging.webhook_secret === 'string' && !isMasked(b.messaging.webhook_secret)) m.webhook_secret = b.messaging.webhook_secret.trim();
    setSetting('messaging', m);
  }
  res.json({ ok: true });
});

// tracking
A.get('/tracking', (req, res) => {
  const t = getSetting('tracking');
  t.meta.token = mask(t.meta.token); t.tt.token = mask(t.tt.token);
  res.json(t);
});
A.put('/tracking', (req, res) => {
  const t = getSetting('tracking'), b = req.body || {};
  for (const plat of ['meta', 'tt']) {
    if (!b[plat]) continue;
    for (const k of ['pixel', 'token', 'test', 'version']) {
      const v = b[plat][k]; if (typeof v !== 'string') continue;
      if (k === 'token' && isMasked(v)) continue;
      t[plat][k] = v.trim();
    }
  }
  if (b.map) for (const ev of Object.keys(t.map)) if (b.map[ev]) t.map[ev] = { meta: String(b.map[ev].meta ?? t.map[ev].meta), tt: String(b.map[ev].tt ?? t.map[ev].tt) };
  setSetting('tracking', t); res.json({ ok: true });
});
A.post('/tracking/test', async (req, res) => {
  const { fireEvent } = await import('./src/tracking.js');
  const fake = { ref: 'TEST', amount: 5000, source: 'meta', click_id: null, ip: req.ip, ua: req.headers['user-agent'] };
  await fireEvent('lead', { loan: fake, borrower: { id: 0, name: 'Test User', phone: '60123456789' }, eventId: 'test_' + Date.now() });
  res.json({ ok: true });
});

// postbacks
const pbRow = p => ({ ...p, events: JSON.parse(p.events || '{}'), active: !!p.active });
const pbIn = b => ({ name: String(b.name || 'Partner').slice(0, 80), method: b.method === 'POST' ? 'POST' : 'GET', url: String(b.url || '').trim(), events: JSON.stringify(Object.fromEntries(Object.keys(EVN).filter(k => k !== 'calc').map(k => [k, !!b.events?.[k]]))), active: b.active === false ? 0 : 1 });
A.get('/postbacks', (req, res) => res.json(db.prepare('SELECT * FROM postbacks ORDER BY id').all().map(pbRow)));
A.post('/postbacks', (req, res) => { const p = pbIn(req.body || {}); res.json({ id: db.prepare('INSERT INTO postbacks(name,method,url,events,active) VALUES(?,?,?,?,?)').run(p.name, p.method, p.url, p.events, p.active).lastInsertRowid }); });
A.put('/postbacks/:id', (req, res) => { const p = pbIn(req.body || {}); db.prepare('UPDATE postbacks SET name=?,method=?,url=?,events=?,active=? WHERE id=?').run(p.name, p.method, p.url, p.events, p.active, Number(req.params.id)); res.json({ ok: true }); });
A.delete('/postbacks/:id', (req, res) => { db.prepare('DELETE FROM postbacks WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });
A.post('/postbacks/:id/test', async (req, res) => {
  const p = db.prepare('SELECT * FROM postbacks WHERE id=?').get(Number(req.params.id)); if (!p) return bad(res, 'Not found', 404);
  await firePostback(p, 'lead', { click_id: 'TEST_CLICK_123', event: 'lead', amount: 5000, loan_id: 'TEST', source: 'affiliate', txid: 'TEST-' + Date.now(), currency: 'MYR', timestamp: Math.floor(Date.now() / 1000) }, 'TEST');
  res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get());
});

// events
A.get('/events', (req, res) => res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(Math.min(500, Number(req.query.limit) || 100))));

app.use('/api/admin', A);
app.use('/api', (req, res) => bad(res, 'Not found', 404));

/* =================== STATIC =================== */
const pub = path.join(__dirname, 'public');
app.get('/manifest.webmanifest', (req, res) => {
  const m = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
  const name = getSetting('company'); m.name = name; m.short_name = name.length > 12 ? name.split(' ')[0] : name;
  res.type('application/manifest+json').send(JSON.stringify(m));
});
app.get('/sw.js',(req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'sw.js')); });
app.use(express.static(pub, { extensions: ['html'], maxAge: '1h' }));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin', 'index.html')));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong' }); });

ensureAdmin();
startScheduler();
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Lending app running on http://localhost:${PORT}  (admin: /admin)`));
