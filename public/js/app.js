import { quote, dueDates, todayMY, FREQ, FREQ_SHORT, r2 } from './loanmath.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RM = n => 'RM ' + Number(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RM0 = n => 'RM ' + Math.round(n).toLocaleString('en-MY');
const fd = s => new Date(String(s).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fdt = s => new Date(String(s).replace(' ', 'T') + (/Z|\+/.test(s) ? '' : 'Z')).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
function toast(t, bad) { const el = $('#toast'); el.textContent = t; el.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toast._t); toast._t = setTimeout(() => el.className = '', 3200); }
async function api(path, body, method) {
  const r = await fetch('/api' + path, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Something went wrong'); e.status = r.status; throw e; }
  return data;
}

/* ---------- state ---------- */
const S = { cfg: null, products: [], me: null, screen: 'home', prodId: null, amount: 5000, months: 12, freq: 'monthly', plan: 'equal', showSched: false, openLoan: null, calcFired: false, lastRef: null, busy: false, loginErr: '', applyErr: '' };

/* ---------- ad attribution: capture click IDs from the landing link ---------- */
(function captureAttribution() {
  const q = new URLSearchParams(location.search);
  const prev = store.get('attr');
  const fresh = prev && Date.now() - prev.ts < 30 * 864e5 ? prev : null;
  let a = null;
  const utm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].filter(k => q.get(k)).map(k => `${k}=${q.get(k)}`).join('&');
  if (q.get('ttclid')) a = { source: 'tiktok', clickId: q.get('ttclid') };
  else if (q.get('fbclid')) a = { source: 'meta', clickId: q.get('fbclid'), fbc: `fb.1.${Date.now()}.${q.get('fbclid')}` };
  else if (q.get('click_id') || q.get('clickid') || q.get('cid')) a = { source: 'affiliate', clickId: q.get('click_id') || q.get('clickid') || q.get('cid') };
  else if (q.get('gclid') || /google/i.test(q.get('utm_source') || '')) a = { source: 'google', clickId: null };
  if (a) { a.utm = utm; a.ts = Date.now(); store.set('attr', a); }
  else if (!fresh) store.set('attr', { source: 'organic', clickId: null, utm, ts: Date.now() });
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
})();
const attr = () => store.get('attr') || { source: 'organic' };
const cookie = n => (document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')) || [])[1] || null;

/* ---------- browser pixels (deduplicated with server events by event ID) ---------- */
const META_STD = ['ViewContent', 'Lead', 'SubmitApplication', 'CompleteRegistration', 'Purchase', 'Subscribe', 'Contact', 'Search'];
function loadPixels() {
  const p = S.cfg.pixels;
  if (p.meta) {
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', p.meta); window.fbq('track', 'PageView');
  }
  if (p.tt) {
    !function (w, d, t) { w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || []; ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent']; ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; }; for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]); ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; }; ttq.load = function (e, n) { var r = 'https://analytics.tiktok.com/i18n/pixel/events.js'; ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r; ttq._t = ttq._t || {}; ttq._t[e] = +new Date(); ttq._o = ttq._o || {}; ttq._o[e] = n || {}; var s = document.createElement('script'); s.type = 'text/javascript'; s.async = !0; s.src = r + '?sdkid=' + e + '&lib=' + t; var x = document.getElementsByTagName('script')[0]; x.parentNode.insertBefore(s, x); }; ttq.load(S.cfg.pixels.tt); ttq.page(); }(window, document, 'ttq');
  }
}
function pixelEvent(ev, eventId, value) {
  const m = S.cfg.map[ev] || {};
  const data = value ? { currency: 'MYR', value } : {};
  try {
    if (m.meta && window.fbq) META_STD.includes(m.meta) ? window.fbq('track', m.meta, data, eventId ? { eventID: eventId } : undefined) : window.fbq('trackCustom', m.meta, data, eventId ? { eventID: eventId } : undefined);
    if (m.tt && window.ttq) window.ttq.track(m.tt, { ...data, content_type: 'product' }, eventId ? { event_id: eventId } : undefined);
  } catch { /* never block the app on ad scripts */ }
}

/* ---------- navigation ---------- */
const ICON = {
  home: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  loan: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
  bell: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/></svg>',
  check: '<svg width="56" height="56" viewBox="0 0 56 56"><circle cx="28" cy="28" r="28" fill="#e2efe7"/><path d="M17 29l7 7 15-16" stroke="#14795b" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const SCREENS = ['home', 'apply', 'done', 'login', 'loans', 'inbox'];
window.go = (s, push = true) => {
  if (!SCREENS.includes(s)) s = 'home';
  if ((s === 'loans' || s === 'inbox') && !S.me) { S.after = s; s = 'login'; }
  const changed = S.screen !== s; S.screen = s;
  if (push && location.hash !== '#' + s) history.pushState(null, '', '#' + s);
  render(); if (changed) window.scrollTo(0, 0);
  if (s === 'inbox' && S.me && S.me.notifications.some(n => !n.read)) setTimeout(() => api('/notifications/read', {}).then(() => { S.me.notifications.forEach(n => n.read = 1); renderChrome(); }).catch(() => {}), 1200);
};
window.addEventListener('popstate', () => go(location.hash.slice(1) || 'home', false));

function renderChrome() {
  $('#coName').textContent = S.cfg.company;
  const unread = S.me ? S.me.notifications.filter(n => !n.read).length : 0;
  $('#unread').innerHTML = unread ? `<i>${unread}</i>` : '';
  const on = x => (x.includes(S.screen) ? 'on' : '');
  $('#tabbar').innerHTML = `<button class="${on(['home', 'apply', 'done'])}" onclick="go('home')">${ICON.home}Borrow</button>
    <button class="${on(['loans', 'login'])}" onclick="go('loans')">${ICON.loan}My loans</button>
    <button class="${on(['inbox'])}" onclick="go('inbox')">${ICON.bell}Inbox</button>`;
}
function render() {
  renderChrome();
  const y = window.scrollY;
  const v = { home: homeView, apply: applyView, done: doneView, login: loginView, loans: loansView, inbox: inboxView }[S.screen]();
  $('#view').innerHTML = v;
  if (S.screen === 'home') quoteBox();
  window.scrollTo(0, y);
}

/* ---------- calculator ---------- */
const prod = () => S.products.find(p => p.id === S.prodId);
function fixSel() {
  if (!prod()) S.prodId = S.products[0]?.id;
  const p = prod(); if (!p) return;
  if (!p.tenures.includes(S.months)) S.months = p.tenures.includes(12) ? 12 : p.tenures[0];
  if (!p.freqs.includes(S.freq)) S.freq = p.freqs[0];
  S.amount = Math.min(p.max, Math.max(p.min, S.amount));
}
window.setSel = (k, v) => { S[k] = v; fixSel(); render(); };
window.setAmt = v => { S.amount = +v; $('#amtLbl').textContent = RM0(v); quoteBox(); };
window.toggleSched = () => { S.showSched = !S.showSched; quoteBox(); };

function homeView() {
  fixSel();
  const p = prod();
  if (!p) return '<p class="muted center mt">No loan products available right now.</p>';
  const maxAll = Math.max(...S.products.map(x => x.max));
  const step = p.max >= 50000 ? 1000 : p.max >= 10000 ? 500 : 100;
  return `<div class="hero"><div class="lic">Licensed moneylender · KPKT ${esc(S.cfg.licence)}</div><h2>Borrow up to ${RM0(maxAll)}</h2><p>Pick your amount, how long, and how often you repay. See the full cost before you apply.</p></div>
  ${S.products.length > 1 ? `<div class="sec"><div class="lbl">Choose a loan</div><div class="chips">${S.products.map(x => `<button class="chip ${x.id === S.prodId ? 'on' : ''}" onclick="setSel('prodId',${x.id})">${esc(x.name)}</button>`).join('')}</div></div>` : ''}
  <div class="tiny muted" style="margin-top:6px">${esc(p.descr)} · ${p.rate}% p.a. ${p.secured ? '(secured)' : '(unsecured)'}</div>
  <div class="sec"><div class="row between"><span class="lbl" style="margin:0">How much do you need?</span><b id="amtLbl" style="font-size:17px">${RM0(S.amount)}</b></div>
  <input type="range" min="${p.min}" max="${p.max}" step="${step}" value="${S.amount}" oninput="setAmt(this.value)" aria-label="Loan amount">
  <div class="row between tiny muted"><span>${RM0(p.min)}</span><span>${RM0(p.max)}</span></div></div>
  <div class="sec"><div class="lbl">Repay over</div><div class="chips">${p.tenures.map(m => `<button class="chip ${m === S.months ? 'on' : ''}" onclick="setSel('months',${m})">${m} months</button>`).join('')}</div></div>
  ${p.freqs.length > 1 ? `<div class="sec"><div class="lbl">How often do you want to pay?</div><div class="seg">${p.freqs.map(f => `<button class="${f === S.freq ? 'on' : ''}" onclick="setSel('freq','${f}')">${FREQ[f]}</button>`).join('')}</div></div>` : ''}
  <div class="sec"><div class="lbl">Repayment style</div><div class="seg"><button class="${S.plan === 'equal' ? 'on' : ''}" onclick="setSel('plan','equal')">Same every time</button><button class="${S.plan === 'stepup' ? 'on' : ''}" onclick="setSel('plan','stepup')">Start lower</button></div></div>
  <div id="qbox"></div>
  <button class="btn primary block mt" onclick="go('apply')">Apply for this loan</button>
  <p class="tiny muted center" style="margin:10px 0 0">Simple interest only, as required under the Moneylenders Act 1951.</p>
  ${installBanner()}`;
}
function quoteBox() {
  const el = $('#qbox'); const p = prod(); if (!el || !p) return;
  const q = quote(S.amount, p.rate, S.months, S.freq, S.plan), k = Math.floor(q.n / 2);
  const big = S.plan === 'stepup'
    ? `<div class="tiny muted">First ${k} payments</div><div class="qbig">${RM(q.amts[0])}<span class="tiny muted" style="font-weight:600"> / ${FREQ_SHORT[S.freq]}</span></div><div class="tiny muted">then ${RM(q.amts[k])} for the remaining ${q.n - k}</div>`
    : `<div class="tiny muted">You pay</div><div class="qbig">${RM(q.amts[0])}<span class="tiny muted" style="font-weight:600"> / ${FREQ_SHORT[S.freq]}</span></div>`;
  const dates = dueDates(todayMY(), S.freq, q.n);
  el.innerHTML = `<div class="qbox">${big}<div class="mt8">
  <div class="qline"><span class="muted">Number of payments</span><b>${q.n}</b></div>
  <div class="qline"><span class="muted">Interest rate</span><b>${p.rate}% p.a. (${r2(p.rate / 12)}%/month)</b></div>
  <div class="qline"><span class="muted">Total interest</span><b>${RM(q.interest)}</b></div>
  <div class="qline"><span class="muted">Total to repay</span><b>${RM(q.total)}</b></div></div>
  <button class="linkbtn mt8" onclick="toggleSched()">${S.showSched ? 'Hide' : 'View'} repayment schedule</button>
  ${S.showSched ? `<div class="sched">${q.amts.slice(0, 8).map((a, i) => `<div><span>#${i + 1} · ${fd(dates[i])}</span><b>${RM(a)}</b></div>`).join('')}${q.n > 8 ? `<div><span class="muted">… ${q.n - 8} more payments</span><span class="muted">last on ${fd(dates[q.n - 1])}</span></div>` : ''}</div><p class="tiny muted">Dates assume the money is sent today.</p>` : ''}</div>`;
  if (!S.calcFired) { S.calcFired = true; pixelEvent('calc'); }
}

/* ---------- apply ---------- */
const SRC = { organic: 'Social media / browsing', referral: 'Friend or family', google: 'Google', tiktok: 'TikTok', meta: 'Facebook / Instagram', affiliate: 'Partner website' };
function applyView() {
  const p = prod(); if (!p) return homeView();
  const q = quote(S.amount, p.rate, S.months, S.freq, S.plan); const a = attr();
  const known = !!S.me;
  return `<button class="linkbtn" onclick="go('home')">← Change loan</button>
  <div class="qbox" style="margin-top:10px"><div class="row between"><b>${esc(p.name)}</b><b>${RM0(S.amount)}</b></div>
  <div class="tiny muted mt8">${S.months} months · ${FREQ[S.freq].toLowerCase()} · ${q.n} payments of ${S.plan === 'stepup' ? 'from ' : ''}${RM(q.amts[0])} · total ${RM(q.total)}</div></div>
  <form id="applyForm" onsubmit="submitApply(event)" autocomplete="on">
  ${known ? `<p class="mt">Applying as <b>${esc(S.me.name)}</b> (${esc(S.me.phone)}).</p>` : `
  <label class="f">Full name (as in MyKad)</label><input class="in" name="name" autocomplete="name" required>
  <label class="f">Mobile number</label><input class="in" name="phone" inputmode="tel" autocomplete="tel" placeholder="012-345 6789" required>
  <label class="f">MyKad number</label><input class="in" name="ic" inputmode="numeric" placeholder="900101-14-5678" required>
  <label class="f">Email (optional)</label><input class="in" name="email" type="email" autocomplete="email">
  <label class="f">Monthly income (RM)</label><input class="in" name="income" inputmode="numeric">
  <label class="f">Employment</label><select class="in" name="employment">${['Private sector employee', 'Government employee', 'Self-employed', 'Gig / freelance'].map(o => `<option>${o}</option>`).join('')}</select>
  ${a.source === 'organic' ? `<label class="f">Where did you hear about us?</label><select class="in" name="source">${Object.entries(SRC).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>` : ''}
  <label class="f">Create a 6-digit PIN to log in later</label><input class="in pin" name="pin" type="password" inputmode="numeric" maxlength="6" pattern="\\d{6}" autocomplete="new-password" required>
  <label class="f">Confirm PIN</label><input class="in pin" name="pin2" type="password" inputmode="numeric" maxlength="6" pattern="\\d{6}" autocomplete="new-password" required>
  <p class="tiny muted">Already applied before? <button type="button" class="linkbtn" onclick="S_after('apply');go('login')">Log in</button></p>`}
  <label class="row tiny" style="margin-top:14px;align-items:flex-start;gap:8px"><input type="checkbox" name="consent" required style="margin-top:2px;width:18px;height:18px"><span>I confirm I am 18 or older, the details above are true, and I agree to ${esc(S.cfg.company)} processing my personal data to assess this application and contacting me about it.</span></label>
  ${S.applyErr ? `<div class="err">${esc(S.applyErr)}</div>` : ''}
  <button class="btn primary block mt" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Submit application'}</button></form>`;
}
window.S_after = s => { S.after = s; };
window.submitApply = async e => {
  e.preventDefault(); if (S.busy) return;
  const f = Object.fromEntries(new FormData(e.target)); const a = attr();
  if (!S.me && f.pin !== f.pin2) { S.applyErr = "The two PINs don't match"; return render(); }
  S.busy = true; S.applyErr = ''; render();
  try {
    const r = await api('/apply', {
      productId: S.prodId, amount: S.amount, months: S.months, freq: S.freq, plan: S.plan,
      name: f.name, phone: f.phone, ic: f.ic, email: f.email, income: f.income, employment: f.employment, pin: f.pin, consent: !!f.consent,
      source: f.source || a.source, clickId: a.clickId, utm: a.utm, fbc: a.fbc || cookie('_fbc'), fbp: cookie('_fbp'), ttp: cookie('_ttp'),
    });
    S.lastRef = r.ref; pixelEvent('lead', r.eventId, S.amount);
    await loadMe(); S.busy = false; go('done');
  } catch (err) {
    S.busy = false; S.applyErr = err.message; render();
    if (err.status === 409 && /log in/i.test(err.message)) { S.after = 'apply'; }
  }
};
function doneView() {
  return `<div class="center" style="padding:40px 8px 0">${ICON.check}<h2 style="margin-top:14px">Application received</h2>
  <p class="muted">Reference <b>${esc(S.lastRef || '')}</b>. Our team will review it and contact you on your mobile number.</p>
  ${pushBanner()}
  <button class="btn primary block mt" onclick="go('loans')">Go to My loans</button></div>`;
}

/* ---------- login ---------- */
function loginView() {
  return `<h2 style="margin-top:8px">Log in</h2><p class="muted">Use the mobile number and 6-digit PIN you set when you applied.</p>
  <form onsubmit="doLogin(event)">
  <label class="f">Mobile number</label><input class="in" name="phone" inputmode="tel" autocomplete="tel" placeholder="012-345 6789" required>
  <label class="f">PIN</label><input class="in pin" name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="current-password" required>
  ${S.loginErr ? `<div class="err">${esc(S.loginErr)}</div>` : ''}
  <button class="btn primary block mt" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Log in'}</button></form>
  <p class="tiny muted mt">Forgot your PIN? Call us at ${esc(S.cfg.phone)} and we'll reset it for you.</p>
  <p class="tiny muted">New here? <button class="linkbtn" onclick="go('home')">Apply for a loan</button></p>`;
}
window.doLogin = async e => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
  S.busy = true; S.loginErr = ''; render();
  try { await api('/login', { phone: f.phone, pin: f.pin }); await loadMe(); S.busy = false; const n = S.after || 'loans'; S.after = null; go(n); }
  catch (err) { S.busy = false; S.loginErr = err.message; render(); }
};
window.logout = async () => { await api('/logout', {}).catch(() => {}); S.me = null; go('home'); };

/* ---------- my loans ---------- */
function loansView() {
  const loans = S.me.loans;
  let html = `<div class="row between" style="margin-top:4px"><h3>My loans</h3><button class="linkbtn" onclick="logout()">Log out</button></div>${pushBanner()}`;
  if (!loans.length) return html + `<p class="muted center mt">No loans yet. <button class="linkbtn" onclick="go('home')">Apply now</button></p>`;
  return html + loans.map(l => {
    const st = l.state; let inner = '';
    if (st === 'pending') inner = '<p class="tiny muted" style="margin:8px 0 0">Under review. We\'ll notify you once there\'s an update.</p>';
    else if (st === 'approved') inner = '<p class="tiny muted" style="margin:8px 0 0">Approved! We\'re transferring the money to you.</p>';
    else if (st === 'rejected') inner = '<p class="tiny muted" style="margin:8px 0 0">We couldn\'t approve this application this time.</p>';
    else if (st === 'closed') inner = '<p class="tiny muted" style="margin:8px 0 0">Fully repaid. Thank you!</p>';
    else {
      const pct = Math.round(l.paid / l.total * 100); const od = st === 'overdue';
      inner = `<div class="bar"><span style="width:${pct}%"></span></div><div class="row between tiny muted"><span>${RM(l.paid)} paid</span><span>${RM(l.balance)} left</span></div>
      <div class="qbox" style="margin-top:12px;padding:12px;${od ? 'border-color:#ebb9ad;background:#fdf4f1' : ''}"><div class="tiny muted">${od ? 'Overdue amount' : 'Next payment · ' + fd(l.next.due)}</div>
      <b style="font-size:22px">${RM(od ? l.overdue : l.next.amount)}</b>
      <div class="tiny" style="margin-top:8px;border-top:1px dashed var(--line);padding-top:8px"><b>How to pay:</b> bank transfer to ${esc(S.cfg.bank.name)} · ${esc(S.cfg.bank.accountName)} · <span class="mono">${esc(S.cfg.bank.accountNo)}</span>. Use <b>${esc(l.ref)}</b> as the reference. We'll confirm once received.</div></div>
      <button class="linkbtn mt8" onclick="toggleLoan(${l.id})">${S.openLoan === l.id ? 'Hide' : 'Show'} full schedule</button>
      ${S.openLoan === l.id ? `<div class="sched">${l.instalments.map(i => `<div><span>#${i.idx} · ${fd(i.due)}</span><span>${RM(i.amount)} ${i.paid >= i.amount - 0.005 ? '<span class="badge b-active">Paid</span>' : i.paid > 0 ? '<span class="badge b-pending">Part paid</span>' : i.due < todayMY() ? '<span class="badge b-overdue">Late</span>' : ''}</span></div>`).join('')}</div>` : ''}`;
    }
    return `<div class="loancard"><div class="row between"><div><b>${esc(l.product)}</b><div class="tiny muted">${l.ref} · ${RM0(l.amount)} · ${l.months} mo · ${FREQ[l.freq].toLowerCase()}</div></div><span class="badge b-${st}">${st}</span></div>${inner}</div>`;
  }).join('') + `<button class="btn block mt" onclick="go('home')">Apply for another loan</button>`;
}
window.toggleLoan = id => { S.openLoan = S.openLoan === id ? null : id; render(); };

function inboxView() {
  const n = S.me.notifications;
  return `<h3 style="margin-top:4px">Inbox</h3>` + (n.length ? n.map(m => `<div class="msg ${m.read ? '' : 'unread'}"><div class="row between"><b>${esc(m.title)}</b><span class="tiny muted">${fdt(m.created_at)}</span></div><div style="margin-top:4px;font-size:13.5px">${esc(m.body)}</div></div>`).join('') : '<p class="muted">No messages yet.</p>');
}

/* ---------- push notifications + install ---------- */
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function pushBanner() {
  if (!S.me || S.me.hasPush) return '';
  if (isIOS && !standalone) return `<div class="banner"><span style="font-size:22px">📲</span><div class="tiny">To get payment reminders on iPhone, tap <b>Share</b> then <b>Add to Home Screen</b>, and open the app from there.</div></div>`;
  if (!pushSupported || Notification.permission === 'denied') return '';
  return `<div class="banner"><span style="font-size:22px">🔔</span><div class="tiny grow">Get reminders before each payment is due.</div><button class="btn sm primary" onclick="enablePush()">Turn on</button></div>`;
}
const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
window.enablePush = async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications are blocked. You can still see reminders in your Inbox.');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(S.cfg.vapidKey) });
    await api('/push/subscribe', sub.toJSON()); S.me.hasPush = true; toast('Reminders turned on'); render();
  } catch (e) { toast("Couldn't turn on notifications on this device", true); }
};
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (S.screen === 'home') render(); });
function installBanner() { return installEvt && !standalone ? `<div class="banner"><span style="font-size:22px">📲</span><div class="tiny grow">Install the app for faster access and payment reminders.</div><button class="btn sm primary" onclick="installApp()">Install</button></div>` : ''; }
window.installApp = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; render(); };

/* ---------- boot ---------- */
async function loadMe() { try { S.me = await api('/me'); } catch { S.me = null; } }
async function boot() {
  try {
    [S.cfg, S.products] = await Promise.all([api('/config'), api('/products')]);
  } catch { $('#view').innerHTML = '<p class="muted center mt">Can\'t connect right now. Please check your internet and try again.</p>'; return; }
  document.title = S.cfg.company;
  S.prodId = S.products[0]?.id; fixSel();
  await loadMe(); loadPixels();
  go(location.hash.slice(1) || 'home', false);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // refresh loan status when the app comes back to the foreground
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && S.me) { await loadMe(); if (!['apply', 'login'].includes(S.screen)) render(); } });
}
boot();
