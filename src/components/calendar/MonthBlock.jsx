import { ChevronDown } from 'lucide-react';
import { KINDS, monthWeeks } from '@/lib/calendar';
import { useUsers } from '@/data/store';
import { Avatar } from '@/components/ui';
import { cn } from '@/lib/cn';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_MAX = 4; // entries a day in the table, then "+N more"

const parse = (day) => new Date(`${day}T00:00:00`);
export const monthName = (month) => parse(`${month}-01`).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
export const dayName = (day) => parse(day).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
const dayMonth = (day) => parse(day).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

/** One calendar entry: its colour, time, title and (a Google meeting) whose it is. */
export function EntryChip({ entry: e, onOpen }) {
  const users = useUsers();
  const who = e.kind === 'google' ? users[e.people[0]]?.name || '' : '';
  const label = [KINDS[e.kind].label.replace(/s$/, ''), e.time, e.title, who && `(${who})`, e.done && 'done'].filter(Boolean).join(' ');
  return (
    <button type="button" onClick={() => onOpen(e)} title={label} aria-label={label}
      className={cn('flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-[3px] text-left text-[11.5px] leading-tight hover:brightness-125', e.done && 'opacity-60')}
      style={{ backgroundColor: `${e.color}47`, boxShadow: `inset 3px 0 0 ${e.color}` }}>
      {e.time && <span className="shrink-0 tnum dim">{e.time}</span>}
      <span className={cn('min-w-0 truncate', e.done && 'line-through')}>{e.title}</span>
      {who && <Avatar userId={e.people[0]} size={14} ring={false} className="ml-auto shrink-0" />}
    </button>
  );
}

/**
 * A month on the team Calendar: a heading that opens and closes it (like a board's group), then one row per week, from
 * Monday. Days of the months either side are shaded and empty (their entries are in their own month). From `md` up a
 * table (Week, Mon … Sun); on a phone a card per week listing the days that have something on.
 */
export default function MonthBlock({ month, days, count, open, onToggle, today, onOpen, onMore, className }) {
  const weeks = monthWeeks(month);
  const current = today.startsWith(month);
  return (
    <section className={cn('mt-8', className)}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className={cn('flex min-w-0 items-center gap-2 text-[17px] font-extrabold', current && 'text-sky-200')}>
        <ChevronDown className={cn('h-5 w-5 shrink-0 transition-transform', !open && '-rotate-90')} />
        <span className="truncate">{monthName(month)}</span><span className="text-[12px] font-semibold dimmer">{count}</span>
      </button>
      {open && (
        <>
          <div className="mt-3 hidden overflow-x-auto scroll-thin md:block">
            <div className={cn('min-w-[760px] overflow-hidden rounded-[24px] glass', current && 'ring-2 ring-sky-300/40')}>
            <table className="w-full table-fixed text-[13px]">
              <thead>
                <tr className="text-[12px] dimmer">
                  <th scope="col" className="w-[84px] px-3 py-2.5 text-left font-medium">Week</th>
                  {WEEKDAYS.map((d) => <th key={d} scope="col" className="px-2 py-2.5 text-left font-medium">{d}</th>)}
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr key={w.monday} className={cn('border-t rowline align-top', w.days.includes(today) && 'bg-sky-400/10')}
                    aria-current={w.days.includes(today) ? 'date' : undefined}>
                    <th scope="row" className="px-3 py-2 text-left font-semibold">
                      Wk {w.week}<div className="text-[11.5px] font-medium dimmer">{dayMonth(w.monday)}</div>
                    </th>
                    {w.days.map((day) => {
                      const inMonth = day.startsWith(month);
                      const list = inMonth ? days.get(day) || [] : [];
                      return (
                        <td key={day} className={cn('h-24 border-l rowline p-1.5', !inMonth && 'bg-black/15', day === today && inMonth && 'bg-white/15')}>
                          {inMonth && (
                            <>
                              <div className={cn('text-[12px] tnum', day === today ? 'font-bold' : 'dimmer')}>{Number(day.slice(8))}</div>
                              <div className="mt-1 flex flex-col gap-1">
                                {list.slice(0, DAY_MAX).map((e) => <EntryChip key={e.key} entry={e} onOpen={onOpen} />)}
                                {list.length > DAY_MAX && (
                                  <button type="button" onClick={() => onMore(day)} className="rounded-md px-1.5 text-left text-[11.5px] dim hover:bg-white/10"
                                    aria-label={`${list.length - DAY_MAX} more on ${dayName(day)}`}>
                                    +{list.length - DAY_MAX} more
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-2 md:hidden">
            {weeks.map((w) => {
              const inMonth = w.days.filter((d) => d.startsWith(month));
              const busy = inMonth.filter((d) => days.get(d)?.length);
              return (
                <div key={w.monday} className={cn('rounded-[20px] glass p-3', w.days.includes(today) && 'ring-2 ring-sky-300/40')}>
                  <div className="text-[13px] font-bold">Wk {w.week}<span className="font-medium dimmer"> · {dayMonth(inMonth[0])} – {dayMonth(inMonth.at(-1))}</span></div>
                  {busy.length ? busy.map((d) => (
                    <div key={d} className="mt-2">
                      <div className={cn('text-[12px]', d === today ? 'font-bold' : 'dim')}>{dayName(d)}</div>
                      <div className="mt-1 flex flex-col gap-1">{days.get(d).map((e) => <EntryChip key={e.key} entry={e} onOpen={onOpen} />)}</div>
                    </div>
                  )) : <div className="mt-1 text-[12.5px] dimmer">—</div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
