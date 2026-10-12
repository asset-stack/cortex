import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useStore } from '@/data/store';
import { CATEGORIES } from '@/data/boards';
import { Avatar } from '@/components/ui';
import { addDays, mondayOf } from '@/lib/automations';
import { localYmd } from '@/lib/format';
import { dayLabel, formatMinutes } from '@/lib/timesheet';
import { cn } from '@/lib/cn';

const OTHER_COLOR = CATEGORIES.Other;

// '5 – 11 Oct', '28 Sep – 4 Oct' (with the year when the week isn't in this one).
function weekLabel(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  const thisYear = new Date().getFullYear();
  const withYear = a.getFullYear() !== thisYear || b.getFullYear() !== thisYear;
  const end = b.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(withYear && { year: 'numeric' }) });
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const start = a.toLocaleDateString('en-AU', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short', ...(a.getFullYear() !== b.getFullYear() && { year: 'numeric' }) });
  return `${start} – ${end}`;
}

/** ‹ This week › with the dates it shows. `offset` is weeks from this one. */
function WeekNav({ offset, onChange, label }) {
  return (
    <div className="flex items-center gap-3">
      <div role="group" aria-label="Week" className="inline-flex items-center gap-0.5 rounded-full chip p-1 text-[13px]">
        <button type="button" onClick={() => onChange(offset - 1)} aria-label="Previous week" title="Previous week"
          className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" onClick={() => onChange(0)} aria-pressed={offset === 0}
          className={cn('h-8 rounded-full px-3.5 font-semibold', offset === 0 ? 'chip-on' : 'hover:bg-white/15')}>This week</button>
        <button type="button" onClick={() => onChange(offset + 1)} aria-label="Next week" title="Next week"
          className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"><ChevronRight className="h-4 w-4" /></button>
      </div>
      <span className="font-semibold dim tnum" aria-live="polite">{label}</span>
    </div>
  );
}

const Dot = ({ color }) => <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
const Cell = ({ minutes, className }) => (
  <td className={cn('whitespace-nowrap p-3 text-right tnum', className)}>{minutes ? formatMinutes(minutes) : <span className="dimmer">—</span>}</td>
);

/** One person's week, day by day: start, category, note, minutes. */
function PersonWeek({ user, days, entries }) {
  const logged = days.filter((d) => entries.some((e) => e.day === d));
  return (
    <section aria-label={`${user.name}, week`} className="rounded-[26px] glass glass-rim p-5 sm:p-6">
      <h2 className="flex items-center gap-2.5 font-extrabold text-[16px]"><Avatar userId={user.id} size={28} ring={false} />{user.name}</h2>
      {logged.length === 0 ? <p className="mt-3 dimmer">No time logged.</p> : (
        <div className="mt-4 flex flex-col gap-5">
          {logged.map((day) => {
            const list = entries.filter((e) => e.day === day).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
            return (
              <div key={day}>
                <div className="flex items-center justify-between gap-3 font-semibold">
                  <span>{dayLabel(day)}</span>
                  <span className="dim tnum">{formatMinutes(list.reduce((t, e) => t + (e.minutes || 0), 0))}</span>
                </div>
                <ul className="mt-1.5">
                  {list.map((e) => (
                    <li key={e.id} className="grid grid-cols-[46px_minmax(0,1fr)_auto] items-center gap-x-3 border-t rowline py-2 text-[13px] sm:grid-cols-[46px_150px_minmax(0,1fr)_auto]">
                      <span className="dim tnum">{e.start}</span>
                      <span className="flex min-w-0 items-center gap-2 font-semibold"><Dot color={CATEGORIES[e.category] || OTHER_COLOR} /><span className="truncate">{e.category}</span></span>
                      <span className="col-start-2 row-start-2 min-w-0 truncate dimmer sm:col-start-auto sm:row-start-auto" title={e.note}>{e.note}</span>
                      <span className="col-start-3 row-start-1 text-right dim tnum sm:col-start-auto sm:row-start-auto">{formatMinutes(e.minutes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Admins: hours per person per category for a week, with totals. A name opens that person's days. */
export default function Timesheets() {
  const { state } = useStore();
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState('');
  const monday = addDays(mondayOf(localYmd()), offset * 7);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const sunday = days[6];

  const { entries, people, categories, sums } = useMemo(() => {
    const known = new Set(state.users.map((u) => u.id));
    const week = (state.timeEntries || []).filter((e) => e.day >= monday && e.day <= sunday && known.has(e.user));
    // Active people, plus anyone inactive who logged time this week.
    const who = state.users.filter((u) => u.active !== false || week.some((e) => e.user === u.id));
    // Categories with time this week, in the usual order; anything unknown after them.
    const used = new Set(week.map((e) => e.category || 'Other'));
    const cats = [...Object.keys(CATEGORIES).filter((c) => used.has(c)), ...[...used].filter((c) => !(c in CATEGORIES)).sort()];
    const totals = {}; // { [userId]: { [category]: minutes, '': total } }
    week.forEach((e) => {
      if (!totals[e.user]) totals[e.user] = { '': 0 };
      const t = totals[e.user];
      const c = e.category || 'Other';
      t[c] = (t[c] || 0) + (e.minutes || 0);
      t[''] += e.minutes || 0;
    });
    return { entries: week, people: who, categories: cats, sums: totals };
  }, [state.timeEntries, state.users, monday, sunday]);

  const columnTotal = (c) => people.reduce((t, u) => t + (sums[u.id]?.[c] || 0), 0);
  const openUser = people.find((u) => u.id === open);

  return (
    <div className="flex flex-col gap-5">
      <WeekNav offset={offset} onChange={setOffset} label={weekLabel(monday, sunday)} />
      <div className="rounded-[26px] glass glass-rim p-2 sm:p-3">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[420px] text-[13.5px]">
            <thead>
              <tr className="text-left text-[12px] dimmer">
                <th className="p-3 font-medium">Person</th>
                {categories.map((c) => (
                  <th key={c} className="p-3 text-right font-medium">
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Dot color={CATEGORIES[c] || OTHER_COLOR} />{c}</span>
                  </th>
                ))}
                <th className="p-3 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {people.map((u) => {
                const t = sums[u.id] || {};
                const isOpen = open === u.id;
                return (
                  <tr key={u.id} className={cn('border-t rowline', isOpen && 'bg-white/5')}>
                    <td className="p-2">
                      <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : u.id)}
                        className={cn('flex max-w-full items-center gap-2.5 rounded-full py-1 pl-1 pr-3 text-left font-semibold hover:bg-white/10', u.active === false && 'opacity-60')}>
                        <Avatar userId={u.id} size={26} ring={false} /><span className="truncate">{u.name}</span>
                      </button>
                    </td>
                    {categories.map((c) => <Cell key={c} minutes={t[c]} className="dim" />)}
                    <Cell minutes={t['']} className="font-bold" />
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t rowline">
                <th scope="row" className="p-3 text-left font-semibold">Total</th>
                {categories.map((c) => <Cell key={c} minutes={columnTotal(c)} className="font-semibold" />)}
                <Cell minutes={columnTotal('')} className="font-extrabold" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      {openUser && <PersonWeek user={openUser} days={days} entries={entries.filter((e) => e.user === openUser.id)} />}
    </div>
  );
}
