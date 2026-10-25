import { Check, Flag, Inbox, Plus } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { PRIORITY, PRIORITY_HINTS, STATUS } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { boardHref, firstName } from '@/lib/boards';
import { MAX_IN_PROGRESS, MAX_URGENT, todoForItem, whereOf } from '@/lib/work';
import { ago, localYmd, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const ACTION = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold';

/**
 * Board tasks for someone (rows from src/lib/work.js prioritiesFor): **Waiting on you** (`waiting`: handed to them, not
 * yet accepted; their owner accepts) or **My tasks** (the rest, Urgent first; Do today puts one on their day, for them or
 * an admin). `personId`: whose; `act`: show the actions (their own Dashboard, or an admin's look at it); `title`: the
 * heading. `load` (workload()) adds the team-rule note to My tasks.
 */
export default function MyTasks({ rows, personId, waiting = false, act = false, title, load, empty }) {
  const { state, actions } = useStore();
  const users = useUsers();
  const access = useAccess();
  const today = localYmd();
  const self = personId === state.me;
  const notes = load ? [
    load.urgent > MAX_URGENT && `${load.urgent} Urgent: one at a time. Move the rest to High.`,
    load.inProgress > MAX_IN_PROGRESS && `${load.inProgress} In progress: finish or pause one (${MAX_IN_PROGRESS} at a time).`,
  ].filter(Boolean) : [];
  const Icon = waiting ? Inbox : Flag;
  const heading = title || (waiting ? 'Waiting on you' : 'My tasks');

  return (
    <section aria-label={heading} className={cn('glass rounded-[24px]', waiting && 'glass-rim ring-1 ring-amber-300/40')}>
      <h2 className="flex items-center gap-2 px-5 pb-3 pt-4 font-extrabold text-[16px]">
        <Icon className="h-4 w-4" aria-hidden="true" />{heading}<span className="text-[12px] font-semibold dimmer tnum">{rows.length}</span>
      </h2>
      {notes.length > 0 && (
        <p className="mx-5 mb-3 rounded-2xl bg-amber-500/20 px-3 py-2 text-[13px] text-amber-100">{notes.join(' ')}</p>
      )}
      {rows.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">{empty || 'Nothing assigned.'}</p> : (
        <ol className="min-w-0">
          {rows.map(({ item, board, priority, due, overdue, from }) => {
            const status = item.values.status || 'Not started';
            const name = item.name.trim() || 'Untitled task';
            const where = whereOf(state, board, item).join(' › ');
            const onToday = !waiting && todoForItem(state.todos, item.id, personId, today);
            const canAccept = waiting && act && self && access.canEditBoard(board);
            const canPlan = !waiting && act && (self || access.isAdmin);
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t rowline py-2.5 pl-5 pr-4 sm:flex-nowrap">
                <span className={cn('pill !h-[24px] w-[68px] shrink-0 !px-2 !text-[11.5px]', !priority && 'pill-empty dimmer')}
                  style={priority ? { backgroundColor: PRIORITY[priority] } : undefined} title={PRIORITY_HINTS[priority]}>
                  <span className="sr-only">Priority: </span>{priority || 'None'}
                </span>
                <div className="min-w-0 flex-1 basis-[calc(100%-80px)] sm:basis-auto">
                  <a id={`task-${item.id}`} href={boardHref(board, item.id)} className="break-words font-semibold hover:underline">{name}</a>
                  <div className="mt-0.5 truncate text-[12.5px] dimmer" title={where}>
                    {waiting && from && <span className="text-amber-200">From {firstName(users[from]?.name)} · {ago(item.values.assignedAt)} · </span>}
                    {where}
                  </div>
                </div>
                <span className="hidden w-[104px] shrink-0 md:block">
                  <span className="pill !h-[24px] !text-[11.5px]" style={{ backgroundColor: STATUS[status] || STATUS['Not started'] }}>{status}</span>
                </span>
                <span className={cn('ml-auto min-w-[52px] shrink-0 whitespace-nowrap text-right text-[12.5px] tnum sm:ml-0', overdue ? 'font-semibold text-rose-300' : 'dim')}>
                  {shortDate(due)}{overdue && <span className="sr-only"> (overdue)</span>}
                </span>
                {canAccept && (
                  // Accepted, it moves to My tasks: focus follows it there rather than falling to the page.
                  <button type="button" aria-label={`Accept ${name}`} className={cn(ACTION, 'btn-primary')}
                    onClick={() => { if (actions.acceptItem(board.id, item.id)) requestAnimationFrame(() => document.getElementById(`task-${item.id}`)?.focus()); }}>
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />Accept
                  </button>
                )}
                {canPlan && (
                  // One button either way, so focus stays on it once the task is on today.
                  <button type="button" aria-disabled={onToday ? 'true' : undefined} aria-label={onToday ? `${name} is on today` : `Do ${name} today`}
                    onClick={() => { if (!onToday) actions.addTodoForItem(board.id, item.id, { assignee: personId }); }}
                    className={cn(ACTION, 'chip', onToday ? 'cursor-default dimmer' : 'hover:bg-white/15')}>
                    {onToday ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                    {onToday ? 'On today' : 'Do today'}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
