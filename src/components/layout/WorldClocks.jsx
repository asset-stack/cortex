import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { zoneNow } from '@/lib/format';
import { cn } from '@/lib/cn';

// The team's cities: Sydney (the business zone), Josh in Tbilisi, ops staff in Manila.
const CLOCKS = [
  { city: 'Sydney', country: 'Australia', zone: 'Australia/Sydney' },
  { city: 'Tbilisi', country: 'Georgia', zone: 'Asia/Tbilisi' },
  { city: 'Manila', country: 'Philippines', zone: 'Asia/Manila' },
];
const DAYS = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const MINUTE = 60_000;

// Now, renewed as each minute starts (so the clocks never run a minute behind) and when the tab comes back.
function useMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer;
    const wait = () => { timer = setTimeout(() => { setNow(new Date()); wait(); }, MINUTE - (Date.now() % MINUTE) + 50); };
    wait();
    const onVis = () => { if (document.visibilityState === 'visible') setNow(new Date()); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  return now;
}

/** Sydney, Tbilisi and Manila: each city's time and day, with a sun from 6 am to 6 pm there and a moon otherwise. At the
 *  top of every page: right-aligned on wide screens, three columns across on phones. */
export default function WorldClocks({ className }) {
  const now = useMinute();
  return (
    <div role="group" aria-label="World clocks" className={cn('flex justify-end', className)}>
      <div className="glass grid w-full grid-cols-3 rounded-[20px] md:flex md:w-auto md:rounded-full">
        {CLOCKS.map((c, i) => {
          const z = zoneNow(c.zone, now);
          if (!z) return null;
          const day = z.hour >= 6 && z.hour < 18;
          const Icon = day ? Sun : Moon;
          return (
            <div key={c.zone} title={`${c.city}, ${c.country}: ${z.time}, ${DAYS[z.day] || z.day}`}
              className={cn('flex min-w-0 flex-col items-center gap-0.5 px-2 py-2 text-[13px] md:flex-row md:gap-2.5 md:px-4',
                i > 0 && 'border-l border-white/10')}>
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon className={cn('h-4 w-4 shrink-0', day ? 'text-amber-200' : 'text-sky-200')} aria-hidden="true" />
                <span className="truncate font-semibold">{c.city}</span>
              </span>
              <span className="flex items-baseline gap-1.5 whitespace-nowrap">
                <span className="font-bold tnum">{z.time}</span>
                <span className="text-[12px] dimmer">{z.day}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
