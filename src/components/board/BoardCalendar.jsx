import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { nextMonths } from '@/lib/calendar';
import { localYmd } from '@/lib/format';
import { cn } from '@/lib/cn';
import MonthGrid from './MonthGrid';
import { datedItems } from './CalendarView';

/** A board's calendar of this month above its tasks (board.calendar, 0009: Posting schedule to start; one month since
 *  §27, owner's ask), with the board's search and filters. The same tasks, and the months around, are on the team Calendar. */
export default function BoardCalendar({ groups, onOpen }) {
  const [open, setOpen] = useState(true);
  const items = datedItems(groups);
  const [month] = nextMonths(localYmd(), 1);
  const count = items.filter((i) => i.date >= `${month}-01` && i.date <= `${month}-31`).length;
  return (
    <section className="mt-7" aria-label="This month">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-2 text-[17px] font-extrabold">
        <ChevronDown className={cn('h-5 w-5 shrink-0 transition-transform', !open && '-rotate-90')} />
        Calendar<span className="text-[12px] font-semibold dimmer">{count}</span>
      </button>
      {open && (
        <div className="mt-3 rounded-[22px] glass overflow-hidden">
          <div className="px-4 pb-2 pt-3 font-extrabold text-[14px]">
            {new Date(`${month}-01T00:00:00`).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}
          </div>
          <MonthGrid month={month} items={items} onOpen={onOpen} />
        </div>
      )}
    </section>
  );
}
