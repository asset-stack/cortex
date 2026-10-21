import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { STATUS } from '@/data/boards';
import { addMonths, isYmd } from '@/lib/automations';
import { localYmd } from '@/lib/format';
import MonthGrid from './MonthGrid';

// A board's tasks by due date, one month at a time (the board's Calendar view).
export const datedItems = (groups) => groups.flatMap((g) => g.items).filter((i) => isYmd(i.values.due))
  .map((i) => ({ id: i.id, name: i.name, date: i.values.due, color: STATUS[i.values.status] }));

export default function CalendarView({ groups, onOpen }) {
  const [month, setMonth] = useState(() => localYmd().slice(0, 7));
  const step = (n) => setMonth((m) => addMonths(`${m}-01`, n).slice(0, 7));
  return (
    <div className="mt-7 overflow-x-auto scroll-thin">
      <div className="min-w-[720px] rounded-[24px] glass overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4">
          <div className="font-extrabold text-[16px]">{new Date(`${month}-01T00:00:00`).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}</div>
          <div className="flex gap-1.5">
            <button type="button" aria-label="Previous month" onClick={() => step(-1)} className="grid h-8 w-8 place-items-center rounded-full chip"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" aria-label="Next month" onClick={() => step(1)} className="grid h-8 w-8 place-items-center rounded-full chip"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
        <MonthGrid month={month} items={datedItems(groups)} onOpen={onOpen} />
      </div>
    </div>
  );
}
