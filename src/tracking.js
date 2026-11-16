// Server-side conversion reporting: Meta Conversions API, TikTok Events API, S2S postbacks.
import crypto from 'node:crypto';
import { db, getSetting } from './db.js';

export const EVN = { calc: 'Used loan calculator', lead: 'Application submitted', approved: 'Loan approved', disbursed: 'Loan disbursed', repayment: 'Repayment made' };

const sha = s => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
const mask = t => !t ? '' : t.length > 10 ? t.slice(0, 4) + '…' + t.slice(-4) : '••••';
const clip = (s, n = 2000) => { s = typeof s === 'string' ? s : JSON.stringify(s); return s && s.length > n ? s.slice(0, n) + '…' : s; };

function log(ev, dest, status, loanRef, request, response) {
  db.prepare('INSERT INTO events(ev,dest,status,loan_ref,request,response) VALUES(?,?,?,?,?,?)')
    .run(ev, dest, status, loanRef || null, clip(request, 6000), clip(response));
}

async function send(url, opts) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: String(e.message || e) };
  }
}

export function fillMacros(url, m) {
  return url.replace(/\{(\w+)\}/g, (x, k) => (k in m ? encodeURIComponent(m[k] ?? '') : x));
}

// ctx: { loan (db row), borrower (db row), value, eventId }
export async function fireEvent(ev, ctx) {
  const tr = getSetting('tracking');
  const domain = getSetting('domain');
  const { loan, borrower } = ctx;
  const ts = Math.floor(Date.now() / 1000);
  const eventId = ctx.eventId || `${ev}_${loan ? loan.ref : 'anon'}`;
  const value = ctx.value ?? (loan ? loan.amount : 0);
  const map = tr.map[ev] || {};
  const jobs = [];
  const [fn, ...rest] = String(borrower?.name || '').trim().split(/\s+/);

  // ---- Meta Conversions API ----
  if (map.meta) {
    const m = tr.meta;
    if (!m.pixel || !m.token) log(ev, 'Meta Conversions API', 'skipped', loan?.ref, 'Pixel ID or access token not set (Admin → Meta & TikTok)');
    else {
      const user_data = { country: [sha('my')] };
      if (borrower?.phone) user_data.ph = [sha(borrower.phone)];
      if (borrower?.email) user_data.em = [sha(borrower.email)];
      if (fn) user_data.fn = [sha(fn)];
      if (rest.length) user_data.ln = [sha(rest.join(' '))];
      if (borrower?.id) user_data.external_id = [sha('b' + borrower.id)];
      if (loan?.ip) user_data.client_ip_address = loan.ip;
      if (loan?.ua) user_data.client_user_agent = loan.ua;
      if (loan?.fbc) user_data.fbc = loan.fbc;
      if (loan?.fbp) user_data.fbp = loan.fbp;
      const body = { data: [{ event_name: map.meta, event_time: ts, event_id: eventId, action_source: 'website', event_source_url: `https://${domain}/`, user_data, custom_data: { currency: 'MYR', value } }] };
      if (m.test) body.test_event_code = m.test;
      const url = `https://graph.facebook.com/${m.version || 'v21.0'}/${encodeURIComponent(m.pixel)}/events`;
      jobs.push(send(url + `?access_token=${encodeURIComponent(m.token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(r => log(ev, 'Meta Conversions API', r.ok ? 'sent' : 'failed', loan?.ref, { request: `POST ${url}?access_token=${mask(m.token)}`, body }, `${r.status} ${r.text}`)));
    }
  }

  // ---- TikTok Events API ----
  if (map.tt) {
    const t = tr.tt;
    if (!t.pixel || !t.token) log(ev, 'TikTok Events API', 'skipped', loan?.ref, 'Pixel code or access token not set (Admin → Meta & TikTok)');
    else {
      const user = {};
      if (borrower?.phone) user.phone = sha('+' + borrower.phone);
      if (borrower?.email) user.email = sha(borrower.email);
      if (borrower?.id) user.external_id = sha('b' + borrower.id);
      if (loan?.source === 'tiktok' && loan?.click_id) user.ttclid = loan.click_id;
      if (loan?.ttp) user.ttp = loan.ttp;
      if (loan?.ip) user.ip = loan.ip;
      if (loan?.ua) user.user_agent = loan.ua;
      const body = { event_source: 'web', event_source_id: t.pixel, data: [{ event: map.tt, event_time: ts, event_id: eventId, user, page: { url: `https://${domain}/` }, properties: { currency: 'MYR', value, content_type: 'product' } }] };
      if (t.test) body.test_event_code = t.test;
      const url = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
      jobs.push(send(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Access-Token': t.token }, body: JSON.stringify(body) })
        .then(r => {
          let ok = r.ok; try { ok = ok && JSON.parse(r.text).code === 0; } catch { /* keep http status */ }
          log(ev, 'TikTok Events API', ok ? 'sent' : 'failed', loan?.ref, { request: `POST ${url}`, headers: { 'Access-Token': mask(t.token) }, body }, `${r.status} ${r.text}`);
        }));
    }
  }

  // ---- S2S postbacks ----
  if (loan) {
    const pbs = db.prepare('SELECT * FROM postbacks WHERE active=1').all().filter(p => JSON.parse(p.events || '{}')[ev]);
    if (pbs.length && !loan.click_id) log(ev, 'S2S postback', 'skipped', loan.ref, `${loan.ref} has no click ID (source: ${loan.source}), so there is nothing to send back`);
    else for (const p of pbs) jobs.push(firePostback(p, ev, { click_id: loan.click_id, event: ev, amount: value, loan_id: loan.ref, source: loan.source, txid: `${loan.ref}-${eventId}`, currency: 'MYR', timestamp: ts }, loan.ref));
  }
  await Promise.allSettled(jobs);
}

export async function firePostback(p, ev, macros, loanRef) {
  const url = fillMacros(p.url, macros);
  let parsed; try { parsed = new URL(url); } catch { log(ev, 'Postback · ' + p.name, 'failed', loanRef, url, 'Invalid URL'); return; }
  let r;
  if (p.method === 'POST') {
    const body = Object.fromEntries(parsed.searchParams);
    r = await send(parsed.origin + parsed.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    log(ev, 'Postback · ' + p.name, r.ok ? 'sent' : 'failed', loanRef, { request: `POST ${parsed.origin + parsed.pathname}`, body }, `${r.status} ${r.text}`);
  } else {
    r = await send(url, { method: 'GET' });
    log(ev, 'Postback · ' + p.name, r.ok ? 'sent' : 'failed', loanRef, { request: `GET ${url}` }, `${r.status} ${r.text}`);
  }
}

// Fire-and-forget wrapper so API responses are never slowed down by ad platforms
export const track = (ev, ctx) => { setImmediate(() => fireEvent(ev, ctx).catch(e => console.error('tracking', e))); };
