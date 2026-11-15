import { monthWeeks } from '@/lib/calendar';
import { localYmd } from '@/lib/format';
import { cn } from '@/lib/cn';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * One month ('YYYY-MM'), Monday first, as whole weeks: days of the months either side are blank. `items`:
 * [{ id, name, date, color }], each a pill on its day that calls `onOpen(id)`. Used by a board's Calendar view and by
 * the calendar of this month above a board's tasks.
 */
const dayName = (day) => new Date(`${day}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });

export default function MonthGrid({ month, items, onOpen }) {
  const today = localYmd();
  const byDay = new Map();
  items.forEach((i) => { if (!byDay.has(i.date)) byDay.set(i.date, []); byDay.get(i.date).push(i); });
  return (
    <div>
      <div className="grid grid-cols-7 dimmer text-[12px]" aria-hidden="true">
        {DAYS.map((d) => <div key={d} className="px-3 pb-2">{d}</div>)}
      </div>
      {monthWeeks(month).map((w) => (
        <div key={w.monday} className="grid grid-cols-7">
          {w.days.map((day) => {
            const inMonth = day.startsWith(month);
            const list = inMonth ? byDay.get(day) || [] : [];
            return (
              <div key={day} className={cn('border-t border-r rowline min-h-28 p-1.5', day === today && inMonth && 'bg-white/15')}>
                {inMonth && <div className={cn('tnum text-[12px]', day === today ? 'font-bold' : 'dimmer')}>{Number(day.slice(8))}</div>}
                {list.map((i) => (
                  <button key={i.id} type="button" onClick={() => onOpen(i.id)} title={i.name} aria-label={`${i.name}, ${dayName(day)}`}
                    className="pill mt-1 w-full !justify-start overflow-hidden !h-6 text-[11.5px]" style={{ backgroundColor: i.color }}>
                    <span className="min-w-0 truncate">{i.name}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
