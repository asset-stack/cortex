import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { useStore } from '@/data/store';
import { AvatarStack } from '@/components/ui';
import { collectEntries, meetingsOn, syncDue } from '@/lib/calendar';

/**
 * The day's meetings on the Dashboard (docs/PHASE2.md §27): everyone's Google meetings (read on demand, as the Calendar
 * page does) and the team's meetings, events and reminders for `day`, all-day first, then by time. A Private or
 * Confidential meeting stays Busy (collectEntries); one several teammates share is one row (meetingsOn). Opening the
 * Dashboard syncs Google when the last sync is over 10 minutes old, as opening the Calendar does (live mode; the google
 * function spaces each person's syncs out). `title`: the block's heading ("Today's meetings" …).
 */
export default function DayMeetings({ day, title }) {
  const { state, calendar } = useStore();
  const [meetings, setMeetings] = useState([]);
  const [synced, setSynced] = useState(0); // bumped after a sync, to read the day again
  useEffect(() => {
    if (!calendar.live) return undefined;
    let gone = false;
    calendar.status().then((res) => {
      if (gone || !res?.ok || !syncDue(res)) return;
      calendar.sync({ force: false }).then((r) => { if (!gone && r?.ok) setSynced((n) => n + 1); }, () => {});
    }, () => {});
    return () => { gone = true; };
  }, [calendar]);
  // Only the newest request's answer is shown (moving to another day mid-load must not bring the old day back).
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    calendar.meetings(day, day).then((res) => { if (res?.ok && n === asked.current) setMeetings(res.rows); }, () => {});
  }, [calendar, day, synced]);
  const rows = useMemo(() => meetingsOn(collectEntries(state, { meetings }), day), [state, meetings, day]);
  return (
    <section aria-label={title} className="glass rounded-[24px]">
      <h2 className="flex items-center gap-2 px-5 pb-3 pt-4 font-extrabold text-[16px]">
        <CalendarDays className="h-4 w-4" aria-hidden="true" />
        <a href="#/calendar" className="hover:underline">{title}</a>
        <span className="text-[12px] font-semibold dimmer tnum">{rows.length}</span>
      </h2>
      {rows.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">No meetings.</p> : (
        <ul>
          {rows.map((e) => (
            <li key={e.key} data-meeting={e.key} className="flex items-center gap-3 border-t rowline px-5 py-2.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: e.color }} aria-hidden="true" />
              <span className="w-[92px] shrink-0 whitespace-nowrap text-[12.5px] dim tnum">
                {e.time ? `${e.time}${e.endTime ? `–${e.endTime}` : ''}` : 'All day'}
              </span>
              <span className="min-w-0 flex-1 break-words font-semibold">{e.title}</span>
              {e.people.length > 0 && <AvatarStack userIds={e.people} size={24} max={3} label="Who" />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
