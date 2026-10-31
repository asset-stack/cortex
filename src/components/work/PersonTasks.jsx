import { useState } from 'react';
import { Check, Flag, Plus } from 'lucide-react';
import { useStore } from '@/data/store';
import { BOARD_SCHEMAS, schemaOf } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { boardHref, findBoard } from '@/lib/boards';
import { MAX_IN_PROGRESS, MAX_URGENT, byBoard, todoForItem, whereOf } from '@/lib/work';
import { localYmd } from '@/lib/format';
import TableView from '@/components/board/TableView';
import ItemDrawer from '@/components/board/ItemDrawer';
import { cn } from '@/lib/cn';

/** Put a task on the person's day (one to-do per task and day); once it's there the button says so and stays put. */
function DoToday({ board, item, personId }) {
  const { state, actions } = useStore();
  const name = item.name.trim() || 'Untitled task';
  const onToday = Boolean(todoForItem(state.todos, item.id, personId, localYmd()));
  return (
    <button type="button" aria-disabled={onToday ? 'true' : undefined} aria-label={onToday ? `${name} is on today` : `Do ${name} today`}
      title={onToday ? 'On today' : 'Do today'}
      onClick={() => { if (!onToday) actions.addTodoForItem(board.id, item.id, { assignee: personId }); }}
      className={cn('inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full chip px-2.5 text-[12px] font-semibold',
        onToday ? 'cursor-default dimmer' : 'hover:bg-white/15')}>
      {onToday ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}Today
    </button>
  );
}

/**
 * Someone's allocated tasks (rows from src/lib/work.js prioritiesFor: the ones they own and the ones they're Also on),
 * as their boards show them (docs/PHASE2.md §22): a card per board, titled where it lives, holding that board's own
 * table with just their tasks, in the board's order and groups. The same columns and cells as the board, edited by
 * whoever can edit the board, and a task opens in the same drawer; what belongs to the board itself (groups, adding,
 * order) stays on the board. `act`: Do today (their own list, or an admin's look at it). `load` (workload()) adds the
 * team-rule note.
 */
export default function PersonTasks({ rows, personId, title = 'My tasks', empty = 'Nothing assigned.', load, act = false }) {
  const { state } = useStore();
  const access = useAccess();
  const [open, setOpen] = useState(null); // { boardId, itemId } of the task in the drawer
  const openBoard = open ? findBoard(state, open.boardId) : null;
  const canPlan = act && (personId === state.me || access.isAdmin);
  const notes = load ? [
    load.urgent > MAX_URGENT && `${load.urgent} Urgent: one at a time. Move the rest to High.`,
    load.inProgress > MAX_IN_PROGRESS && `${load.inProgress} In progress: finish or pause one (${MAX_IN_PROGRESS} at a time).`,
  ].filter(Boolean) : [];
  return (
    <section aria-label={title} data-mytasks="">
      <h2 tabIndex={-1} className="flex items-center gap-2 font-extrabold text-[16px] outline-none">
        <Flag className="h-4 w-4" aria-hidden="true" />{title}<span className="text-[12px] font-semibold dimmer tnum">{rows.length}</span>
      </h2>
      {notes.length > 0 && <p className="mt-3 rounded-2xl bg-amber-500/20 px-3 py-2 text-[13px] text-amber-100">{notes.join(' ')}</p>}
      {rows.length === 0 ? <p className="mt-3 rounded-[24px] glass px-5 py-3 dimmer">{empty}</p> : (
        <div className="mt-4 flex flex-col gap-10">
          {byBoard(rows, state.boards).map(({ board, groups, rows: mine }) => (
            <section key={board.id} data-card={board.id} aria-labelledby={`card-${board.id}`}>
              <h3 id={`card-${board.id}`} className="flex min-w-0 items-baseline gap-2 text-[19px] font-extrabold">
                <a href={boardHref(board)} className="min-w-0 break-words hover:underline">{whereOf(state, board).join(' › ')}</a>
                <span className="text-[12px] font-semibold dimmer tnum">{mine.length}</span>
              </h3>
              <TableView boardId={board.id} schema={schemaOf(board)} view readOnly={!access.canEditBoard(board)}
                groups={groups.map(({ group, rows: inGroup }) => ({ ...group, items: inGroup.map((r) => r.item) }))}
                onOpen={(itemId) => setOpen({ boardId: board.id, itemId })}
                rowAction={canPlan ? (item) => <DoToday board={board} item={item} personId={personId} /> : undefined} />
            </section>
          ))}
        </div>
      )}
      {/* A task opens here, read only unless you can edit its board (as on the board and the Calendar). */}
      <ItemDrawer key={open ? `${open.boardId}:${open.itemId}` : 'closed'} boardId={open?.boardId} schema={schemaOf(openBoard) || BOARD_SCHEMAS.projects}
        itemId={openBoard ? open.itemId : null} onClose={() => setOpen(null)} readOnly={!openBoard || !access.canEditBoard(openBoard)} />
    </section>
  );
}
