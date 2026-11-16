import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'lendapp.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, descr TEXT DEFAULT '', secured INTEGER NOT NULL DEFAULT 0,
  rate REAL NOT NULL, min_amt REAL NOT NULL, max_amt REAL NOT NULL,
  tenures TEXT NOT NULL, freqs TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS borrowers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, email TEXT, ic TEXT, income REAL, employment TEXT,
  pin_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, borrower_id INTEGER NOT NULL REFERENCES borrowers(id),
  product_id INTEGER, product_name TEXT, secured INTEGER, amount REAL NOT NULL, rate REAL NOT NULL, months INTEGER NOT NULL,
  freq TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'equal', status TEXT NOT NULL DEFAULT 'pending',
  source TEXT DEFAULT 'organic', click_id TEXT, utm TEXT, fbp TEXT, fbc TEXT, ttp TEXT, ip TEXT, ua TEXT,
  total REAL, interest REAL, start_date TEXT, notes TEXT,
  applied_at TEXT DEFAULT (datetime('now')), decided_at TEXT, disbursed_at TEXT);
CREATE TABLE IF NOT EXISTS instalments (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), idx INTEGER NOT NULL, due_date TEXT NOT NULL,
  amount REAL NOT NULL, paid_amount REAL NOT NULL DEFAULT 0, paid_at TEXT);
CREATE INDEX IF NOT EXISTS ix_inst_loan ON instalments(loan_id);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), amount REAL NOT NULL, method TEXT, reference TEXT,
  created_at TEXT DEFAULT (datetime('now')), admin_id INTEGER);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, borrower_id INTEGER NOT NULL REFERENCES borrowers(id), title TEXT, body TEXT, read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY, borrower_id INTEGER NOT NULL REFERENCES borrowers(id), endpoint TEXT UNIQUE NOT NULL, p256dh TEXT, auth TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')), ev TEXT, dest TEXT, status TEXT, loan_ref TEXT,
  request TEXT, response TEXT);
CREATE TABLE IF NOT EXISTS postbacks (
  id INTEGER PRIMARY KEY, name TEXT, method TEXT DEFAULT 'GET', url TEXT, events TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS reminder_log (
  id INTEGER PRIMARY KEY, loan_id INTEGER, instalment_id INTEGER, rule TEXT, channels TEXT, body TEXT, status TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX IF NOT EXISTS ux_auto_rule ON reminder_log(instalment_id, rule) WHERE rule LIKE 'auto:%';
CREATE TABLE IF NOT EXISTS scheduled_reminders (
  id INTEGER PRIMARY KEY, audience TEXT, loan_id INTEGER, channels TEXT, template TEXT, run_at TEXT, done INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
`);

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  company: 'Your Lending Co.',
  licence: 'WL0000/00/0000/2026',
  phone: '+60 3-0000 0000',
  domain: process.env.PUBLIC_DOMAIN || 'localhost:3000',
  bank_name: 'Maybank',
  bank_account_name: 'Your Lending Co. Sdn Bhd',
  bank_account_no: '0000 0000 0000',
  tracking: {
    meta: { pixel: '', token: '', test: '', version: 'v21.0' },
    tt: { pixel: '', token: '', test: '' },
    map: {
      calc: { meta: 'ViewContent', tt: 'ViewContent' },
      lead: { meta: 'Lead', tt: 'SubmitForm' },
      approved: { meta: 'LoanApproved', tt: 'CompleteRegistration' },
      disbursed: { meta: 'Purchase', tt: 'CompletePayment' },
      repayment: { meta: '', tt: '' },
    },
  },
  messaging: { webhook_url: '', webhook_secret: '' },
  send_hour: 9,
  auto_rules: [
    { key: 'before3', label: '3 days before due date', offset: -3, on: true, channels: ['push', 'wa'], template: 'Hi {name}, just a reminder that your instalment of {amount} for loan {loan_id} is due on {due_date}. – {company}' },
    { key: 'due', label: 'On the due date', offset: 0, on: true, channels: ['push', 'sms'], template: 'Hi {name}, your instalment of {amount} for loan {loan_id} is due today ({due_date}). Thank you for paying on time! – {company}' },
    { key: 'after1', label: '1 day after a missed payment', offset: 1, on: true, channels: ['push', 'wa'], template: "Hi {name}, we haven't received your instalment of {amount} for loan {loan_id}, which was due on {due_date}. Please pay, or call us at {phone} if you'd like to discuss a new repayment arrangement. – {company}" },
    { key: 'after7', label: '7 days after a missed payment', offset: 7, on: false, channels: ['push', 'sms', 'wa'], template: "Hi {name}, your instalment of {amount} for loan {loan_id} is now {days_overdue} days overdue. Please contact us at {phone} so we can help. – {company}" },
  ],
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return structuredClone(DEFAULT_SETTINGS[key]);
  return JSON.parse(row.value);
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}
export function allSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k);
  return out;
}

// ---------- first-run seed ----------
if (!db.prepare('SELECT COUNT(*) c FROM products').get().c) {
  const ins = db.prepare('INSERT INTO products(name,descr,secured,rate,min_amt,max_amt,tenures,freqs,active,sort) VALUES(?,?,?,?,?,?,?,?,1,?)');
  ins.run('Personal Loan', 'Quick cash, no collateral', 0, 18, 1000, 30000, '[6,12,18,24,36]', '["monthly","biweekly","weekly"]', 1);
  ins.run('Salary Loan', 'For salaried employees', 0, 15, 2000, 50000, '[12,24,36,48,60]', '["monthly","biweekly"]', 2);
  ins.run('Secured Loan', 'Lower rate with collateral', 1, 12, 10000, 100000, '[12,24,36,48,60]', '["monthly"]', 3);
}
// Loan refs start at L1001
if (!db.prepare("SELECT 1 FROM sqlite_sequence WHERE name='loans'").get()) {
  db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('loans',1000)").run();
}

export const tx = fn => db.transaction(fn);
