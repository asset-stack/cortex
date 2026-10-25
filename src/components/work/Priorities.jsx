import { useMemo } from 'react';
import { Flag } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { PRIORITY, PRIORITY_HINTS, STATUS } from '@/data/boards';
import { boardHref, boardTitle, firstName } from '@/lib/boards';
import { MAX_IN_PROGRESS, MAX_URGENT, prioritiesFor, workload } from '@/lib/work';
import { localYmd, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

/** The open tasks `personId` owns on every board they see, Urgent first (src/lib/work.js prioritiesFor): what to work
 *  on next. New marks a task someone else handed them in the last two days. */
export default function Priorities({ personId }) {
  const { state } = useStore();
  const users = useUsers();
  const today = localYmd();
  const rows = useMemo(() => prioritiesFor(state, personId, { today }), [state, personId, today]);
  const load = workload(rows);
  const self = personId === state.me;
  const notes = [
    load.urgent > MAX_URGENT && `${load.urgent} Urgent: one at a time. Move the rest to High.`,
    load.inProgress > MAX_IN_PROGRESS && `${load.inProgress} In progress: finish or pause one (${MAX_IN_PROGRESS} at a time).`,
  ].filter(Boolean);

  return (
    <section aria-label="Priorities" className="glass rounded-[24px]">
      <h2 className="flex items-center gap-2 px-5 pb-3 pt-4 font-extrabold text-[16px]">
        <Flag className="h-4 w-4" aria-hidden="true" />Priorities<span className="text-[12px] font-semibold dimmer tnum">{rows.length}</span>
      </h2>
      {notes.length > 0 && (
        <p className="mx-5 mb-3 rounded-2xl bg-amber-500/20 px-3 py-2 text-[13px] text-amber-100">{notes.join(' ')}</p>
      )}
      {rows.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">{self ? 'Nothing assigned to you.' : 'Nothing assigned.'}</p> : (
        <ol className="min-w-0">
          {rows.map(({ item, board, priority, due, overdue, client, isNew, from }) => {
            const status = item.values.status || 'Not started';
            return (
              <li key={item.id} className="flex items-center gap-3 border-t rowline py-2.5 pl-5 pr-4">
                <span className={cn('pill !h-[24px] w-[68px] shrink-0 !px-2 !text-[11.5px]', !priority && 'pill-empty dimmer')}
                  style={priority ? { backgroundColor: PRIORITY[priority] } : undefined} title={PRIORITY_HINTS[priority]}>
                  <span className="sr-only">Priority: </span>{priority || 'None'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <a href={boardHref(board, item.id)} className="min-w-0 break-words font-semibold hover:underline">{item.name.trim() || 'Untitled task'}</a>
                    {isNew && (
                      <span className="shrink-0 rounded-full bg-[#2337EE] px-2 py-px text-[11px] font-bold text-white">
                        New · from {firstName(users[from]?.name)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px] dimmer">
                    {boardTitle(state, board)}{client ? ` · ${client.name}` : ''}
                  </div>
                </div>
                <span className="hidden w-[104px] shrink-0 sm:block">
                  <span className="pill !h-[24px] !text-[11.5px]" style={{ backgroundColor: STATUS[status] || STATUS['Not started'] }}>{status}</span>
                </span>
                <span className={cn('min-w-[52px] shrink-0 whitespace-nowrap text-right text-[12.5px] tnum', overdue ? 'font-semibold text-rose-300' : 'dim')}>
                  {shortDate(due)}{overdue && <span className="sr-only"> (overdue)</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
