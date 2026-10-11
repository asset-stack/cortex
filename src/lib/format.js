const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const aud2 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2 });

export const money = (n) => aud.format(n || 0);
export const money2 = (n) => aud2.format(n || 0);
const trim = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
export const compactMoney = (n) => (n >= 1e6 ? `$${trim((n / 1e6).toFixed(2))}M` : n >= 1e3 ? `$${trim((n / 1e3).toFixed(n >= 1e5 ? 0 : 1))}k` : money(n));

export function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

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

export function invoiceTotals(inv) {
  const subtotal = inv.lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);
  const gst = subtotal * 0.1;
  return { subtotal, gst, total: subtotal + gst };
}
