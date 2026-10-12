import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { dayLabel } from '@/lib/timesheet';

/** ‹ Today › with the day it shows. `offset` is days from today. */
export default function DayNav({ offset, onChange, day }) {
  return (
    <div className="flex items-center gap-3">
      <div role="group" aria-label="Day" className="inline-flex items-center gap-0.5 rounded-full chip p-1 text-[13px]">
        <button type="button" onClick={() => onChange(offset - 1)} aria-label="Previous day" title="Previous day"
          className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" onClick={() => onChange(0)} aria-pressed={offset === 0}
          className={cn('h-8 rounded-full px-3.5 font-semibold', offset === 0 ? 'chip-on' : 'hover:bg-white/15')}>Today</button>
        <button type="button" onClick={() => onChange(offset + 1)} aria-label="Next day" title="Next day"
          className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"><ChevronRight className="h-4 w-4" /></button>
      </div>
      <span className="font-semibold dim tnum" aria-live="polite">{dayLabel(day)}</span>
    </div>
  );
}
