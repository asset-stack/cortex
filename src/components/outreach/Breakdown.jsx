import { cn } from '@/lib/cn';
import { replyColor, replyLabel, statusColor, statusLabel } from './shared';

// Sent first, then drafts, then the skipped reasons; within each, the larger first.
const rank = (v) => (v === 'sent' ? 0 : v.startsWith('draft') ? 1 : 2);

function Bars({ title, items, total, label, color }) {
  return (
    <div>
      <h3 className="flex items-baseline justify-between gap-3 text-[13px] font-bold">{title}<span className="dimmer tnum font-normal">{total}</span></h3>
      {items.length ? (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map(({ value, n }) => (
            <li key={value || 'blank'} className="text-[12.5px]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: color(value) }} />
                  <span className="truncate dim">{label(value)}</span>
                </span>
                <span className="tnum font-semibold">{n}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-white/10" aria-hidden="true">
                <div className="h-full rounded-full bg-white/60" style={{ width: `${total ? (n / total) * 100 : 0}%` }} />
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-[12.5px] dimmer">None</p>}
    </div>
  );
}

/**
 * Contacts logged in the period by what happened (sent, draft saved, each skipped reason) and emails replied to by
 * kind, from outreach.breakdown(). `mailbox`: null for all, '' Unassigned, or an id.
 */
export default function Breakdown({ rows, mailbox, className }) {
  const sum = (kind) => {
    const m = new Map();
    (rows || []).forEach((r) => {
      if (r.kind === kind && (mailbox === null || r.mailbox === mailbox)) m.set(r.value, (m.get(r.value) || 0) + r.n);
    });
    return [...m].map(([value, n]) => ({ value, n }));
  };
  const status = sum('status').sort((a, b) => rank(a.value) - rank(b.value) || b.n - a.n || a.value.localeCompare(b.value));
  const replies = sum('reply').sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
  const total = (list) => list.reduce((t, x) => t + x.n, 0);
  return (
    <section className={cn('min-w-0 rounded-[26px] glass glass-rim p-5', className)}>
      <h2 className="font-extrabold text-[16px]">Breakdown</h2>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <Bars title="Logged" items={status} total={total(status)} label={statusLabel} color={statusColor} />
        <Bars title="Replies" items={replies} total={total(replies)} label={replyLabel} color={replyColor} />
      </div>
    </section>
  );
}
