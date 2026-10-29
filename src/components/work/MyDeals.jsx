import { useMemo, useState } from 'react';
import { ChevronDown, Target } from 'lucide-react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { needsYou } from '@/lib/accounts';
import { compactIn, localYmd, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const SHOWN = 6;
const TINT = { Overdue: 'bg-rose-500/25', 'Waiting on you': 'bg-amber-500/25', Stalled: 'bg-amber-500/25', 'No next step': 'bg-white/10' };

/** Dashboard: someone's deals that need them (overdue, waiting on them, stalled, no next step) and their set-aside
 *  accounts due a revisit (src/lib/accounts.js needsYou). Each opens it on Pipeline. Nothing without Pipeline view, or
 *  with nothing to do. */
export default function MyDeals({ personId }) {
  const { state } = useStore();
  const access = useAccess();
  const today = localYmd();
  const { deals, revisits } = useMemo(() => needsYou(state, personId, { today }), [state, personId, today]);
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  if (!access.canView('pipeline') || (!deals.length && !revisits.length)) return null;
  const shown = all ? deals : deals.slice(0, SHOWN);
  return (
    <section aria-label="My deals" className="glass rounded-[24px] p-5">
      <h2>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex w-full items-center gap-2 text-left font-extrabold text-[16px]">
          <Target className="h-4 w-4" aria-hidden="true" />My deals<span className="text-[12px] font-semibold dimmer tnum">{deals.length + revisits.length}</span>
          <ChevronDown className={cn('ml-auto h-4 w-4 dim transition-transform', !open && '-rotate-90')} aria-hidden="true" />
        </button>
      </h2>
      {open && (
        <>
          <ol className="mt-3 flex flex-col gap-1">
            {shown.map(({ deal, reasons }) => (
              <li key={deal.id}>
                <a href={`#/pipeline?deal=${encodeURIComponent(deal.id)}`} className="block rounded-2xl px-2 py-2 hover:bg-white/10">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 break-words font-semibold">{deal.name}</span>
                    <span className="shrink-0 text-[12.5px] tnum dim">{compactIn(deal.value, deal.currency)}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {reasons.map((r) => <span key={r} className={cn('rounded-full px-2 py-0.5 text-[11.5px] font-semibold', TINT[r])}>{r}</span>)}
                  </span>
                </a>
              </li>
            ))}
            {revisits.map((a) => (
              <li key={a.id}>
                <a href={`#/pipeline?account=${encodeURIComponent(a.id)}`} className="block rounded-2xl px-2 py-2 hover:bg-white/10">
                  <span className="block break-words font-semibold">{a.name}</span>
                  <span className="mt-1 inline-block rounded-full bg-sky-500/25 px-2 py-0.5 text-[11.5px] font-semibold">Revisit · {shortDate(a.revisitOn)}</span>
                </a>
              </li>
            ))}
          </ol>
          {deals.length > SHOWN && (
            <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 rounded-full chip px-3 h-8 text-[12.5px] font-semibold">
              {all ? 'Show fewer' : `Show all ${deals.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
