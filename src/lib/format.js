const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const aud2 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2 });
const audUnit = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export const money = (n) => aud.format(n || 0);
export const money2 = (n) => aud2.format(n || 0);
// Unit prices keep up to 4 decimals, so a $0.125 rate isn't printed as $0.13.
export const unitMoney = (n) => audUnit.format(n || 0);
const trim = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
// The unit is picked after rounding, so 999,500 reads "$1M" rather than "$1000k".
export const compactMoney = (n) => {
  if (n >= 1e9 || Math.round(n / 1e4) >= 1e5) return `$${trim((n / 1e9).toFixed(2))}B`;
  if (n >= 1e6 || Math.round(n / 1e3) >= 1000) return `$${trim((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `$${trim((n / 1e3).toFixed(n >= 1e5 ? 0 : 1))}k`;
  return money(n);
};

const parseDay = (iso) => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);

// Day and month; the year is added when it isn't this year, so 2026 and 2027 dates don't look the same.
export function shortDate(iso) {
  if (!iso) return '—';
  const d = parseDay(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-AU', opts);
}

// Always with the year (invoices).
export function fullDate(iso) {
  if (!iso) return '—';
  return parseDay(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Whole calendar days from one YYYY-MM-DD to another (in UTC, so daylight saving can't shift it); null if either is blank or invalid.
export function daysBetween(from, to) {
  const utc = (s) => { const [y, m, d] = String(s || '').slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const n = Math.round((utc(to) - utc(from)) / 864e5);
  return Number.isFinite(n) ? n : null;
}

// YYYY-MM-DD in local time (toISOString gives the UTC day, which is yesterday on Australian mornings).
export const localYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The business time zone: invoice dates and other team-wide "today"s (public.team_today() in the database).
export const TEAM_TIMEZONE = 'Australia/Sydney';

// The date (YYYY-MM-DD) in a time zone; this browser's date for an unknown zone.
export function ymdIn(timezone, d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const part = (type) => parts.find((p) => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return localYmd(d);
  }
}

// Blank or unparseable (a contact never emailed) reads as a dash, not "NaNd".
export function ago(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function clockTime(iso) {
  return new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

// Chat timestamp: just the time for today, otherwise with the day, so older messages don't read as today's.
export function chatTime(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return clockTime(iso);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${clockTime(iso)}`;
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString('en-AU', opts)}, ${clockTime(iso)}`;
}

// Accepts '1,000', '$1,200' or '1 000'. Blank counts as 0; anything else that doesn't parse is NaN.
export const parseAmount = (v) => Number(String(v ?? '').trim().replace(/[$,\s]/g, ''));
export const isBadAmount = (v) => String(v ?? '').trim() !== '' && !Number.isFinite(parseAmount(v));

// Work in whole cents so the printed lines, subtotal, GST and total always add up. The product is cleaned to 6
// decimals first, so float error can't pull an exact half cent (1 × $1.005) below .5 and round it down.
const lineCents = (l) => Math.round(Number(((parseAmount(l.qty) || 0) * (parseAmount(l.rate) || 0) * 100).toFixed(6)));

// GST is 10% of the subtotal, rounded once (half a cent rounds up). `lines` (same order as inv.lines) splits
// that GST across the lines for the tax invoice: each line's GST rounded down, and the cents left over go to
// the lines with the largest remainders, so the GST column adds up to exactly the GST total.
export function invoiceTotals(inv) {
  const cents = inv.lines.map(lineCents);
  const sub = cents.reduce((t, x) => t + x, 0);
  const gst = Math.round(sub / 10);
  const rem = cents.map((x) => ((x % 10) + 10) % 10); // tenths of a cent, 0–9 (also for credit lines)
  const share = cents.map((x, i) => (x - rem[i]) / 10);
  let left = gst - share.reduce((t, x) => t + x, 0);
  rem.map((r, i) => [r, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([r, i]) => {
    if (left > 0 && r > 0) { share[i] += 1; left -= 1; }
  });
  return {
    subtotal: sub / 100, gst: gst / 100, total: (sub + gst) / 100,
    lines: cents.map((x, i) => ({ ex: x / 100, gst: share[i] / 100, inc: (x + share[i]) / 100 })),
  };
}

// ABN as the ATO prints it (12 345 678 901) and BSB as 000-000; anything else is shown as typed.
const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');
export function formatAbn(v) {
  const d = digitsOf(v);
  return d.length === 11 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4') : String(v ?? '').trim();
}
export function formatBsb(v) {
  const d = digitsOf(v);
  return d.length === 6 ? `${d.slice(0, 3)}-${d.slice(3)}` : String(v ?? '').trim();
}

// ── Clients: months, GST, payments, subscriptions ──

const countFmt = new Intl.NumberFormat('en-AU');
// Counts with thousands separators (usage figures).
export const count = (n) => countFmt.format(n || 0);

// 'YYYY-MM-01' for any day in a month ('YYYY-MM' works too); '' when it isn't a date.
export const monthStart = (ymd) => (/^\d{4}-\d{2}/.test(String(ymd || '')) ? `${String(ymd).slice(0, 7)}-01` : '');

// The month of a 'YYYY-MM-DD' (or 'YYYY-MM') as 'Oct 2026'.
export function monthLabel(ymd) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return '—';
  return new Date(+m[1], +m[2] - 1, 1).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
}

// The GST inside an amount that includes it (one eleventh), to the cent. Same rule as the store's expenses.
export const gstIncluded = (amount) => Math.round(((Number(amount) || 0) * 100) / 11) / 100;

// A subscription's cost per month: annual plans count as a twelfth.
export const monthlyCost = (sub) => {
  const n = Number(sub?.amount) || 0;
  return sub?.cycle === 'annually' ? n / 12 : n;
};

// Payments received against an invoice, in dollars (added in whole cents).
export const paidTowards = (payments, invoiceId) => (payments || [])
  .reduce((t, p) => (p.invoiceId === invoiceId ? t + Math.round((Number(p.amount) || 0) * 100) : t), 0) / 100;

// What is still owing on an invoice (inc GST) after its payments; never below zero.
export const owingOn = (inv, payments) => Math.max(0, Math.round(invoiceTotals(inv).total * 100 - paidTowards(payments, inv.id) * 100) / 100);

// This browser's IANA time zone ('' if the browser won't say; some report Etc/Unknown, which Postgres refuses).
export function browserTimezone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return zone === 'Etc/Unknown' ? '' : zone;
  } catch {
    return '';
  }
}

// The current time in a time zone, e.g. "9:12 am" ('' for an unknown zone).
export function localTime(timezone, at = new Date()) {
  if (!timezone) return '';
  try {
    return at.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
  } catch {
    return '';
  }
}

// A time zone's current time, short weekday and hour (0–23), e.g. { time: '7:39 pm', day: 'Fri', hour: 19 } (the world
// clocks); null for a blank or unknown zone.
export function zoneNow(timezone, at = new Date()) {
  const time = localTime(timezone, at);
  if (!time) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(at);
    const part = (type) => parts.find((p) => p.type === type)?.value || '';
    return { time, day: part('weekday'), hour: Number(part('hour')) % 24 };
  } catch {
    return null;
  }
}

// A person's city and current local time, e.g. "Tbilisi · 9:12 am" ('' for an unknown zone).
export function localClock(timezone, at = new Date()) {
  const time = localTime(timezone, at);
  return time && `${timezone.split('/').pop().replace(/_/g, ' ')} · ${time}`;
}

/** A free-text link (demo, platform, a pasted Doc, a tool) as an http(s) URL to link to: https:// is added when there is no
 *  scheme; anything else is null. */
export function safeUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}
