import { useMemo, useState } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { useStore } from '@/data/store';
import { boardHref } from '@/lib/boards';
import { needsAttention, whereOf } from '@/lib/work';
import { localYmd } from '@/lib/format';
import { cn } from '@/lib/cn';

const SHOWN = 6;
const TINT = {
  Overdue: 'bg-rose-500/25', Stuck: 'bg-rose-500/25', 'Not accepted': 'bg-amber-500/25', 'No owner': 'bg-amber-500/25', 'Several people': 'bg-amber-500/25',
  'No priority': 'bg-white/10',
};

/** Admins: open team-board tasks that are overdue, Stuck, not accepted after a day, have no owner or several people, or
 *  no priority (src/lib/work.js needsAttention). Each opens the task to fix it. */
export default function NeedsAttention() {
  const { state } = useStore();
  const today = localYmd();
  const rows = useMemo(() => needsAttention(state, { today }), [state, today]);
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN);

  return (
    <section aria-label="Needs attention" className="glass rounded-[24px] p-5">
      <h2>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex w-full items-center gap-2 text-left font-extrabold text-[16px]">
          <TriangleAlert className="h-4 w-4" aria-hidden="true" />Needs attention<span className="text-[12px] font-semibold dimmer tnum">{rows.length}</span>
          <ChevronDown className={cn('ml-auto h-4 w-4 dim transition-transform', !open && '-rotate-90')} aria-hidden="true" />
        </button>
      </h2>
      {open && (rows.length === 0 ? <p className="mt-3 dimmer">All clear.</p> : (
        <>
          <ol className="mt-3 flex flex-col gap-1">
            {shown.map(({ item, board, reasons }) => (
              <li key={item.id}>
                <a href={boardHref(board, item.id)} className="block rounded-2xl px-2 py-2 hover:bg-white/10">
                  <div className="break-words font-semibold">{item.name.trim() || 'Untitled task'}</div>
                  <div className="mt-0.5 truncate text-[12.5px] dimmer">{whereOf(state, board, item).join(' › ')}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {reasons.map((r) => <span key={r} className={cn('rounded-full px-2 py-px text-[11.5px] font-semibold', TINT[r])}>{r}</span>)}
                  </div>
                </a>
              </li>
            ))}
          </ol>
          {rows.length > SHOWN && (
            <button type="button" onClick={() => setAll((a) => !a)} className="mt-2 rounded-full chip px-3.5 h-9 text-[13px] font-semibold">
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
        </>
      ))}
    </section>
  );
}
