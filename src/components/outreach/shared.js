// Shared by the Outreach page's parts and Settings → Outreach: the mailbox filter's ids, a stable colour per mailbox,
// and labels for the agent's status and reply values.

// The mailbox filter: 'all', 'unassigned' or a mailbox id. The store takes null (all), '' (Unassigned) or the id.
export const ALL = 'all';
export const NONE = 'unassigned';
export const mailboxArg = (filter) => (filter === ALL ? null : filter === NONE ? '' : filter);

// Categorical slots stepped for a dark surface (validated together: CVD and normal-vision separation, 3:1 contrast).
// A mailbox keeps its slot by its place in the list (Settings → Outreach), so filters never repaint it.
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const UNASSIGNED_COLOR = '#7d8597';

export function mailboxColor(mailboxes, id) {
  const i = id ? (mailboxes || []).findIndex((m) => m.id === id) : -1;
  return i >= 0 && i < SERIES.length ? SERIES[i] : UNASSIGNED_COLOR;
}

export const mailboxName = (mailboxes, id) => (id ? (mailboxes || []).find((m) => m.id === id)?.name || 'Unassigned' : 'Unassigned');

// Rows whose mailbox no longer exists count as Unassigned (as the database does when a mailbox is deleted).
export function knownMailbox(rows, mailboxes) {
  const known = new Set((mailboxes || []).map((m) => m.id));
  return (rows || []).map((r) => (!r.mailbox || known.has(r.mailbox) ? r : { ...r, mailbox: '' }));
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const STATUS_LABELS = { sent: 'Sent', 'draft-saved': 'Draft saved', 'draft-lost': 'Draft lost' };
/** The agent's draft_status: sent, draft-saved, skipped-colleague → "Skipped: colleague". */
export function statusLabel(v) {
  const s = String(v || '').trim();
  if (!s) return '—';
  if (STATUS_LABELS[s]) return STATUS_LABELS[s];
  if (s.startsWith('skipped-')) return `Skipped: ${s.slice(8).replace(/-/g, ' ')}`;
  return cap(s.replace(/-/g, ' '));
}
export const replyLabel = (v) => (String(v || '').trim() ? cap(String(v).trim().replace(/-/g, ' ')) : '—');

export function statusColor(v) {
  const s = String(v || '');
  if (s === 'sent') return '#0f9f6f';
  if (s === 'draft-saved') return '#2f6f86';
  if (s === 'draft-lost') return '#be123c';
  return '#64748b';
}
const REPLY_COLORS = { positive: '#0f9f6f', referral: '#7c3aed', neutral: '#64748b', negative: '#be123c' };
export const replyColor = (v) => REPLY_COLORS[v] || '#475569';

// "Mon 12 Oct" for a YYYY-MM-DD (`withMonth` false: "Mon 12").
export function dayLabel(ymd, withMonth = true) {
  const d = new Date(`${ymd}T00:00:00`);
  const part = (o) => d.toLocaleDateString('en-AU', o);
  return [part({ weekday: 'short' }), d.getDate(), withMonth && part({ month: 'short' })].filter(Boolean).join(' ');
}

// 0.043 → "4.3%", 0.25 → "25%".
export const pct = (rate) => `${Number(((rate || 0) * 100).toFixed(1))}%`;
