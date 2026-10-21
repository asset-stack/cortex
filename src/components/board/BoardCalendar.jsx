import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { nextMonths } from '@/lib/calendar';
import { localYmd } from '@/lib/format';
import { cn } from '@/lib/cn';
import MonthGrid from './MonthGrid';
import { datedItems } from './CalendarView';

/** A board's running 3-month calendar above its tasks (board.calendar, 0009: Posting schedule to start): this month and
 *  the next two, with the board's search, person and status filters. The same tasks are on the team Calendar. */
export default function BoardCalendar({ groups, onOpen }) {
  const [open, setOpen] = useState(true);
  const items = datedItems(groups);
  const months = nextMonths(localYmd(), 3);
  const count = items.filter((i) => i.date >= `${months[0]}-01` && i.date <= `${months[2]}-31`).length;
  return (
    <section className="mt-7" aria-label="Next 3 months">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-2 text-[17px] font-extrabold">
        <ChevronDown className={cn('h-5 w-5 shrink-0 transition-transform', !open && '-rotate-90')} />
        Calendar<span className="text-[12px] font-semibold dimmer">{count}</span>
      </button>
      {open && (
        <div className="mt-3 grid gap-3 xl:grid-cols-3">
          {months.map((m) => (
            <div key={m} className="rounded-[22px] glass overflow-hidden">
              <div className="px-4 pb-2 pt-3 font-extrabold text-[14px]">
                {new Date(`${m}-01T00:00:00`).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}
              </div>
              <MonthGrid month={m} items={items} onOpen={onOpen} compact />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
