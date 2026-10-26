import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Flag, GripVertical, Inbox, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { PRIORITY, PRIORITY_HINTS, STATUS, hasDates, schemaOf } from '@/data/boards';
import { InlineRename, LabelPicker, Popover } from '@/components/ui';
import useTaskDrag from '@/components/board/useTaskDrag';
import { useAccess } from '@/lib/access';
import { DEPARTMENTS, MODULE_LABELS, boardHref, firstName, stepPlace } from '@/lib/boards';
import { MAX_IN_PROGRESS, MAX_URGENT, byBoard, dueKey, hasPriority, todoForItem, whereOf } from '@/lib/work';
import { ago, localYmd, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const ACTION = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold';
const SMALL = '!h-[24px] !px-2 !text-[11.5px]';
const ICON = 'grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white';
const MENU_ITEM = 'flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent';
const LINE_ABOVE = 'shadow-[inset_0_2px_0_0_#5fd4ff]';
const LINE_BELOW = 'shadow-[inset_0_-2px_0_0_#5fd4ff]';

// Once a row has moved (Move up/down, Accept) its controls are new elements: focus `target` in it on the next frame,
// else `fallback` (a selector), so focus never falls to the page.
const refocus = (itemId, target, fallback) => requestAnimationFrame(() => {
  (document.querySelector(`li[data-task="${CSS.escape(itemId)}"] ${target}`) || (fallback && document.querySelector(fallback)))?.focus();
});

/**
 * One task: priority, name, a line saying whose it is (Also on) or where it lives, status, due, and Accept or Do today.
 * Priority, status, due and its name are edited right here for those who can edit its board, and the ⋯ menu moves it
 * up or down (the board's order, for everyone; desktop also drags it by its handle). In a board card (`dnd`, `place`)
 * the board is the card's heading; in Waiting on you the line says where it lives and who handed it over.
 */
function TaskRow({ row, personId, waiting, act, dnd, place }) {
  const { state, actions } = useStore();
  const users = useUsers();
  const access = useAccess();
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(null); // the ⋯ button, while its menu is open
  const { item, board, priority, due, overdue, from } = row;
  const today = localYmd();
  const self = personId === state.me;
  const editable = access.canEditBoard(board);
  const status = item.values.status || 'Not started';
  const name = item.name.trim() || 'Untitled task';
  const where = whereOf(state, board, item).join(' › ');
  const onToday = !waiting && todoForItem(state.todos, item.id, personId, today);
  const canAccept = waiting && act && self && editable;
  const canPlan = !waiting && act && (self || access.isAdmin);
  const prioritised = hasPriority(board); // Work in Progress rows have no priority, nor a due date
  const dated = hasDates(schemaOf(board));
  const key = dueKey(board);
  const moves = !waiting && editable && place; // in a board card, for its editors
  const update = (values, extra = {}) => actions.updateItem(board.id, item.id, { values, ...extra });
  // Picking the status it already has changes nothing (it would otherwise count as starting, i.e. accepting, it). Done,
  // it leaves the list: focus goes to the next task's status (else the one before, the card's heading, the list's).
  const setStatus = (v) => {
    if (v === status) return;
    let next = null;
    if (v === 'Done') {
      const card = document.querySelector(`li[data-task="${CSS.escape(item.id)}"]`)?.closest('[data-card]');
      const lis = card ? [...card.querySelectorAll('li[data-task]')] : [];
      const k = lis.findIndex((li) => li.dataset.task === item.id);
      next = (lis[k + 1] || lis[k - 1])?.dataset.task || null;
    }
    update({ status: v }, { done: v === 'Done' });
    // In Waiting on you, starting it accepts it: it moves to its board's card, and focus goes with it.
    if (v !== 'Done' && waiting) refocus(item.id, '[data-pick="status"] button', '[data-mytasks] h2');
    if (v === 'Done') {
      requestAnimationFrame(() => {
        (next && document.querySelector(`li[data-task="${CSS.escape(next)}"] [data-pick="status"] button`)
          || document.querySelector(`#card-${CSS.escape(board.id)} a`) || document.querySelector('[data-mytasks] h2'))?.focus();
      });
    }
  };
  const ownerName = firstName(users[row.owner]?.name);
  const line = [
    waiting && from && <span key="from" className="text-amber-200">From {firstName(users[from]?.name)} · {ago(item.values.assignedAt)}</span>,
    waiting && <span key="where">{where}</span>,
    !waiting && row.also && <span key="also" className="text-sky-200">{row.owner ? `${ownerName}’s` : 'No owner'}</span>,
    !waiting && DEPARTMENTS[item.values.department] && (
      <span key="dept" className="pill !h-[18px] !px-1.5 !text-[10.5px] align-middle" style={{ backgroundColor: DEPARTMENTS[item.values.department] }}>
        <span className="sr-only">Department: </span>{MODULE_LABELS[item.values.department]}
      </span>
    ),
    !waiting && row.client && <span key="client">{row.client.name}</span>,
  ].filter(Boolean);

  return (
    <li data-task={item.id} {...(moves ? dnd.row(place.group, place.ids, item.id) : {})}
      className={cn('task-row group/row relative flex flex-wrap items-center gap-x-3 gap-y-2 border-t rowline py-2.5 pl-5 pr-3',
        dnd?.drag === item.id && 'opacity-50', dnd?.over?.row === item.id && (dnd.over.place === 'before' ? LINE_ABOVE : LINE_BELOW))}>
      {moves && !renaming && (
        <span {...dnd.handle(item.id)} aria-hidden="true" title="Drag to move"
          className="absolute left-0.5 top-1/2 hidden -translate-y-1/2 cursor-grab rounded-md p-0.5 dimmer hover:text-white active:cursor-grabbing md:block md:opacity-0 md:group-hover/row:opacity-100">
          <GripVertical className="h-4 w-4" />
        </span>
      )}
      {prioritised && (
        <span data-pick="priority" className="w-[68px] shrink-0">
          {editable ? (
            <LabelPicker label={`Priority for ${name}`} value={priority} options={PRIORITY} hints={PRIORITY_HINTS} placeholder="Set"
              onChange={(v) => { if (v !== priority) update({ priority: v }); }} className={cn(SMALL, !priority && 'dimmer')} />
          ) : (
            <span className={cn('pill w-full', SMALL, !priority && 'pill-empty dimmer')} style={priority ? { backgroundColor: PRIORITY[priority] } : undefined}
              title={PRIORITY_HINTS[priority]}>
              <span className="sr-only">Priority: </span>{priority || 'None'}
            </span>
          )}
        </span>
      )}
      <div className={cn('task-name min-w-0 flex-1', prioritised ? 'basis-[calc(100%-80px)]' : 'basis-full')}>
        {renaming ? (
          <InlineRename value={item.name} label="Task name" className="!py-1 !px-2 font-semibold"
            onSave={(v) => actions.updateItem(board.id, item.id, { name: v })}
            onDone={(byKey) => { setRenaming(false); if (byKey) refocus(item.id, `#${CSS.escape(`task-${item.id}`)}`); }} />
        ) : (
          <a id={`task-${item.id}`} href={boardHref(board, item.id)} className="break-words font-semibold hover:underline">{name}</a>
        )}
        {line.length > 0 && (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] dimmer" title={waiting ? where : undefined}>
            {line.flatMap((el, k) => (k ? [<span key={`dot${k}`} aria-hidden="true">·</span>, el] : [el]))}
          </div>
        )}
      </div>
      <span data-pick="status" className="w-[104px] shrink-0">
        {editable ? (
          <LabelPicker label={`Status for ${name}`} value={status} options={STATUS} allowEmpty={false} onChange={setStatus} className={SMALL} />
        ) : (
          <span className={cn('pill', SMALL)} style={{ backgroundColor: STATUS[status] || STATUS['Not started'] }}>{status}</span>
        )}
      </span>
      {dated && (editable && !waiting ? (
        <label className={cn('task-push relative ml-auto inline-block min-w-[52px] shrink-0 cursor-pointer whitespace-nowrap rounded-[10px] px-1 text-right text-[12.5px] tnum hover:text-white',
          'has-[:focus-visible]:text-white has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-white',
          overdue ? 'font-semibold text-rose-300' : 'dim')}>
          {shortDate(due)}{overdue && <span className="sr-only"> (overdue)</span>}
          <input type="date" value={item.values[key] || ''} aria-label={`Due date for ${name}`} onChange={(e) => update({ [key]: e.target.value })}
            className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
      ) : (
        <span className={cn('task-push ml-auto min-w-[52px] shrink-0 whitespace-nowrap text-right text-[12.5px] tnum', overdue ? 'font-semibold text-rose-300' : 'dim')}>
          {shortDate(due)}{overdue && <span className="sr-only"> (overdue)</span>}
        </span>
      ))}
      {canAccept && (
        // Accepted, it moves to its board's card: focus follows it there rather than falling to the page.
        <button type="button" aria-label={`Accept ${name}`} className={cn(ACTION, 'btn-primary')}
          onClick={() => { if (actions.acceptItem(board.id, item.id)) refocus(item.id, `#${CSS.escape(`task-${item.id}`)}`, '[data-mytasks] h2'); }}>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />Accept
        </button>
      )}
      {canPlan && (
        // One button either way, so focus stays on it once the task is on today.
        <button type="button" aria-disabled={onToday ? 'true' : undefined} aria-label={onToday ? `${name} is on today` : `Do ${name} today`}
          onClick={() => { if (!onToday) actions.addTodoForItem(board.id, item.id, { assignee: personId }); }}
          className={cn(ACTION, 'chip', !dated && 'task-push ml-auto', onToday ? 'cursor-default dimmer' : 'hover:bg-white/15')}>
          {onToday ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          {onToday ? 'On today' : 'Do today'}
        </button>
      )}
      {moves && (
        <span data-pick="menu" className="shrink-0">
          <button type="button" onClick={(e) => setMenu(menu ? null : e.currentTarget)} aria-label={`Options for ${name}`} title="Task options"
            aria-haspopup="true" aria-expanded={Boolean(menu)} className={ICON}>
            <MoreHorizontal className="h-4 w-4" />
          </button>
          <Popover anchor={menu} open={Boolean(menu)} onClose={() => setMenu(null)} width={170} align="right">
            <div className="flex flex-col">
              <button type="button" className={MENU_ITEM} onClick={() => { setMenu(null); setRenaming(true); }}>
                <Pencil className="h-4 w-4 dim" aria-hidden="true" />Rename
              </button>
              <button type="button" className={MENU_ITEM} disabled={place.first} onClick={() => { setMenu(null); place.move(item.id, -1); }}>
                <ArrowUp className="h-4 w-4 dim" aria-hidden="true" />Move up
              </button>
              <button type="button" className={MENU_ITEM} disabled={place.last} onClick={() => { setMenu(null); place.move(item.id, 1); }}>
                <ArrowDown className="h-4 w-4 dim" aria-hidden="true" />Move down
              </button>
            </div>
          </Popover>
        </span>
      )}
    </li>
  );
}

/** A board's card: its department and name (linked to the board), then the person's tasks there in the board's order,
 *  under their group's name when they're in more than one. Its editors drag them (desktop) or move them with ⋯. */
function BoardCard({ card, personId, act }) {
  const { state, actions } = useStore();
  const access = useAccess();
  const [moved, setMoved] = useState({ n: 0, said: '' }); // a new node per move, so each one is announced
  const { board, groups } = card;
  const editable = access.canEditBoard(board);
  const dnd = useTaskDrag({ boardId: board.id, groups: board.groups, readOnly: !editable });
  const shown = groups.flatMap(({ group, rows }) => rows.map((r) => ({ id: r.item.id, group: group.id })));
  const move = (itemId, dir) => {
    const to = stepPlace(board.groups, itemId, shown, dir);
    if (!to || actions.placeItem(board.id, itemId, to.groupId, to.beforeId) === false) return;
    setMoved((m) => ({ n: m.n + 1, said: dir < 0 ? 'Moved up' : 'Moved down' }));
    refocus(itemId, '[data-pick="menu"] button', `#card-${CSS.escape(board.id)} a`);
  };
  const title = whereOf(state, board).join(' › ');
  return (
    <section data-card={board.id} aria-labelledby={`card-${board.id}`} onDragLeave={dnd.leave} onDragOver={dnd.quiet}>
      <h3 id={`card-${board.id}`} className="flex min-w-0 items-baseline gap-2 text-[17px] font-extrabold">
        <a href={boardHref(board)} className="min-w-0 break-words hover:underline">{title}</a>
        <span className="text-[12px] font-semibold dimmer tnum">{card.rows.length}</span>
      </h3>
      <div className="mt-3 overflow-hidden rounded-[24px] glass">
        {groups.map(({ group, rows }, gi) => {
          const ids = rows.map((r) => r.item.id);
          return (
            <div key={group.id} {...dnd.end(group.id, ids)} className={cn(gi > 0 && 'border-t rowline', dnd.endHere(group.id) && 'drag-over')}>
              {groups.length > 1 && (
                <h4 {...dnd.top(group.id, ids)} className={cn('flex items-center gap-2 px-5 pb-1 pt-3 text-[12.5px] font-bold', dnd.over?.group === group.id && dnd.over.top && LINE_BELOW)}
                  style={{ color: group.color }}>
                  {group.name}<span className="font-semibold dimmer tnum">{rows.length}</span>
                </h4>
              )}
              <ol className="min-w-0 [&>li:first-child]:border-t-0">
                {rows.map((r) => {
                  const at = shown.findIndex((x) => x.id === r.item.id);
                  return (
                    <TaskRow key={r.item.id} row={r} personId={personId} act={act} dnd={dnd}
                      place={{ group: group.id, ids, first: at === 0, last: at === shown.length - 1, move }} />
                  );
                })}
              </ol>
            </div>
          );
        })}
      </div>
      <span aria-live="polite" className="sr-only">{moved.said && <span key={moved.n}>{moved.said}</span>}</span>
    </section>
  );
}

/**
 * Board tasks for someone (rows from src/lib/work.js prioritiesFor): **Waiting on you** (`waiting`: handed to them, not
 * yet accepted, one list; their owner accepts) or **My tasks** (the rest, a card per board in the board's own order,
 * docs/PHASE2.md §20: with the ones they're Also on, marked with whose they are). Do today puts one on their day, for
 * them or an admin. `personId`: whose; `act`: show the actions (their own Dashboard, or an admin's look at it); `title`:
 * the heading. `load` (workload()) adds the team-rule note to My tasks.
 */
export default function MyTasks({ rows, personId, waiting = false, act = false, title, load, empty }) {
  const { state } = useStore();
  const notes = load ? [
    load.urgent > MAX_URGENT && `${load.urgent} Urgent: one at a time. Move the rest to High.`,
    load.inProgress > MAX_IN_PROGRESS && `${load.inProgress} In progress: finish or pause one (${MAX_IN_PROGRESS} at a time).`,
  ].filter(Boolean) : [];
  const Icon = waiting ? Inbox : Flag;
  const heading = title || (waiting ? 'Waiting on you' : 'My tasks');
  const head = (
    <h2 tabIndex={-1} className={cn('flex items-center gap-2 font-extrabold text-[16px] outline-none', waiting && 'px-5 pb-3 pt-4')}>
      <Icon className="h-4 w-4" aria-hidden="true" />{heading}<span className="text-[12px] font-semibold dimmer tnum">{rows.length}</span>
    </h2>
  );

  if (waiting) {
    return (
      <section aria-label={heading} className="task-cards glass glass-rim rounded-[24px] ring-1 ring-amber-300/40">
        {head}
        {rows.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">{empty || 'Nothing assigned.'}</p>
          : <ol className="min-w-0">{rows.map((r) => <TaskRow key={r.item.id} row={r} personId={personId} waiting act={act} />)}</ol>}
      </section>
    );
  }
  return (
    <section aria-label={heading} data-mytasks="" className="task-cards">
      {head}
      {notes.length > 0 && (
        <p className="mt-3 rounded-2xl bg-amber-500/20 px-3 py-2 text-[13px] text-amber-100">{notes.join(' ')}</p>
      )}
      {rows.length === 0 ? <p className="mt-3 rounded-[24px] glass px-5 py-3 dimmer">{empty || 'Nothing assigned.'}</p> : (
        <div className="mt-4 flex flex-col gap-8">
          {byBoard(rows, state.boards).map((card) => <BoardCard key={card.board.id} card={card} personId={personId} act={act} />)}
        </div>
      )}
    </section>
  );
}
