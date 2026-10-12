import { useEffect, useReducer, useState } from 'react';
import { Clock } from 'lucide-react';
import { useStore } from '@/data/store';
import { localYmd } from '@/lib/format';
import { isPromptDue, isSnoozed, snoozeUntilTomorrow } from '@/lib/timesheet';
import TimesheetModal from './TimesheetModal';

/** Staff, weekdays from 16:30 local time, until today's hours are in (or snoozed until tomorrow). */
export default function TimesheetPrompt() {
  const { state } = useStore();
  const [, tick] = useReducer((n) => n + 1, 0);
  const [open, setOpen] = useState(false);
  const [later, setLater] = useState(''); // `${user}|${day}` snoozed in this visit, in case storage is unavailable
  useEffect(() => {
    const id = setInterval(tick, 30_000);
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const now = new Date();
  const day = localYmd(now);
  const me = state.me;
  const logged = state.timeEntries.some((e) => e.user === me && e.day === day);
  const show = isPromptDue(now) && !logged && later !== `${me}|${day}` && !isSnoozed(me, day);
  const snooze = () => { snoozeUntilTomorrow(me, day); setLater(`${me}|${day}`); };

  return (
    <>
      {show && (
        <section aria-label="Timesheet" className="glass glass-rim mb-6 flex flex-wrap items-center gap-3 rounded-[24px] p-4 no-print">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl chip"><Clock className="h-5 w-5" aria-hidden="true" /></span>
          <h2 className="min-w-0 flex-1 font-extrabold text-[16px]">Log today&rsquo;s time</h2>
          <div className="flex gap-2">
            <button type="button" onClick={snooze} className="h-10 rounded-full chip px-4 font-semibold">Remind me tomorrow</button>
            <button type="button" onClick={() => setOpen(true)} className="btn-primary h-10 rounded-full px-5 font-semibold">Log time</button>
          </div>
        </section>
      )}
      <TimesheetModal open={open} onClose={() => setOpen(false)} day={day} />
    </>
  );
}
