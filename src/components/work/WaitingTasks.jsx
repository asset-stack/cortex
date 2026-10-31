import { Check, Inbox } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { PRIORITY, PRIORITY_HINTS, STATUS, hasDates, schemaOf } from '@/data/boards';
import { LabelPicker } from '@/components/ui';
import { useAccess } from '@/lib/access';
import { boardHref, firstName } from '@/lib/boards';
import { hasPriority, whereOf } from '@/lib/work';
import { ago, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const SMALL = '!h-[24px] !px-2 !text-[11.5px]';

// Once a row has gone (accepted or started: it moves to My tasks), focus the list's heading next frame, so it never
// falls to the page.
const refocus = () => requestAnimationFrame(() => document.querySelector('[data-waiting] h2, [data-mytasks] h2')?.focus());

/** One task handed over and not yet accepted: priority, name, who handed it over and where it lives, status, due, and
 *  Accept for its owner. Starting it (a status) accepts it too. */
function WaitingRow({ row, personId, act }) {
  const { state, actions } = useStore();
  const users = useUsers();
  const access = useAccess();
  const { item, board, priority, due, overdue, from } = row;
  const editable = access.canEditBoard(board);
  const status = item.values.status || 'Not started';
  const name = item.name.trim() || 'Untitled task';
  const where = whereOf(state, board, item).join(' › ');
  const canAccept = act && personId === state.me && editable;
  const update = (values, extra = {}) => actions.updateItem(board.id, item.id, { values, ...extra });
  return (
    <li data-task={item.id} className="task-row relative flex flex-wrap items-center gap-x-3 gap-y-2 border-t rowline py-2.5 pl-5 pr-3">
      {hasPriority(board) && (
        <span className="w-[68px] shrink-0">
          {editable ? (
            <LabelPicker label={`Priority for ${name}`} value={priority} options={PRIORITY} hints={PRIORITY_HINTS} placeholder="Set"
              onChange={(v) => { if (v !== priority) update({ priority: v }); }} className={cn(SMALL, !priority && 'dimmer')} />
          ) : (
            <span className={cn('pill w-full', SMALL, !priority && 'pill-empty dimmer')} style={priority ? { backgroundColor: PRIORITY[priority] } : undefined}>
              <span className="sr-only">Priority: </span>{priority || 'None'}
            </span>
          )}
        </span>
      )}
      <div className="task-name min-w-0 flex-1 basis-[calc(100%-80px)]">
        <a href={boardHref(board, item.id)} className="break-words font-semibold hover:underline">{name}</a>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] dimmer" title={where}>
          {from && <><span className="text-amber-200">From {firstName(users[from]?.name)} · {ago(item.values.assignedAt)}</span><span aria-hidden="true">·</span></>}
          <span>{where}</span>
        </div>
      </div>
      <span className="w-[104px] shrink-0">
        {editable ? (
          <LabelPicker label={`Status for ${name}`} value={status} options={STATUS} allowEmpty={false} className={SMALL}
            onChange={(v) => { if (v !== status) { update({ status: v }, { done: v === 'Done' }); refocus(); } }} />
        ) : (
          <span className={cn('pill', SMALL)} style={{ backgroundColor: STATUS[status] || STATUS['Not started'] }}>{status}</span>
        )}
      </span>
      {hasDates(schemaOf(board)) && (
        <span className={cn('task-push ml-auto min-w-[52px] shrink-0 whitespace-nowrap text-right text-[12.5px] tnum', overdue ? 'font-semibold text-rose-300' : 'dim')}>
          {shortDate(due)}{overdue && <span className="sr-only"> (overdue)</span>}
        </span>
      )}
      {canAccept && (
        <button type="button" aria-label={`Accept ${name}`} className="btn-primary inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold"
          onClick={() => { if (actions.acceptItem(board.id, item.id)) refocus(); }}>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />Accept
        </button>
      )}
    </li>
  );
}

/**
 * **Waiting on you** (docs/PHASE2.md §18): tasks handed to someone that they haven't accepted yet (rows from
 * src/lib/work.js prioritiesFor, `waiting`), one list; their owner accepts. Accepted, a task joins My tasks
 * (src/components/work/PersonTasks.jsx). `act`: show Accept (their own Dashboard).
 */
export default function WaitingTasks({ rows, personId, act = false, title = 'Waiting on you' }) {
  return (
    <section aria-label={title} data-waiting="" className="task-cards glass glass-rim rounded-[24px] ring-1 ring-amber-300/40">
      <h2 tabIndex={-1} className="flex items-center gap-2 px-5 pb-3 pt-4 font-extrabold text-[16px] outline-none">
        <Inbox className="h-4 w-4" aria-hidden="true" />{title}<span className="text-[12px] font-semibold dimmer tnum">{rows.length}</span>
      </h2>
      <ol className="min-w-0">{rows.map((r) => <WaitingRow key={r.item.id} row={r} personId={personId} act={act} />)}</ol>
    </section>
  );
}
