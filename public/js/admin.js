import { quote, FREQ, CAP, r2, todayMY } from './loanmath.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RM = n => 'RM ' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RM0 = n => 'RM ' + Math.round(n || 0).toLocaleString('en-MY');
const fd = s => s ? new Date(String(s).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '–';
const fdt = s => s ? new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z')).toLocaleString('en-MY', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
const dBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
function toast(t, bad) { const el = $('#toast'); el.textContent = t; el.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toast._t); toast._t = setTimeout(() => el.className = '', 3200); }
async function api(path, body, method) {
  const r = await fetch('/api/admin' + path, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { A.me = null; renderRoot(); throw new Error('Please log in again'); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
// run an action, show its error as a toast
const act = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

const SRC = { organic: 'Organic', tiktok: 'TikTok ad', meta: 'Meta ad (FB/IG)', affiliate: 'Affiliate', google: 'Google', referral: 'Friend / referral' };
const EVN = { calc: 'Used loan calculator', lead: 'Application submitted', approved: 'Loan approved', disbursed: 'Loan disbursed', repayment: 'Repayment made' };
const CH = { push: 'App notification', sms: 'SMS', wa: 'WhatsApp', email: 'Email' };
const TPL = {
  before: 'Hi {name}, just a reminder that your instalment of {amount} for loan {loan_id} is due on {due_date}. – {company}',
  today: 'Hi {name}, your instalment of {amount} for loan {loan_id} is due today ({due_date}). Thank you for paying on time! – {company}',
  missed: "Hi {name}, we haven't received your instalment of {amount} for loan {loan_id}, which was due on {due_date}. Please pay, or call us at {phone} if you'd like to discuss a new repayment arrangement. – {company}",
};
const TABS = [['grp', 'Overview'], ['dashboard', 'Dashboard'], ['apps', 'Applications'], ['grp', 'Lending'], ['products', 'Loan products'], ['reminders', 'Repayment reminders'], ['grp', 'Marketing'], ['tracking', 'Meta & TikTok'], ['postback', 'S2S postbacks'], ['events', 'Event log'], ['grp', 'Company'], ['settings', 'Settings']];

const A = {
  me: null, tab: (location.hash.slice(1) || 'dashboard'), d: {}, pending: 0, loanId: null,
  filter: 'all', q: '', openEv: null,
  remind: { audience: 'due3', loanId: '', channels: ['push', 'wa'], template: TPL.before, when: 'now', at: '' },
  proj: { budget: 10000, cpl: 25, appr: 30, avg: 5000, tenure: 12, rate: 18, def: 5 },
};
window.A = A;

/* ---------------- shell ---------------- */
function renderRoot() {
  if (!A.me) { $('#root').innerHTML = loginView(); return; }
  $('#root').innerHTML = `<header class="top"><div class="brand"><img src="/icons/icon-192.png" width="26" height="26" alt="" style="border-radius:7px"><span id="coName">${esc(A.company || 'Admin')}</span></div>
    <div class="who"><span>${esc(A.me.username)}</span><a href="/" target="_blank" style="color:#cfd8d2;font-size:12px">View app ↗</a><button onclick="logout()">Log out</button></div></header>
    <div class="admin"><nav class="nav" id="nav"></nav><section class="content" id="content"></section></div>`;
  show(A.tab, true);
}
function renderNav(newTab) {
  const nav = $('#nav'); const x = nav.scrollLeft;
  const cur = A.tab === 'loan' ? 'apps' : A.tab;
  nav.innerHTML = TABS.map(([k, v]) => k === 'grp' ? `<div class="grp">${v}</div>` : `<button class="${cur === k ? 'on' : ''}" onclick="show('${k}')"><span>${v}</span>${k === 'apps' && A.pending ? `<span class="cnt">${A.pending}</span>` : ''}</button>`).join('');
  nav.scrollLeft = x;
  const on = nav.querySelector('button.on');
  if (newTab && on && innerWidth <= 960) nav.scrollLeft = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2;
}
const LOADERS = {
  dashboard: async () => { A.d.stats = await api('/stats'); A.pending = A.d.stats.pending; },
  apps: async () => { const [l, s] = await Promise.all([api(`/loans?state=${A.filter}&q=${encodeURIComponent(A.q)}`), api('/stats')]); A.d.loans = l; A.pending = s.pending; },
  loan: async () => { const [l, s] = await Promise.all([api('/loans/' + A.loanId), api('/stats')]); A.d.loan = l; A.pending = s.pending; },
  products: async () => { A.d.products = await api('/products'); A.d.pedit = Object.fromEntries(A.d.products.map(p => [p.id, structuredClone(p)])); },
  reminders: async () => { const [rules, log, sch, loans] = await Promise.all([api('/reminders/rules'), api('/reminders/log'), api('/reminders/scheduled'), api('/loans?state=all')]); Object.assign(A.d, { rules, rlog: log, sched: sch, actLoans: loans.filter(l => ['active', 'overdue'].includes(l.state)) }); },
  tracking: async () => { A.d.tracking = await api('/tracking'); },
  postback: async () => { const [p, e] = await Promise.all([api('/postbacks'), api('/events?limit=100')]); A.d.postbacks = p; A.d.events = e; },
  events: async () => { A.d.events = await api('/events?limit=200'); },
  settings: async () => { A.d.settings = await api('/settings'); },
};
const VIEWS = {};
window.show = async (tab, force) => {
  const newTab = tab !== A.tab || force;
  if (!LOADERS[tab]) tab = 'dashboard';
  A.tab = tab; if (tab !== 'loan' && location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  renderNav(newTab);
  if (newTab) { $('#content').innerHTML = '<div class="loading"><span class="spin"></span></div>'; scrollTo(0, 0); }
  try { await LOADERS[tab](); } catch (e) { $('#content').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (A.tab !== tab) return;
  draw();
  renderNav(false);
};
// redraw current view from cached data, keeping scroll position
function draw() {
  const y = scrollY;
  $('#content').innerHTML = VIEWS[A.tab]();
  if (A.tab === 'dashboard') projOut();
  if (A.tab === 'reminders') remPreview();
  scrollTo(0, y);
}
const reload = () => show(A.tab);
window.draw = draw;

/* ---------------- login ---------------- */
function loginView() {
  return `<div class="login"><div class="center"><img src="/icons/icon-192.png" width="56" height="56" alt="" style="border-radius:14px"><h2 style="margin-top:12px">Admin login</h2></div>
  <form class="card mt" onsubmit="doLogin(event)"><label class="f">Username</label><input class="in" name="username" autocomplete="username" required>
  <label class="f">Password</label><input class="in" name="password" type="password" autocomplete="current-password" required>
  <div class="err" id="lerr"></div><button class="btn primary block mt">Log in</button></form></div>`;
}
window.doLogin = async e => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
  try { await api('/login', f); await boot(); } catch (err) { $('#lerr').textContent = err.message; }
};
window.logout = async () => { await api('/logout', {}).catch(() => {}); A.me = null; renderRoot(); };

/* ---------------- dashboard ---------------- */
VIEWS.dashboard = () => {
  const s = A.d.stats, P = A.proj;
  const mx = Math.max(1, ...Object.values(s.bySource));
  return `<h2>Dashboard</h2><p class="sub">Your loan book at a glance, plus a projection for TikTok & Meta expansion.</p>
  <div class="kpis">
   <div class="kpi"><div class="k">Pending applications</div><div class="v">${s.pending}</div></div>
   <div class="kpi"><div class="k">Approved, not yet paid out</div><div class="v">${s.approved}</div></div>
   <div class="kpi"><div class="k">Active loans</div><div class="v">${s.active}</div></div>
   <div class="kpi"><div class="k">Overdue loans</div><div class="v" style="color:${s.overdue ? 'var(--danger)' : 'inherit'}">${s.overdue}</div></div>
   <div class="kpi"><div class="k">Lent out (active)</div><div class="v">${RM0(s.disbursed)}</div></div>
   <div class="kpi"><div class="k">Outstanding</div><div class="v">${RM0(s.outstanding)}</div></div>
   <div class="kpi"><div class="k">Collected (all time)</div><div class="v">${RM0(s.collected)}</div></div>
  </div>
  <div class="grid2 mt">
   <div class="card"><div class="row between"><h3>Due or overdue (next 7 days)</h3><button class="btn sm" onclick="A.remind.audience='due7';show('reminders')">Send reminders</button></div>
   <table class="mt8"><tbody>${s.dueSoon.map(l => { const d = dBetween(s.today, l.next.due); return `<tr class="click" onclick="openLoan(${l.id})"><td><b>${esc(l.borrower.name)}</b><div class="tiny muted">${l.ref}</div></td><td class="num">${RM(l.overdue || l.next.amount)}</td><td class="num"><span class="badge ${d < 0 ? 'b-overdue' : 'b-pending'}">${d < 0 ? -d + 'd overdue' : d === 0 ? 'Today' : 'In ' + d + 'd'}</span></td></tr>`; }).join('') || '<tr><td class="muted">Nothing due in the next 7 days.</td></tr>'}</tbody></table></div>
   <div class="card"><h3>Applications by source</h3>${Object.keys(s.bySource).length ? Object.entries(s.bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="hbar"><span>${SRC[k] || k}</span><div class="t"><span style="width:${v / mx * 100}%"></span></div><b class="num">${v}</b></div>`).join('') : '<p class="muted tiny">No applications yet.</p>'}</div>
  </div>
  <div class="card mt proj"><h3>Expansion projection: TikTok & Meta ads</h3><p class="muted tiny" style="margin:2px 0 0">Change the numbers to match what you expect. Illustrative only.</p>
   <div class="grid3 mt8">${[['budget', 'Monthly ad budget (RM)'], ['cpl', 'Cost per application (RM)'], ['appr', 'Approval rate (%)'], ['avg', 'Average loan size (RM)'], ['tenure', 'Average tenure (months)'], ['rate', 'Interest rate (% p.a.)'], ['def', 'Expected bad debt (%)']].map(([k, v]) => `<div><label class="f">${v}</label><input class="in" type="number" min="0" value="${P[k]}" oninput="A.proj.${k}=+this.value;projOut()"></div>`).join('')}</div>
   <div id="projOut"></div></div>`;
};
window.projOut = () => {
  const P = A.proj, el = $('#projOut'); if (!el) return;
  const leads = P.cpl > 0 ? P.budget / P.cpl : 0, loans = leads * P.appr / 100, disb = loans * P.avg, int = disb * Math.min(P.rate, 18) / 100 * P.tenure / 12, loss = disb * P.def / 100, net = int - loss - P.budget, cpa = loans ? P.budget / loans : 0;
  el.innerHTML = `<div class="out">
   <div class="o"><span class="muted tiny">New applications / month</span><b>${Math.round(leads).toLocaleString()}</b></div>
   <div class="o"><span class="muted tiny">New loans / month</span><b>${Math.round(loans).toLocaleString()}</b></div>
   <div class="o"><span class="muted tiny">Ad cost per new loan</span><b>${RM0(cpa)}</b></div>
   <div class="o"><span class="muted tiny">New lending / month</span><b>${RM0(disb)}</b></div>
   <div class="o"><span class="muted tiny">Interest over loan life</span><b>${RM0(int)}</b></div>
   <div class="o hl"><span class="muted tiny">After bad debt & ad spend</span><b>${RM0(net)}</b></div></div>
   ${P.rate > 18 ? '<p class="err">Rate capped at 18% p.a. in this projection (legal limit for unsecured loans).</p>' : ''}
   <p class="tiny muted" style="margin:10px 0 0">Over a year that's about ${Math.round(loans * 12).toLocaleString()} new borrowers and ${RM0(disb * 12)} lent, which needs that much capital available.</p>`;
};

/* ---------------- applications ---------------- */
VIEWS.apps = () => {
  const F = [['all', 'All'], ['pending', 'Pending'], ['approved', 'To pay out'], ['active', 'Active'], ['overdue', 'Overdue'], ['closed', 'Repaid'], ['rejected', 'Rejected']];
  return `<h2>Applications & loans</h2><p class="sub">Review applications, pay out approved loans, record repayments. Tap a row to open it.</p>
  <div class="row wrap between"><div class="chips">${F.map(([k, v]) => `<button class="chip ${A.filter === k ? 'on' : ''}" onclick="A.filter='${k}';show('apps')">${v}</button>`).join('')}</div>
  <input class="in" style="max-width:260px" placeholder="Search name, phone or loan ID" value="${esc(A.q)}" oninput="searchLoans(this.value)"></div>
  <div class="card mt tw" style="padding:6px 8px;overflow-x:auto"><table class="rt"><thead><tr><th>Loan</th><th>Borrower</th><th>Product & terms</th><th class="num">Amount</th><th>Source</th><th>Next payment</th><th>Status</th></tr></thead><tbody>
  ${A.d.loans.map(l => `<tr class="click" onclick="openLoan(${l.id})"><td class="mono" data-l="Loan">${l.ref}</td><td data-l="Borrower"><div><b>${esc(l.borrower.name)}</b><div class="tiny muted">${esc(l.borrower.phone)}</div></div></td>
   <td data-l="Terms"><div>${esc(l.product)}<div class="tiny muted">${l.rate}% · ${l.months} mo · ${FREQ[l.freq].toLowerCase()}${l.plan === 'stepup' ? ' · start lower' : ''}</div></div></td>
   <td class="num" data-l="Amount"><b>${RM0(l.amount)}</b></td><td data-l="Source">${SRC[l.source] || esc(l.source)}</td>
   <td data-l="Next payment"><div>${l.next && ['active', 'overdue'].includes(l.state) ? `${RM(l.next.amount)}<div class="tiny muted">${fd(l.next.due)}</div>` : '<span class="muted">–</span>'}</div></td>
   <td data-l="Status"><span class="badge b-${l.state}">${l.state}</span></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No loans here.</td></tr>'}
  </tbody></table></div>`;
};
let sTimer; window.searchLoans = v => { A.q = v; clearTimeout(sTimer); sTimer = setTimeout(() => show('apps'), 300); };
window.openLoan = id => { A.loanId = id; show('loan'); };

VIEWS.loan = () => {
  const l = A.d.loan, b = l.borrower, st = l.state, today = todayMY();
  let actions = '';
  if (st === 'pending') actions = `<div class="card"><h3>Decision</h3><label class="f">Note (optional, internal)</label><input class="in" id="dnote" placeholder="e.g. payslip checked">
    <div class="row mt"><button class="btn primary" onclick="decide('approve')">Approve</button><button class="btn danger" onclick="decide('reject')">Reject</button></div>
    <p class="tiny muted mt8">Approving sends the borrower a notification and reports "Loan approved" to your ad platforms.</p></div>`;
  else if (st === 'approved') actions = `<div class="card"><h3>Pay out</h3><p class="tiny muted" style="margin:2px 0 0">After transferring the money, mark it as paid out. The repayment schedule starts from this date.</p>
    <label class="f">Date money was sent</label><input class="in" type="date" id="dstart" value="${today}" style="max-width:220px">
    <button class="btn primary mt" onclick="disburse()">Mark as paid out</button></div>`;
  else if (['active', 'overdue'].includes(st)) actions = `<div class="card"><h3>Record a payment</h3>
    <div class="grid3"><div><label class="f">Amount received (RM)</label><input class="in" id="pamt" type="number" step="0.01" value="${(l.overdue || l.next?.amount || 0).toFixed(2)}"></div>
    <div><label class="f">Method</label><select class="in" id="pmeth">${['Bank transfer', 'DuitNow', 'Cash', 'Cheque', 'Other'].map(m => `<option>${m}</option>`).join('')}</select></div>
    <div><label class="f">Reference</label><input class="in" id="pref" placeholder="Bank ref no."></div></div>
    <div class="row mt wrap"><button class="btn primary" onclick="recordPay()">Record payment</button><button class="btn" onclick="remindOne(${l.id},'${st}')">Send reminder</button></div>
    <p class="tiny muted mt8">Payments go to the oldest unpaid instalment first. Partial payments are fine.</p></div>`;
  const inst = l.instalments || [];
  return `<button class="linkbtn" onclick="show('apps')">← All applications</button>
  <div class="row between wrap mt8"><h2>${esc(l.ref)} · ${esc(b.name)}</h2><span class="badge b-${st}" style="font-size:13px">${st}</span></div>
  <p class="sub">${esc(l.product)} · ${RM0(l.amount)} · ${l.rate}% p.a. · ${l.months} months · ${FREQ[l.freq].toLowerCase()}${l.plan === 'stepup' ? ' · start lower' : ''}</p>
  ${['active', 'overdue', 'closed'].includes(st) ? `<div class="kpis" style="margin-bottom:16px"><div class="kpi"><div class="k">Total to repay</div><div class="v">${RM(l.total)}</div></div><div class="kpi"><div class="k">Paid</div><div class="v">${RM(l.paid)}</div></div><div class="kpi"><div class="k">Balance</div><div class="v">${RM(l.balance)}</div></div><div class="kpi"><div class="k">Overdue</div><div class="v" style="color:${l.overdue ? 'var(--danger)' : 'inherit'}">${RM(l.overdue)}</div></div></div>` : ''}
  <div class="grid2">
   <div style="display:flex;flex-direction:column;gap:16px">${actions}
    <div class="card"><h3>Borrower</h3><dl class="kv mt8"><dt>Name</dt><dd>${esc(b.name)}</dd><dt>Mobile</dt><dd><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a> · <a href="https://wa.me/6${esc(b.phone).replace(/^0/, '')}" target="_blank">WhatsApp</a></dd><dt>MyKad</dt><dd>${esc(b.ic || '–')}</dd><dt>Email</dt><dd>${esc(b.email || '–')}</dd><dt>Monthly income</dt><dd>${b.income ? RM0(b.income) : '–'}</dd><dt>Employment</dt><dd>${esc(b.employment || '–')}</dd><dt>Applied</dt><dd>${fdt(l.appliedAt)}</dd>${l.notes ? `<dt>Note</dt><dd>${esc(l.notes)}</dd>` : ''}</dl>
     <details class="mt"><summary class="linkbtn">Reset login PIN</summary><div class="row mt8"><input class="in" id="newpin" inputmode="numeric" maxlength="6" placeholder="New 6-digit PIN" style="max-width:180px"><button class="btn sm" onclick="resetPin(${b.id})">Reset</button></div></details></div>
    <div class="card"><h3>Ad attribution</h3><dl class="kv mt8"><dt>Source</dt><dd>${SRC[l.source] || esc(l.source)}</dd><dt>Click ID</dt><dd class="mono">${esc(l.clickId || '–')}</dd><dt>UTM</dt><dd class="mono">${esc(l.tracking.utm || '–')}</dd><dt>Meta fbc / fbp</dt><dd class="mono">${esc(l.tracking.fbc || '–')} / ${esc(l.tracking.fbp || '–')}</dd><dt>TikTok _ttp</dt><dd class="mono">${esc(l.tracking.ttp || '–')}</dd></dl>
     <div class="mt">${l.events.map(e => `<div class="ev"><span class="dot ${e.status}"></span><div class="grow"><b>${EVN[e.ev] || e.ev}</b> → ${esc(e.dest)}<div class="tiny muted">${fdt(e.created_at)} · ${e.status}</div></div></div>`).join('') || '<p class="tiny muted">No conversion events yet.</p>'}</div></div>
   </div>
   <div style="display:flex;flex-direction:column;gap:16px">
    ${inst.length ? `<div class="card"><h3>Repayment schedule</h3><div class="sched mt8">${inst.map(i => `<div><span>#${i.idx} · ${fd(i.due)}</span><span>${RM(i.amount)} ${i.paid >= i.amount - 0.005 ? '<span class="badge b-active">Paid</span>' : i.paid > 0 ? `<span class="badge b-pending">${RM(i.paid)} paid</span>` : i.due < today ? '<span class="badge b-overdue">Late</span>' : ''}</span></div>`).join('')}</div></div>` : ''}
    <div class="card"><h3>Payments</h3>${l.payments.length ? l.payments.map(p => `<div class="ev"><span class="dot sent"></span><div class="grow"><b>${RM(p.amount)}</b> · ${esc(p.method || '')} ${p.reference ? '· ' + esc(p.reference) : ''}<div class="tiny muted">${fdt(p.created_at)}</div></div></div>`).join('') : '<p class="tiny muted">No payments yet.</p>'}</div>
    <div class="card"><h3>Messages sent</h3>${l.reminders.length ? l.reminders.map(r => `<div class="ev"><span class="dot sent"></span><div class="grow">${esc(r.body)}<div class="tiny muted">${fdt(r.created_at)} · ${esc(r.channels)} · ${esc(r.status)}</div></div></div>`).join('') : '<p class="tiny muted">No reminders sent yet.</p>'}</div>
   </div></div>`;
};
window.decide = act(async d => { await api(`/loans/${A.loanId}/decide`, { decision: d, note: $('#dnote').value }); toast(d === 'approve' ? 'Approved' : 'Rejected'); reload(); });
window.disburse = act(async () => { await api(`/loans/${A.loanId}/disburse`, { startDate: $('#dstart').value }); toast('Marked as paid out. Schedule created'); reload(); });
window.recordPay = act(async () => { const r = await api(`/loans/${A.loanId}/payments`, { amount: +$('#pamt').value, method: $('#pmeth').value, reference: $('#pref').value }); toast('Recorded ' + RM(r.applied)); reload(); });
window.resetPin = act(async id => { await api(`/borrowers/${id}/reset-pin`, { pin: $('#newpin').value }); toast('PIN reset. Tell the borrower their new PIN'); $('#newpin').value = ''; });
window.remindOne = (id, st) => { Object.assign(A.remind, { audience: 'one', loanId: String(id), template: st === 'overdue' ? TPL.missed : TPL.before }); show('reminders'); };

/* ---------------- products ---------------- */
VIEWS.products = () => {
  const TEN = [3, 4, 6, 9, 12, 18, 24, 36, 48, 60];
  return `<h2>Loan products</h2><p class="sub">Set interest rates, amounts, repayment periods and payment frequencies. Press Save on a product to update the app.</p>
  <div class="note green" style="margin-bottom:16px">The server rejects rates above <b>18% p.a.</b> (unsecured) or <b>12% p.a.</b> (secured), and any plan where interest would exceed the amount borrowed. Interest is simple (flat).</div>
  ${A.d.products.map(o => {
    const p = A.d.pedit[o.id], cap = p.secured ? CAP.secured : CAP.unsecured, ex = Math.min(p.max, Math.max(p.min, 5000)), exT = p.tenures.includes(12) ? 12 : p.tenures[0];
    const dirty = JSON.stringify(p) !== JSON.stringify(o);
    return `<div class="card pcard"><div class="row between wrap"><div class="row"><input class="in" style="font-weight:700;max-width:260px" value="${esc(p.name)}" oninput="pe(${o.id},'name',this.value)"><span class="badge ${p.active ? 'b-active' : ''}">${p.active ? 'Live in app' : 'Hidden'}</span></div>
     <div class="row"><span class="tiny muted">Show in app</span><button class="switch ${p.active ? 'on' : ''}" onclick="pe(${o.id},'active',${!p.active},1)" aria-label="Show in app"></button></div></div>
     <div class="grid3">
      <div><label class="f">Short description</label><input class="in" value="${esc(p.descr)}" oninput="pe(${o.id},'descr',this.value)"></div>
      <div><label class="f">Loan type</label><select class="in" onchange="pe(${o.id},'secured',this.value==='1',1)"><option value="0" ${!p.secured ? 'selected' : ''}>Unsecured (max 18%)</option><option value="1" ${p.secured ? 'selected' : ''}>Secured (max 12%)</option></select></div>
      <div><label class="f">Interest rate (% per year, max ${cap})</label><input class="in" type="number" step="0.5" min="0" max="${cap}" value="${p.rate}" onchange="pe(${o.id},'rate',+this.value,1)"><div class="tiny muted" style="margin-top:4px">= ${r2(p.rate / 12)}% per month</div></div>
      <div><label class="f">Minimum amount (RM)</label><input class="in" type="number" step="100" value="${p.min}" onchange="pe(${o.id},'min',+this.value,1)"></div>
      <div><label class="f">Maximum amount (RM)</label><input class="in" type="number" step="100" value="${p.max}" onchange="pe(${o.id},'max',+this.value,1)"></div>
     </div>
     <label class="f">Repayment periods offered (months)</label><div class="chips">${TEN.map(t => `<button class="chip ${p.tenures.includes(t) ? 'on' : ''}" onclick="ptog(${o.id},'tenures',${t})">${t}</button>`).join('')}</div>
     ${p.tenures.some(t => t <= 3) ? '<p class="err">Heads-up: Meta doesn\'t allow ads for loans repaid in full within 90 days. Keep 3-month plans out of ad campaigns.</p>' : ''}
     <label class="f">Payment frequency offered</label><div class="chips">${Object.entries(FREQ).map(([k, v]) => `<button class="chip ${p.freqs.includes(k) ? 'on' : ''}" onclick="ptog(${o.id},'freqs','${k}')">${v}</button>`).join('')}</div>
     <div class="tiny muted mt8">Example: ${RM0(ex)} over ${exT} months monthly = ${RM(quote(ex, p.rate, exT, 'monthly').amts[0])}/month</div>
     <div class="row mt"><button class="btn primary" ${dirty ? '' : 'disabled'} onclick="psave(${o.id})">Save changes</button>${dirty ? `<button class="btn" onclick="preset(${o.id})">Undo</button>` : ''}<span class="grow"></span><button class="btn sm danger" onclick="pdel(${o.id})">Delete</button></div>
    </div>`;
  }).join('')}
  <button class="btn" onclick="padd()">+ Add loan product</button>`;
};
window.pe = (id, k, v, redraw) => { A.d.pedit[id][k] = v; if (redraw) draw(); else { const b = document.activeElement.closest('.card').querySelector('.btn.primary'); if (b) b.disabled = false; } };
window.ptog = (id, k, v) => { const a = A.d.pedit[id][k]; const i = a.indexOf(v); i >= 0 ? a.splice(i, 1) : a.push(v); if (k === 'tenures') a.sort((x, y) => x - y); draw(); };
window.preset = id => { A.d.pedit[id] = structuredClone(A.d.products.find(p => p.id === id)); draw(); };
window.psave = act(async id => { await api('/products/' + id, A.d.pedit[id], 'PUT'); toast('Saved. The app is updated'); reload(); });
window.pdel = act(async id => { if (!confirmBox('Delete this product?')) return; await api('/products/' + id, null, 'DELETE'); toast('Deleted'); reload(); });
window.padd = act(async () => { await api('/products', { name: 'New loan product', descr: 'Describe who this is for', secured: false, rate: 18, min: 1000, max: 10000, tenures: [6, 12], freqs: ['monthly'], active: false }); toast('Added (hidden until you switch it on)'); reload(); });
const confirmBox = msg => window.confirm(msg);

/* ---------------- reminders ---------------- */
VIEWS.reminders = () => {
  const R = A.remind, { rules, sendHour } = A.d.rules;
  return `<h2>Repayment reminders</h2><p class="sub">Send reminders now or schedule them. Automatic reminders go out every day at the time you set. Every message also lands in the borrower's in-app inbox.</p>
  <div class="grid2" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)">
  <div class="card"><h3>Send a reminder</h3>
   <label class="f">Who should get it?</label>
   <select class="in" onchange="A.remind.audience=this.value;draw()">${[['due3', 'Payment due in the next 3 days'], ['due7', 'Due or overdue within 7 days'], ['overdue', 'Overdue borrowers'], ['all', 'All active borrowers'], ['one', 'One borrower…']].map(([k, v]) => `<option value="${k}" ${R.audience === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
   ${R.audience === 'one' ? `<select class="in mt8" onchange="A.remind.loanId=this.value;remPreview()"><option value="">Choose a borrower</option>${A.d.actLoans.map(l => `<option value="${l.id}" ${String(R.loanId) === String(l.id) ? 'selected' : ''}>${esc(l.borrower.name)} · ${l.ref}${l.state === 'overdue' ? ' · overdue' : ''}</option>`).join('')}</select>` : ''}
   <label class="f">Send through</label>
   <div class="chips">${Object.entries(CH).map(([k, v]) => `<button class="chip ${R.channels.includes(k) ? 'on' : ''}" onclick="rch('${k}')">${v}</button>`).join('')}</div>
   <label class="f">Message</label>
   <div class="chips" style="margin-bottom:6px">${[['before', 'Before due date'], ['today', 'Due today'], ['missed', 'Missed payment']].map(([k, v]) => `<button class="chip" onclick="A.remind.template=TPLS.${k};draw()">${v}</button>`).join('')}</div>
   <textarea class="in" oninput="A.remind.template=this.value;remPreview()">${esc(R.template)}</textarea>
   <div class="tiny muted" style="margin-top:4px">Fill-ins: <span class="mono">{name} {amount} {due_date} {loan_id} {balance} {days_overdue} {company} {phone}</span></div>
   <label class="f">When</label>
   <div class="row wrap"><div class="seg" style="width:220px"><button class="${R.when === 'now' ? 'on' : ''}" onclick="A.remind.when='now';draw()">Send now</button><button class="${R.when === 'later' ? 'on' : ''}" onclick="A.remind.when='later';draw()">Schedule</button></div>
   ${R.when === 'later' ? `<input class="in" type="datetime-local" style="max-width:230px" value="${esc(R.at)}" onchange="A.remind.at=this.value">` : ''}</div>
   <div id="remPrev" class="mt"></div>
  </div>
  <div style="display:flex;flex-direction:column;gap:16px">
   <div class="card"><h3>Scheduled</h3>${A.d.sched.length ? A.d.sched.map(s => `<div class="ev"><span class="dot"></span><div class="grow"><b>${fdt(s.run_at)}</b> · ${esc(s.audience)}<div class="tiny muted">${esc(s.template.slice(0, 80))}…</div></div><button class="btn sm danger" onclick="cancelSched(${s.id})">Cancel</button></div>`).join('') : '<p class="tiny muted">Nothing scheduled.</p>'}</div>
   <div class="card"><h3>Recently sent</h3>${A.d.rlog.length ? A.d.rlog.slice(0, 15).map(r => `<div class="ev"><span class="dot ${/failed/.test(r.status) ? 'failed' : 'sent'}"></span><div class="grow"><b>${esc(r.name || '')}</b> · ${esc(r.ref || '')} <span class="badge">${esc(r.rule.replace('auto:', 'auto · '))}</span><div class="tiny muted">${fdt(r.created_at)} · ${esc(r.status)}</div></div></div>`).join('') : '<p class="tiny muted">Nothing sent yet.</p>'}</div>
  </div></div>
  <div class="card mt"><div class="row between wrap"><div><h3>Automatic reminders</h3><p class="muted tiny" style="margin:2px 0 0">Checked every 5 minutes. Each instalment gets each reminder once.</p></div>
   <div class="row"><span class="tiny muted">Send from</span><select class="in" style="width:110px" onchange="A.d.rules.sendHour=+this.value">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === sendHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></div></div>
   ${rules.map((r, i) => `<div style="border-top:1px solid #eee8db;padding:12px 0">
    <div class="row between"><b>${esc(r.label)}</b><button class="switch ${r.on ? 'on' : ''}" onclick="A.d.rules.rules[${i}].on=!A.d.rules.rules[${i}].on;draw()" aria-label="Toggle"></button></div>
    ${r.on ? `<div class="chips mt8">${Object.entries(CH).map(([k, v]) => `<button class="chip ${r.channels.includes(k) ? 'on' : ''}" onclick="ruleCh(${i},'${k}')">${v}</button>`).join('')}</div>
    <textarea class="in mt8" style="min-height:70px" oninput="A.d.rules.rules[${i}].template=this.value">${esc(r.template)}</textarea>` : ''}</div>`).join('')}
   <button class="btn primary" onclick="saveRules()">Save automatic reminders</button>
   <p class="tiny muted mt8">SMS, WhatsApp and email go through your messaging webhook (Settings). App notifications work once the borrower turns them on in the app.</p></div>`;
};
window.TPLS = TPL;
window.rch = k => { const c = A.remind.channels; const i = c.indexOf(k); i >= 0 ? c.splice(i, 1) : c.push(k); draw(); };
window.ruleCh = (i, k) => { const c = A.d.rules.rules[i].channels; const j = c.indexOf(k); j >= 0 ? c.splice(j, 1) : c.push(k); draw(); };
let pTimer;
window.remPreview = () => {
  clearTimeout(pTimer);
  pTimer = setTimeout(async () => {
    const el = $('#remPrev'); if (!el) return; const R = A.remind;
    let p; try { p = await api('/reminders/preview', { audience: R.audience, loanId: R.loanId, template: R.template }); } catch { return; }
    if (!$('#remPrev')) return;
    $('#remPrev').innerHTML = `<div class="row between"><b>${p.count} borrower${p.count === 1 ? '' : 's'} will get this</b><span class="tiny muted">${p.names.map(n => esc(n.split(' ')[0])).join(', ')}${p.count > 5 ? ' +' + (p.count - 5) : ''}</span></div>
    ${p.sample ? `<div class="card mt8" style="background:#f7f4ec;padding:12px"><div class="tiny muted">Preview for ${esc(p.sample.name)}</div><div style="margin-top:4px">${esc(p.sample.text)}</div></div>` : ''}
    <button class="btn primary block mt" ${!p.count || !R.channels.length ? 'disabled' : ''} onclick="sendRem(this)">${R.when === 'now' ? 'Send now' : 'Schedule'} · ${R.channels.map(c => CH[c]).join(' + ') || 'pick a channel'}</button>`;
  }, 250);
};
window.sendRem = act(async btn => {
  const R = A.remind;
  if (R.when === 'later' && !R.at) return toast('Pick a date and time first', true);
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  const r = await api('/reminders/send', { audience: R.audience, loanId: R.loanId, channels: R.channels, template: R.template, runAt: R.when === 'later' ? new Date(R.at).toISOString() : null });
  toast(r.scheduled ? 'Scheduled' : `Sent to ${r.sent} borrower${r.sent === 1 ? '' : 's'}`); reload();
});
window.cancelSched = act(async id => { await api('/reminders/scheduled/' + id, null, 'DELETE'); toast('Cancelled'); reload(); });
window.saveRules = act(async () => { await api('/reminders/rules', A.d.rules, 'PUT'); toast('Automatic reminders saved'); reload(); });

/* ---------------- tracking ---------------- */
const META_EV = ['', 'ViewContent', 'Lead', 'SubmitApplication', 'CompleteRegistration', 'Purchase', 'Subscribe', 'LoanApproved', 'Repayment'];
const TT_EV = ['', 'ViewContent', 'SubmitForm', 'CompleteRegistration', 'PlaceAnOrder', 'CompletePayment', 'Subscribe'];
VIEWS.tracking = () => {
  const T = A.d.tracking;
  const f = (lab, plat, k, ph, pw) => `<label class="f">${lab}</label><input class="in mono" ${pw ? 'type="password" autocomplete="off"' : ''} placeholder="${ph}" value="${esc(T[plat][k] || '')}" oninput="A.d.tracking.${plat}.${k}=this.value.trim()">`;
  const st = p => T[p].pixel && T[p].token ? '<span class="badge b-active">Connected</span>' : T[p].pixel ? '<span class="badge b-pending">Token missing</span>' : '<span class="badge">Not connected</span>';
  return `<h2>Meta & TikTok tracking</h2><p class="sub">Every application, approval, payout and repayment is reported to Meta and TikTok from your server (Conversions API / Events API). The browser pixel also loads in the app, using the same event IDs so nothing is double counted.</p>
  <div class="grid2">
   <div class="card"><div class="row between"><h3>Meta (Facebook & Instagram)</h3>${st('meta')}</div>
    ${f('Pixel / Dataset ID', 'meta', 'pixel', 'e.g. 123456789012345')}${f('Conversions API access token', 'meta', 'token', 'Paste from Events Manager → Settings', 1)}
    <div class="grid2" style="gap:10px">${f('Test event code (optional)', 'meta', 'test', 'TEST12345')}${f('Graph API version', 'meta', 'version', 'v21.0')}</div>
    <p class="tiny muted" style="margin:8px 0 0">Events Manager → your dataset → Settings → Conversions API → Generate access token. Remove the test code when you go live.</p></div>
   <div class="card"><div class="row between"><h3>TikTok</h3>${st('tt')}</div>
    ${f('Pixel code', 'tt', 'pixel', 'e.g. C4ABCDEFGHIJK')}${f('Events API access token', 'tt', 'token', 'Paste from Events Manager → Settings', 1)}${f('Test event code (optional)', 'tt', 'test', 'TEST12345')}
    <p class="tiny muted" style="margin:8px 0 0">TikTok Ads Manager → Tools → Events → your pixel → Settings → Events API → Generate access token.</p></div>
  </div>
  <div class="card mt"><h3>Which events to send</h3><p class="muted tiny" style="margin:2px 0 8px">Choose the Meta and TikTok event for each step. Blank means don't send.</p>
  <table class="rt"><thead><tr><th>Step in your app</th><th>Meta event</th><th>TikTok event</th><th class="num">Value sent</th></tr></thead><tbody>
  ${Object.keys(EVN).map(k => `<tr><td><b>${EVN[k]}</b>${k === 'calc' ? '<div class="tiny muted">browser pixel only</div>' : ''}</td>
   <td data-l="Meta"><select class="in" style="max-width:220px" onchange="A.d.tracking.map.${k}.meta=this.value">${META_EV.map(e => `<option value="${e}" ${T.map[k].meta === e ? 'selected' : ''}>${e || '— don’t send —'}${['LoanApproved', 'Repayment'].includes(e) ? ' (custom)' : ''}</option>`).join('')}</select></td>
   <td data-l="TikTok"><select class="in" style="max-width:220px" onchange="A.d.tracking.map.${k}.tt=this.value">${TT_EV.map(e => `<option value="${e}" ${T.map[k].tt === e ? 'selected' : ''}>${e || '— don’t send —'}</option>`).join('')}</select></td>
   <td class="num tiny muted" data-l="Value">${k === 'calc' ? '–' : k === 'repayment' ? 'Amount paid' : 'Loan amount (MYR)'}</td></tr>`).join('')}
  </tbody></table>
  <div class="row mt wrap"><button class="btn primary" onclick="saveTracking()">Save</button><button class="btn" onclick="testTracking(this)">Send test event</button><span class="tiny muted">The test sends a sample "Application submitted" to Meta and TikTok. Check the Event log for the reply.</span></div></div>
  <div class="note mt">Phone numbers, emails and names are SHA-256 hashed before sending. Tokens stay on your server and are never sent to borrowers' phones.</div>`;
};
window.saveTracking = act(async () => { await api('/tracking', A.d.tracking, 'PUT'); toast('Saved'); reload(); });
window.testTracking = act(async btn => { btn.disabled = true; await api('/tracking', A.d.tracking, 'PUT'); await api('/tracking/test', {}); toast('Test sent. Opening Event log'); show('events'); });

/* ---------------- postbacks ---------------- */
VIEWS.postback = () => {
  const host = location.host;
  return `<h2>S2S postbacks</h2><p class="sub">Report conversions server-to-server to affiliate networks or trackers (Voluum, RedTrack, Keitaro, Everflow…). When a visitor lands with a click ID, the app stores it and calls your postback URL at the steps you choose.</p>
  <div class="card"><h3>1 · Your tracking link</h3><p class="muted tiny" style="margin:2px 0 8px">Give this to partners. They replace the brackets with their own click ID macro.</p>
   <div class="mono" style="background:#f5f1e7;padding:10px 12px;border-radius:10px;word-break:break-all">https://${esc(host)}/?click_id=<b>{partner_click_id}</b>&amp;utm_source=<b>{partner_name}</b></div>
   <p class="tiny muted" style="margin:8px 0 0">Also captured automatically: <span class="mono">ttclid</span> (TikTok), <span class="mono">fbclid</span> (Meta), <span class="mono">clickid</span>, <span class="mono">cid</span> and all <span class="mono">utm_*</span> tags. Kept for 30 days on the visitor's phone.</p></div>
  <div class="card mt"><div class="row between"><h3>2 · Postback URLs</h3><button class="btn sm" onclick="pbAdd()">+ Add postback</button></div>
   <p class="muted tiny" style="margin:4px 0 0">Macros: ${['click_id', 'event', 'amount', 'loan_id', 'source', 'txid', 'currency', 'timestamp'].map(m => `<span class="mono" style="background:#f5f1e7;padding:1px 5px;border-radius:5px">{${m}}</span>`).join(' ')}</p>
   ${A.d.postbacks.map((p, i) => `<div style="border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:12px">
    <div class="row between wrap"><input class="in" style="max-width:280px;font-weight:700" value="${esc(p.name)}" oninput="A.d.postbacks[${i}].name=this.value"><div class="row"><span class="tiny muted">Active</span><button class="switch ${p.active ? 'on' : ''}" onclick="A.d.postbacks[${i}].active=!A.d.postbacks[${i}].active;draw()" aria-label="Active"></button></div></div>
    <div class="row mt8 pbrow" style="align-items:stretch"><select class="in" style="width:90px" onchange="A.d.postbacks[${i}].method=this.value">${['GET', 'POST'].map(m => `<option ${p.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <input class="in mono grow" value="${esc(p.url)}" oninput="A.d.postbacks[${i}].url=this.value.trim()" placeholder="https://tracker.com/postback?cid={click_id}&event={event}&payout={amount}"></div>
    <label class="f">Fire on</label><div class="chips">${Object.keys(EVN).filter(k => k !== 'calc').map(k => `<button class="chip ${p.events[k] ? 'on' : ''}" onclick="A.d.postbacks[${i}].events.${k}=!A.d.postbacks[${i}].events.${k};draw()">${EVN[k]}</button>`).join('')}</div>
    <div class="row mt wrap"><button class="btn primary sm" onclick="pbSave(${i})">Save</button><button class="btn sm" onclick="pbTest(${i},this)">Test fire</button><span class="grow"></span><button class="btn sm danger" onclick="pbDel(${p.id})">Delete</button></div>
    <div id="pbres${p.id}"></div></div>`).join('') || '<p class="muted mt">No postbacks yet.</p>'}
  </div>
  <div class="card mt"><h3>Recent postbacks</h3>${evRows(A.d.events.filter(e => e.dest.startsWith('Postback') || e.dest === 'S2S postback').slice(0, 15))}</div>`;
};
window.pbAdd = act(async () => { await api('/postbacks', { name: 'New partner', method: 'GET', url: 'https://', events: { lead: true, disbursed: true }, active: false }); reload(); });
window.pbSave = act(async i => { const p = A.d.postbacks[i]; await api('/postbacks/' + p.id, p, 'PUT'); toast('Saved'); reload(); });
window.pbDel = act(async id => { if (!confirmBox('Delete this postback?')) return; await api('/postbacks/' + id, null, 'DELETE'); reload(); });
window.pbTest = act(async (i, btn) => {
  const p = A.d.postbacks[i]; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  await api('/postbacks/' + p.id, p, 'PUT');
  const e = await api(`/postbacks/${p.id}/test`, {});
  $('#pbres' + p.id).innerHTML = `<div class="mt8"><span class="badge b-${e.status}">${e.status}</span><pre class="code">${esc(prettyReq(e.request))}\n\nResponse: ${esc(e.response)}</pre></div>`;
  btn.disabled = false; btn.textContent = 'Test fire';
});
const prettyReq = s => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

/* ---------------- events ---------------- */
function evRows(list) {
  if (!list.length) return '<p class="muted tiny">No events yet.</p>';
  return `<table class="rt"><thead><tr><th>Time</th><th>Step</th><th>Sent to</th><th>Loan</th><th>Status</th><th></th></tr></thead><tbody>${list.map(e => `<tr><td data-l="Time" class="tiny">${fdt(e.created_at)}</td><td data-l="Step"><b>${EVN[e.ev] || esc(e.ev)}</b></td><td data-l="Sent to">${esc(e.dest)}</td><td data-l="Loan" class="mono">${esc(e.loan_ref || '–')}</td><td data-l="Status"><span class="badge b-${e.status}">${e.status}</span></td>
   <td>${e.status === 'skipped' ? `<span class="tiny muted">${esc(e.request)}</span>` : `<button class="linkbtn" onclick="A.openEv=A.openEv===${e.id}?null:${e.id};draw()">${A.openEv === e.id ? 'Hide' : 'Details'}</button>`}</td></tr>
   ${A.openEv === e.id ? `<tr><td colspan="6" class="full"><pre class="code">${esc(prettyReq(e.request))}\n\nResponse: ${esc(e.response || '')}</pre></td></tr>` : ''}`).join('')}</tbody></table>`;
}
VIEWS.events = () => {
  const ev = A.d.events, c = s => ev.filter(e => e.status === s).length;
  return `<h2>Event log</h2><p class="sub">Every conversion sent to Meta, TikTok and postback partners, with the exact request and the platform's reply.</p>
  <div class="kpis" style="margin-bottom:16px"><div class="kpi"><div class="k">Sent</div><div class="v">${c('sent')}</div></div><div class="kpi"><div class="k">Failed</div><div class="v" style="color:${c('failed') ? 'var(--danger)' : 'inherit'}">${c('failed')}</div></div><div class="kpi"><div class="k">Skipped</div><div class="v">${c('skipped')}</div></div></div>
  <div class="row"><button class="btn sm" onclick="reload()">Refresh</button></div>
  <div class="card mt tw" style="overflow-x:auto">${evRows(ev)}</div>`;
};
window.reload = reload;

/* ---------------- settings ---------------- */
VIEWS.settings = () => {
  const s = A.d.settings;
  const f = (k, l, ph = '') => `<label class="f">${l}</label><input class="in" value="${esc(s[k])}" placeholder="${ph}" oninput="A.d.settings.${k}=this.value">`;
  return `<h2>Settings</h2><p class="sub">Company details shown to borrowers, payment instructions, and messaging.</p>
  <div class="grid2">
   <div class="card"><h3>Company</h3>${f('company', 'Company name')}${f('licence', 'KPKT licence number')}${f('phone', 'Customer service phone')}${f('domain', 'App domain', 'pinjaman.example.com')}</div>
   <div class="card"><h3>How borrowers pay</h3><p class="tiny muted" style="margin:2px 0 0">Shown on each loan in the app, with the loan ID as the payment reference.</p>${f('bank_name', 'Bank')}${f('bank_account_name', 'Account name')}${f('bank_account_no', 'Account number')}</div>
  </div>
  <div class="card mt"><h3>SMS / WhatsApp / email webhook</h3>
   <p class="tiny muted" style="margin:2px 0 0">The app POSTs each SMS, WhatsApp or email reminder to this URL. Point it at an n8n or Make workflow, or a small script, that sends through your provider (e.g. Twilio, WATI, 360dialog, MoceanAPI).</p>
   <label class="f">Webhook URL</label><input class="in mono" value="${esc(s.messaging.webhook_url)}" placeholder="https://n8n.yourdomain.com/webhook/loan-reminders" oninput="A.d.settings.messaging.webhook_url=this.value">
   <label class="f">Secret (sent as X-Webhook-Secret header)</label><input class="in mono" type="password" autocomplete="off" value="${esc(s.messaging.webhook_secret)}" oninput="A.d.settings.messaging.webhook_secret=this.value">
   <details class="mt8"><summary class="linkbtn">What the app sends</summary><pre class="code">${esc(JSON.stringify({ channel: 'wa', to: '+60123456789', phone_local: '0123456789', email: null, name: 'Aisyah Rahman', message: 'Hi Aisyah, just a reminder…', loan_ref: 'L1001' }, null, 2))}</pre></details>
  </div>
  <button class="btn primary mt" onclick="saveSettings()">Save settings</button>
  <div class="card mt"><h3>Change your password</h3><div class="grid3"><div><label class="f">Current password</label><input class="in" type="password" id="pw1" autocomplete="current-password"></div><div><label class="f">New password (10+ characters)</label><input class="in" type="password" id="pw2" autocomplete="new-password"></div></div>
   <button class="btn mt" onclick="changePw()">Change password</button></div>`;
};
window.saveSettings = act(async () => { await api('/settings', A.d.settings, 'PUT'); A.company = A.d.settings.company; $('#coName').textContent = A.company; toast('Settings saved'); reload(); });
window.changePw = act(async () => { await api('/password', { current: $('#pw1').value, next: $('#pw2').value }); toast('Password changed'); $('#pw1').value = $('#pw2').value = ''; });

/* ---------------- boot ---------------- */
async function boot() {
  try { A.me = await api('/me'); } catch { A.me = null; }
  if (A.me) { try { const c = await fetch('/api/config').then(r => r.json()); A.company = c.company; document.title = c.company + ' · Admin'; const s = await api('/stats'); A.pending = s.pending; } catch { /* ignore */ } }
  renderRoot();
}
boot();
