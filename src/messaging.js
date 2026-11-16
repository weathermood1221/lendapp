// Repayment reminders: in-app inbox, web push, and SMS/WhatsApp/email via a webhook (e.g. n8n, Twilio, WATI).
import * as webpush from 'web-push';
import { db, getSetting, setSetting } from './db.js';
import { loanView, notify, prettyPhone } from './loans.js';
import { todayMY, daysBetween, r2 } from '../public/js/loanmath.js';

// ---- web push (VAPID keys are generated once and stored) ----
let vapid = getSetting('vapid');
if (!vapid) { vapid = webpush.generateVAPIDKeys(); setSetting('vapid', vapid); }
webpush.setVapidDetails(`mailto:${process.env.VAPID_EMAIL || 'admin@example.com'}`, vapid.publicKey, vapid.privateKey);
export const vapidPublicKey = () => vapid.publicKey;

const RM = n => 'RM ' + Number(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fd = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const CH_LABEL = { push: 'App', sms: 'SMS', wa: 'WhatsApp', email: 'Email' };

export function fillTemplate(tpl, loan, borrower) {
  const v = loanView(loan, { withInst: false });
  const s = { company: getSetting('company'), phone: getSetting('phone') };
  const due = v.next ? v.next.due : '';
  const vars = {
    name: String(borrower.name).split(' ')[0], amount: RM(v.overdue || (v.next ? v.next.amount : 0)), due_date: due ? fd(due) : '',
    loan_id: loan.ref, balance: RM(v.balance || 0), days_overdue: due ? Math.max(0, -daysBetween(todayMY(), due)) : 0, company: s.company, phone: s.phone,
  };
  return tpl.replace(/\{(\w+)\}/g, (x, k) => (k in vars ? vars[k] : x));
}

async function pushTo(borrowerId, title, body) {
  const subs = db.prepare('SELECT * FROM push_subs WHERE borrower_id=?').all(borrowerId);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title, body, url: '/#loans' }), { TTL: 86400 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id=?').run(s.id);
    }
  }
  return sent;
}

async function webhook(channel, borrower, text, loanRef) {
  const m = getSetting('messaging');
  if (!m.webhook_url) return 'no-webhook';
  if (channel === 'email' && !borrower.email) return 'no-email';
  try {
    const r = await fetch(m.webhook_url, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...(m.webhook_secret ? { 'X-Webhook-Secret': m.webhook_secret } : {}) },
      body: JSON.stringify({ channel, to: channel === 'email' ? borrower.email : '+' + borrower.phone, phone_local: prettyPhone(borrower.phone), email: borrower.email || null, name: borrower.name, message: text, loan_ref: loanRef }),
    });
    return r.ok ? 'ok' : 'http-' + r.status;
  } catch (e) { return 'error'; }
}

// Sends one message to one borrower on the chosen channels. Always lands in the in-app inbox.
export async function sendMessage({ loan, borrower, channels, title, text, rule, instalmentId }) {
  notify(borrower.id, title, text);
  const results = [];
  for (const ch of channels) {
    if (ch === 'push') { const n = await pushTo(borrower.id, title, text); results.push(`App: ${n ? 'pushed' : 'inbox only (push not enabled on phone)'}`); }
    else { const r = await webhook(ch, borrower, text, loan.ref); results.push(`${CH_LABEL[ch]}: ${r === 'ok' ? 'sent' : r === 'no-webhook' ? 'skipped (set up messaging webhook)' : r === 'no-email' ? 'skipped (no email)' : 'failed (' + r + ')'}`); }
  }
  const status = results.join(' · ');
  try {
    db.prepare('INSERT INTO reminder_log(loan_id,instalment_id,rule,channels,body,status) VALUES(?,?,?,?,?,?)')
      .run(loan.id, instalmentId || null, rule || 'manual', channels.map(c => CH_LABEL[c]).join(' + '), text, status);
  } catch { /* duplicate auto-rule entry: already sent */ }
  return status;
}

// ---- audiences ----
export function audienceLoans(audience, loanId) {
  const today = todayMY();
  const loans = db.prepare("SELECT l.*, b.name b_name FROM loans l JOIN borrowers b ON b.id=l.borrower_id WHERE l.status='active'").all();
  return loans.filter(l => {
    const v = loanView(l, { withInst: false });
    if (!v.next) return false;
    const d = daysBetween(today, v.next.due);
    if (audience === 'one') return l.id === Number(loanId);
    if (audience === 'due3') return d >= 0 && d <= 3;
    if (audience === 'due7') return d <= 7;
    if (audience === 'overdue') return d < 0;
    return true;
  });
}

export async function sendToAudience({ audience, loanId, channels, template, rule = 'manual' }) {
  const loans = audienceLoans(audience, loanId);
  for (const l of loans) {
    const b = db.prepare('SELECT * FROM borrowers WHERE id=?').get(l.borrower_id);
    const v = loanView(l, { withInst: false });
    await sendMessage({ loan: l, borrower: b, channels, title: v.overdue ? 'Payment overdue' : 'Payment reminder', text: fillTemplate(template, l, b), rule });
  }
  return loans.length;
}

// ---- scheduler: runs every 5 minutes ----
const hourMY = () => new Date(Date.now() + 8 * 3600e3).getUTCHours();
let running = false;
export async function runScheduler() {
  if (running) return; running = true;
  try {
    // 1) scheduled manual reminders that are due
    const due = db.prepare("SELECT * FROM scheduled_reminders WHERE done=0 AND run_at <= ?").all(new Date().toISOString());
    for (const s of due) {
      db.prepare('UPDATE scheduled_reminders SET done=1 WHERE id=?').run(s.id);
      await sendToAudience({ audience: s.audience, loanId: s.loan_id, channels: JSON.parse(s.channels), template: s.template, rule: 'scheduled' });
    }
    // 2) automatic rules, once a day after the send hour
    if (hourMY() >= Number(getSetting('send_hour') ?? 9)) {
      const rules = getSetting('auto_rules').filter(r => r.on);
      const today = todayMY();
      const rows = db.prepare(`SELECT i.id inst_id, i.due_date, l.* FROM instalments i JOIN loans l ON l.id=i.loan_id
        WHERE l.status='active' AND i.paid_amount < i.amount - 0.005`).all();
      for (const row of rows) {
        const diff = daysBetween(row.due_date, today); // +ve = days after due
        for (const r of rules) {
          if (diff !== r.offset) continue;
          const exists = db.prepare('SELECT 1 FROM reminder_log WHERE instalment_id=? AND rule=?').get(row.inst_id, 'auto:' + r.key);
          if (exists) continue;
          const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(row.id);
          const b = db.prepare('SELECT * FROM borrowers WHERE id=?').get(loan.borrower_id);
          await sendMessage({ loan, borrower: b, channels: r.channels, title: r.offset > 0 ? 'Payment overdue' : 'Payment reminder', text: fillTemplate(r.template, loan, b), rule: 'auto:' + r.key, instalmentId: row.inst_id });
        }
      }
    }
  } catch (e) { console.error('scheduler', e); }
  finally { running = false; }
}
export function startScheduler() {
  setTimeout(runScheduler, 5000);
  setInterval(runScheduler, 5 * 60e3).unref();
}
export { RM, r2 };
