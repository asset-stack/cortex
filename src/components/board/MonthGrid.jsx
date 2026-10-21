import { useState } from 'react';
import { monthWeeks } from '@/lib/calendar';
import { localYmd } from '@/lib/format';
import { Popover } from '@/components/ui';
import { cn } from '@/lib/cn';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const COMPACT_MAX = 3; // pills a day in the 3-month calendar, then "+N"

/**
 * One month ('YYYY-MM'), Monday first, as whole weeks: days of the months either side are blank. `items`:
 * [{ id, name, date, color }], each a pill on its day that calls `onOpen(id)`. `compact`: the board's 3-month calendar
 * (short days, at most three pills a day, then "+N" listing the whole day).
 */
const dayName = (day) => new Date(`${day}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });

export default function MonthGrid({ month, items, onOpen, compact = false }) {
  const today = localYmd();
  const [more, setMore] = useState(null); // { day, anchor }: the day "+N" lists
  const byDay = new Map();
  items.forEach((i) => { if (!byDay.has(i.date)) byDay.set(i.date, []); byDay.get(i.date).push(i); });
  return (
    <div>
      <div className={cn('grid grid-cols-7 dimmer', compact ? 'text-[11px]' : 'text-[12px]')} aria-hidden="true">
        {DAYS.map((d) => <div key={d} className={compact ? 'px-1.5 pb-1' : 'px-3 pb-2'}>{compact ? d.slice(0, 1) : d}</div>)}
      </div>
      {monthWeeks(month).map((w) => (
        <div key={w.monday} className="grid grid-cols-7">
          {w.days.map((day) => {
            const inMonth = day.startsWith(month);
            const list = inMonth ? byDay.get(day) || [] : [];
            const shown = compact ? list.slice(0, COMPACT_MAX) : list;
            const hidden = list.length - shown.length;
            return (
              <div key={day}
                className={cn('border-t border-r rowline', compact ? 'min-h-16 p-1' : 'min-h-28 p-1.5', day === today && inMonth && 'bg-white/15')}>
                {inMonth && <div className={cn('tnum', compact ? 'text-[11px]' : 'text-[12px]', day === today ? 'font-bold' : 'dimmer')}>{Number(day.slice(8))}</div>}
                {shown.map((i) => (
                  <button key={i.id} type="button" onClick={() => onOpen(i.id)} title={i.name} aria-label={`${i.name}, ${dayName(day)}`}
                    className={cn('pill w-full !justify-start overflow-hidden', compact ? 'mt-0.5 !h-5 !rounded-md !px-1 text-[10.5px]' : 'mt-1 !h-6 text-[11.5px]')}
                    style={{ backgroundColor: i.color }}>
                    <span className="min-w-0 truncate">{i.name}</span>
                  </button>
                ))}
                {hidden > 0 && (
                  <button type="button" onClick={(e) => setMore({ day, anchor: e.currentTarget })} aria-label={`${hidden} more on ${dayName(day)}`}
                    aria-haspopup="true" aria-expanded={more?.day === day} className="mt-0.5 w-full rounded-md px-1 text-left text-[10.5px] dim hover:bg-white/10">
                    +{hidden}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <Popover anchor={more?.anchor} open={Boolean(more)} onClose={() => setMore(null)} width={230}>
        <div className="px-1 pb-1 text-[12px] font-semibold dim">{more && dayName(more.day)}</div>
        <div className="flex flex-col gap-1">
          {(more ? byDay.get(more.day) || [] : []).map((i) => (
            <button key={i.id} type="button" onClick={() => { setMore(null); onOpen(i.id); }} title={i.name}
              className="pill w-full !justify-start overflow-hidden !h-7 text-[12px]" style={{ backgroundColor: i.color }}>
              <span className="min-w-0 truncate">{i.name}</span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
