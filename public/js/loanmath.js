// Loan maths shared by the server and the browser.
// Licensed moneylenders in Malaysia may only charge simple (flat) interest,
// capped at 12% p.a. secured / 18% p.a. unsecured (Moneylenders Act 1951).

export const CAP = { secured: 12, unsecured: 18 };
export const FREQ = { monthly: 'Monthly', biweekly: 'Every 2 weeks', weekly: 'Weekly' };
export const FREQ_SHORT = { monthly: 'month', biweekly: '2 weeks', weekly: 'week' };

export const r2 = n => Math.round(n * 100) / 100;

export function instalmentCount(months, freq) {
  if (freq === 'monthly') return months;
  if (freq === 'biweekly') return Math.round(months * 26 / 12);
  return Math.round(months * 52 / 12);
}

// plan: 'equal' or 'stepup' (first half of payments at 80%, rest absorbs the difference)
export function quote(principal, ratePa, months, freq, plan = 'equal') {
  const interest = r2(principal * ratePa / 100 * months / 12);
  const total = r2(principal + interest);
  const n = instalmentCount(months, freq);
  const amts = [];
  if (plan === 'stepup' && n >= 2) {
    const k = Math.floor(n / 2);
    const low = r2(total / n * 0.8);
    const hi = r2((total - low * k) / (n - k));
    for (let i = 0; i < n; i++) amts.push(i < k ? low : hi);
  } else {
    const b = r2(total / n);
    for (let i = 0; i < n; i++) amts.push(b);
  }
  amts[n - 1] = r2(amts[n - 1] + r2(total - amts.reduce((a, b) => a + b, 0)));
  return { interest, total, n, amts };
}

// Dates are plain 'YYYY-MM-DD' strings (Malaysia local date), handled in UTC to avoid DST/TZ drift.
export const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const fmtDate = d => d.toISOString().slice(0, 10);
export function addDays(s, n) { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return fmtDate(d); }
export function addMonths(s, n) {
  const d = parseDate(s); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return fmtDate(d);
}
export function dueDates(start, freq, n) {
  return Array.from({ length: n }, (_, i) => freq === 'monthly' ? addMonths(start, i + 1) : addDays(start, (freq === 'weekly' ? 7 : 14) * (i + 1)));
}
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);

// Today's date in Malaysia (UTC+8), as YYYY-MM-DD
export function todayMY(now = new Date()) { return fmtDate(new Date(now.getTime() + 8 * 3600000)); }
