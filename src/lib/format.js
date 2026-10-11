const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const aud2 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2 });

export const money = (n) => aud.format(n || 0);
export const money2 = (n) => aud2.format(n || 0);
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

// YYYY-MM-DD in local time (toISOString gives the UTC day, which is yesterday on Australian mornings).
export const localYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
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

// One-line preview of an email body; skips a leading greeting when there is more to show.
export function emailSnippet(body) {
  const lines = String(body || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const skip = lines.length > 1 && /^(hi|hello|hey|dear)\b/i.test(lines[0]);
  return (skip ? lines[1] : lines[0]) || '';
}

// Accepts '1,000', '$1,200' or '1 000'. Blank counts as 0; anything else that doesn't parse is NaN.
export const parseAmount = (v) => Number(String(v ?? '').trim().replace(/[$,\s]/g, ''));
export const isBadAmount = (v) => String(v ?? '').trim() !== '' && !Number.isFinite(parseAmount(v));

// Work in whole cents so the printed lines, subtotal, GST and total always add up.
const lineCents = (l) => Math.round((parseAmount(l.qty) || 0) * (parseAmount(l.rate) || 0) * 100);
export const lineAmount = (l) => lineCents(l) / 100;

export function invoiceTotals(inv) {
  const sub = inv.lines.reduce((t, l) => t + lineCents(l), 0);
  const gst = Math.round(sub / 10); // 10% GST, half a cent rounds up
  return { subtotal: sub / 100, gst: gst / 100, total: (sub + gst) / 100 };
}
