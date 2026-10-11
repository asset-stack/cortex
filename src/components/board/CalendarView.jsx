import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { STATUS } from '@/data/boards';
import { cn } from '@/lib/cn';

const pad = (n) => String(n).padStart(2, '0');

export default function CalendarView({ groups, onOpen }) {
  const today = new Date();
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
  const days = new Date(y, m + 1, 0).getDate();
  const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first
  const prefix = `${y}-${pad(m + 1)}-`;
  const items = groups.flatMap((g) => g.items).filter((i) => i.values.due?.startsWith(prefix));
  const isToday = (d) => today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;

  return (
    <div className="mt-7 overflow-x-auto scroll-thin">
      <div className="min-w-[720px] rounded-[24px] glass overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4">
          <div className="font-extrabold text-[16px]">{cursor.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}</div>
          <div className="flex gap-1.5">
            <button type="button" aria-label="Previous month" onClick={() => setCursor(new Date(y, m - 1, 1))} className="grid h-8 w-8 place-items-center rounded-full chip"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" aria-label="Next month" onClick={() => setCursor(new Date(y, m + 1, 1))} className="grid h-8 w-8 place-items-center rounded-full chip"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="grid grid-cols-7 text-[12px] dimmer">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="px-3 pb-2">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: lead }, (_, k) => <div key={`l${k}`} className="min-h-28 border-t border-r rowline" />)}
          {Array.from({ length: days }, (_, k) => k + 1).map((d) => (
            <div key={d} className={cn('min-h-28 border-t border-r rowline p-1.5', isToday(d) && 'bg-white/15')}>
              <div className={cn('text-[12px] tnum', isToday(d) ? 'font-bold' : 'dimmer')}>{d}</div>
              {items.filter((i) => i.values.due === `${prefix}${pad(d)}`).map((i) => (
                <button key={i.id} type="button" onClick={() => onOpen(i.id)} title={i.name}
                  className="pill mt-1 !h-6 w-full !justify-start overflow-hidden text-[11.5px]" style={{ backgroundColor: STATUS[i.values.status] }}>
                  <span className="min-w-0 truncate">{i.name}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
