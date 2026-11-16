import { db, tx } from './db.js';
import { quote, dueDates, todayMY, r2, CAP } from '../public/js/loanmath.js';

export const normPhone = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '6' + d; if (d.startsWith('1') && d.length <= 10) d = '60' + d; return d; };
export const prettyPhone = d => d && d.startsWith('60') ? '0' + d.slice(2) : d;

export function parseProduct(p) {
  if (!p) return null;
  return { id: p.id, name: p.name, descr: p.descr, secured: !!p.secured, rate: p.rate, min: p.min_amt, max: p.max_amt, tenures: JSON.parse(p.tenures), freqs: JSON.parse(p.freqs), active: !!p.active, sort: p.sort };
}
export const listProducts = (activeOnly) => db.prepare(`SELECT * FROM products ${activeOnly ? 'WHERE active=1' : ''} ORDER BY sort, id`).all().map(parseProduct);

// Validates and normalises product input; returns {product} or {error}
export function validateProduct(b) {
  const secured = !!b.secured;
  const cap = secured ? CAP.secured : CAP.unsecured;
  const rate = Number(b.rate);
  if (!(rate >= 0)) return { error: 'Interest rate is required' };
  if (rate > cap) return { error: `Interest rate can't exceed ${cap}% p.a. for ${secured ? 'secured' : 'unsecured'} loans (Moneylenders Act 1951)` };
  const min = Number(b.min), max = Number(b.max);
  if (!(min > 0) || !(max >= min)) return { error: 'Check the minimum and maximum amounts' };
  const tenures = [...new Set((b.tenures || []).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 120))].sort((a, c) => a - c);
  const freqs = (b.freqs || []).filter(f => ['monthly', 'biweekly', 'weekly'].includes(f));
  if (!tenures.length) return { error: 'Pick at least one repayment period' };
  if (!freqs.length) return { error: 'Pick at least one payment frequency' };
  const longest = Math.max(...tenures);
  if (rate * longest / 1200 > 1) return { error: `At ${rate}% p.a., a ${longest}-month loan would charge more interest than the amount borrowed, which the Act doesn't allow` };
  return { product: { name: String(b.name || 'Loan').slice(0, 80), descr: String(b.descr || '').slice(0, 160), secured: secured ? 1 : 0, rate, min_amt: min, max_amt: max, tenures: JSON.stringify(tenures), freqs: JSON.stringify(freqs), active: b.active === false ? 0 : 1 } };
}

export function loanInstalments(loanId) {
  return db.prepare('SELECT * FROM instalments WHERE loan_id=? ORDER BY idx').all(loanId);
}

export function loanState(loan, inst) {
  if (loan.status !== 'active') return loan.status;
  const next = inst.find(i => i.paid_amount < i.amount - 0.005);
  if (!next) return 'closed';
  return next.due_date < todayMY() ? 'overdue' : 'active';
}

export function loanView(loan, { withInst = true } = {}) {
  const inst = loanInstalments(loan.id);
  const paid = r2(inst.reduce((a, i) => a + i.paid_amount, 0));
  const today = todayMY();
  const next = inst.find(i => i.paid_amount < i.amount - 0.005) || null;
  const overdue = r2(inst.filter(i => i.due_date < today).reduce((a, i) => a + Math.max(0, i.amount - i.paid_amount), 0));
  const v = {
    id: loan.id, ref: loan.ref, product: loan.product_name, secured: !!loan.secured, amount: loan.amount, rate: loan.rate,
    months: loan.months, freq: loan.freq, plan: loan.plan, status: loan.status, state: loanState(loan, inst),
    source: loan.source, clickId: loan.click_id, total: loan.total, interest: loan.interest, paid, balance: loan.total != null ? r2(loan.total - paid) : null,
    overdue, next: next ? { id: next.id, due: next.due_date, amount: r2(next.amount - next.paid_amount) } : null,
    appliedAt: loan.applied_at, decidedAt: loan.decided_at, disbursedAt: loan.disbursed_at, startDate: loan.start_date, notes: loan.notes,
  };
  if (withInst) v.instalments = inst.map(i => ({ idx: i.idx, due: i.due_date, amount: i.amount, paid: i.paid_amount, paidAt: i.paid_at }));
  return v;
}

export const createSchedule = tx((loanId, startDate) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(loanId);
  const q = quote(loan.amount, loan.rate, loan.months, loan.freq, loan.plan);
  const dates = dueDates(startDate, loan.freq, q.n);
  db.prepare('DELETE FROM instalments WHERE loan_id=?').run(loanId);
  const ins = db.prepare('INSERT INTO instalments(loan_id,idx,due_date,amount) VALUES(?,?,?,?)');
  q.amts.forEach((a, i) => ins.run(loanId, i + 1, dates[i], a));
  db.prepare("UPDATE loans SET status='active', start_date=?, total=?, interest=?, disbursed_at=datetime('now') WHERE id=?").run(startDate, q.total, q.interest, loanId);
});

// Applies a payment to the oldest unpaid instalments first. Returns the amount applied.
export const recordPayment = tx((loanId, amount, method, reference, adminId) => {
  let left = r2(amount);
  const inst = loanInstalments(loanId);
  const upd = db.prepare("UPDATE instalments SET paid_amount=?, paid_at=CASE WHEN ? >= amount - 0.005 THEN datetime('now') ELSE paid_at END WHERE id=?");
  for (const i of inst) {
    if (left <= 0) break;
    const owe = r2(i.amount - i.paid_amount);
    if (owe <= 0) continue;
    const pay = Math.min(owe, left);
    const np = r2(i.paid_amount + pay);
    upd.run(np, np, i.id);
    left = r2(left - pay);
  }
  const applied = r2(amount - left);
  const info = db.prepare('INSERT INTO payments(loan_id,amount,method,reference,admin_id) VALUES(?,?,?,?,?)').run(loanId, applied, method || '', reference || '', adminId || null);
  return { applied, paymentId: info.lastInsertRowid };
});

export function notify(borrowerId, title, body) {
  db.prepare('INSERT INTO notifications(borrower_id,title,body) VALUES(?,?,?)').run(borrowerId, title, body);
}

// Age from MyKad (YYMMDD-PB-###G). Returns null if it can't be read.
export function ageFromIC(ic) {
  const d = String(ic || '').replace(/\D/g, '');
  if (d.length !== 12) return null;
  let yy = +d.slice(0, 2); const mm = +d.slice(2, 4), dd = +d.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const nowY = new Date().getFullYear();
  let year = 2000 + yy; if (year > nowY) year -= 100;
  const now = new Date(); let age = now.getFullYear() - year;
  if (now.getMonth() + 1 < mm || (now.getMonth() + 1 === mm && now.getDate() < dd)) age--;
  return age;
}
