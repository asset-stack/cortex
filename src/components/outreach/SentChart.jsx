import { useLayoutEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/cn';
import { dayLabel, mailboxColor, mailboxName } from './shared';

const PLOT = 160; // px from the baseline to the top tick
const LABEL = 18; // room above the tallest bar for its value

// A clean top for the axis: two equal whole-number steps (1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 × 10^k) just above the max.
function niceTop(max) {
  if (max <= 2) return 2;
  const half = max / 2;
  const p = 10 ** Math.floor(Math.log10(half));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).filter(Number.isInteger).find((s) => s >= half);
  return step * 2;
}

const shortDay = (ymd) => new Date(`${ymd}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
const isMonday = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay() === 1;

/**
 * Emails sent per day: one column per day of the period, stacked by mailbox (each in its own colour), with a legend
 * when more than one mailbox sent. `daily`: outreach.daily() rows; `mailbox`: null for all, '' Unassigned, or an id.
 * Long periods scroll inside the card, newest day in view.
 */
export default function SentChart({ daily, days, mailbox, mailboxes }) {
  const { series, cols, top, peak, total } = useMemo(() => {
    const byDay = new Map(days.map((d) => [d, new Map()]));
    (daily || []).forEach((r) => {
      if (!r.sent || !byDay.has(r.day) || (mailbox !== null && r.mailbox !== mailbox)) return;
      const m = byDay.get(r.day);
      m.set(r.mailbox, (m.get(r.mailbox) || 0) + r.sent);
    });
    const sums = new Map();
    byDay.forEach((m) => m.forEach((n, id) => sums.set(id, (sums.get(id) || 0) + n)));
    // The mailboxes' own order, then Unassigned.
    const order = [...(mailboxes || []).map((m) => m.id), ''];
    const ids = order.filter((id) => sums.has(id));
    const list = days.map((day) => {
      const m = byDay.get(day);
      const parts = ids.filter((id) => m.get(id)).map((id) => ({ id, n: m.get(id) }));
      return { day, parts, total: parts.reduce((t, p) => t + p.n, 0) };
    });
    const max = Math.max(0, ...list.map((c) => c.total));
    return {
      series: ids.map((id) => ({ id, name: mailboxName(mailboxes, id), color: mailboxColor(mailboxes, id), n: sums.get(id) })),
      cols: list,
      top: niceTop(max),
      peak: max > 0 ? list.findIndex((c) => c.total === max) : -1,
      total: list.reduce((t, c) => t + c.total, 0),
    };
  }, [daily, days, mailbox, mailboxes]);

  const scroller = useRef(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [days.length]);

  const few = days.length <= 14;
  const minCol = few ? 34 : days.length <= 31 ? 20 : 11;
  const ticks = [0, top / 2, top];
  const tip = (c) => [`${dayLabel(c.day)}: ${c.total} sent`, ...(c.parts.length > 1 || (c.parts.length === 1 && mailbox === null)
    ? c.parts.map((p) => `${mailboxName(mailboxes, p.id)} ${p.n}`) : [])].join('\n');

  return (
    <div>
      {series.length > 1 && (
        <ul aria-label="Mailboxes" className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
          {series.map((s) => (
            <li key={s.id || 'none'} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />
              <span className="dim">{s.name}</span><span className="dimmer tnum">{s.n}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex">
        {/* Y axis */}
        <div aria-hidden="true" className="relative w-7 shrink-0 text-[11px] dimmer tnum" style={{ height: PLOT + LABEL }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-1.5 leading-none" style={{ bottom: (t / top) * PLOT - 5 }}>{t}</span>
          ))}
        </div>
        <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto scroll-thin pb-1">
          <div className="relative" style={{ minWidth: days.length * minCol }}>
            {/* Gridlines */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0" style={{ height: PLOT + LABEL }}>
              {ticks.map((t) => (
                <span key={t} className={cn('absolute inset-x-0 h-px', t ? 'bg-white/10' : 'bg-white/25')} style={{ bottom: (t / top) * PLOT }} />
              ))}
            </div>
            <div className="relative flex" style={{ height: PLOT + LABEL }}>
              {cols.map((c, i) => {
                const label = c.total > 0 && (few || i === peak);
                const h = (c.total / top) * PLOT;
                return (
                  <div key={c.day} title={tip(c)} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end rounded-t-md hover:bg-white/[.06]">
                    <span className={cn('mb-1 text-[11px] leading-none dim tnum', !label && 'invisible')} aria-hidden="true">{c.total}</span>
                    <div className="flex flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]" style={{ height: h, width: 'min(24px, 72%)' }} aria-hidden="true">
                      {c.parts.map((p) => (
                        <span key={p.id || 'none'} className="block min-h-[2px] w-full" style={{ flexGrow: p.n, flexBasis: 0, background: mailboxColor(mailboxes, p.id) }} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* X axis: every day for a week, Mondays for longer periods */}
            <div aria-hidden="true" className="relative mt-1.5 flex h-4 text-[11px] dimmer tnum">
              {cols.map((c, i) => {
                const show = few || isMonday(c.day);
                const edge = i === 0 ? 'left-0' : i === cols.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2';
                return (
                  <div key={c.day} className="relative min-w-0 flex-1">
                    {show && <span className={cn('absolute top-0 whitespace-nowrap', edge)}>{few ? dayLabel(c.day, false) : shortDay(c.day)}</span>}
                  </div>
                );
              })}
            </div>
            {total === 0 && <p className="absolute inset-x-0 top-[70px] text-center text-[13px] dimmer">Nothing sent</p>}
          </div>
        </div>
      </div>
      {/* The same numbers for screen readers */}
      <table className="sr-only">
        <caption>Emails sent per day</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Sent</th>{series.length > 1 && series.map((s) => <th key={s.id || 'none'} scope="col">{s.name}</th>)}</tr></thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.day}>
              <th scope="row">{dayLabel(c.day)}</th><td>{c.total}</td>
              {series.length > 1 && series.map((s) => <td key={s.id || 'none'}>{c.parts.find((p) => p.id === s.id)?.n || 0}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
