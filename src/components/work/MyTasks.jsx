import { useState } from 'react';
import { Check, ChevronDown, Flag, Inbox, Plus } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { PRIORITY, PRIORITY_HINTS, STATUS } from '@/data/boards';
import { LabelPicker } from '@/components/ui';
import { useAccess } from '@/lib/access';
import { boardHref, firstName } from '@/lib/boards';
import { MAX_IN_PROGRESS, MAX_URGENT, byStage, hasPriority, stageOf, todoForItem, whereOf } from '@/lib/work';
import { ago, localYmd, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const ACTION = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold';
const SMALL = '!h-[24px] !px-2 !text-[11.5px]';

// After a pick (or Accept) moves a row to another section, its controls are new elements: put focus back on `target`
// there (a picker's button, or the task's link), else on the section's toggle when it went into a closed one; nowhere
// when it's done and gone.
const refocus = (itemId, target, stage) => requestAnimationFrame(() => {
  const row = `li[data-task="${CSS.escape(itemId)}"]`;
  (document.querySelector(`${row} ${target}`) || (stage && document.querySelector(`button[data-stage="${CSS.escape(stage)}"]`)))?.focus();
});
const PICK = (which) => `[data-pick="${which}"] button`;

/** One task: priority, name, where it lives (and who handed it over), status, due, and Accept or Do today. Priority and
 *  status are pickers for those who can edit its board. */
function TaskRow({ row, personId, waiting, act }) {
  const { state, actions } = useStore();
  const users = useUsers();
  const access = useAccess();
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
  const prioritised = hasPriority(board); // Work in Progress rows have no priority
  const setPriority = (v) => {
    if (v === priority) return;
    actions.updateItem(board.id, item.id, { values: { priority: v } });
    refocus(item.id, PICK('priority'), stageOf({ item, priority: v }));
  };
  // Picking the status it already has changes nothing (it would otherwise count as starting, i.e. accepting, it).
  const setStatus = (v) => {
    if (v === status) return;
    actions.updateItem(board.id, item.id, { values: { status: v }, done: v === 'Done' });
    if (v !== 'Done') refocus(item.id, PICK('status'), stageOf({ item: { ...item, values: { ...item.values, status: v } }, priority }));
  };
  return (
    <li data-task={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t rowline py-2.5 pl-5 pr-4 sm:flex-nowrap">
      <span data-pick="priority" className="w-[68px] shrink-0">
        {editable && prioritised ? (
          <LabelPicker label={`Priority for ${name}`} value={priority} options={PRIORITY} hints={PRIORITY_HINTS} placeholder="Set" onChange={setPriority}
            className={cn(SMALL, !priority && 'dimmer')} />
        ) : (
          <span className={cn('pill w-full', SMALL, !priority && 'pill-empty dimmer')} style={priority ? { backgroundColor: PRIORITY[priority] } : undefined}
            title={PRIORITY_HINTS[priority]}>
            <span className="sr-only">Priority: </span>{priority || 'None'}
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1 basis-[calc(100%-80px)] sm:basis-auto">
        <a id={`task-${item.id}`} href={boardHref(board, item.id)} className="break-words font-semibold hover:underline">{name}</a>
        <div className="mt-0.5 truncate text-[12.5px] dimmer" title={where}>
          {waiting && from && <span className="text-amber-200">From {firstName(users[from]?.name)} · {ago(item.values.assignedAt)} · </span>}
          {where}
        </div>
      </div>
      <span data-pick="status" className="hidden w-[104px] shrink-0 md:block">
        {editable ? (
          <LabelPicker label={`Status for ${name}`} value={status} options={STATUS} allowEmpty={false} onChange={setStatus} className={SMALL} />
        ) : (
          <span className={cn('pill', SMALL)} style={{ backgroundColor: STATUS[status] || STATUS['Not started'] }}>{status}</span>
        )}
      </span>
      <span className={cn('ml-auto min-w-[52px] shrink-0 whitespace-nowrap text-right text-[12.5px] tnum sm:ml-0', overdue ? 'font-semibold text-rose-300' : 'dim')}>
        {shortDate(due)}{overdue && <span className="sr-only"> (overdue)</span>}
      </span>
      {canAccept && (
        // Accepted, it moves to My tasks: focus follows it there rather than falling to the page.
        <button type="button" aria-label={`Accept ${name}`} className={cn(ACTION, 'btn-primary')}
          onClick={() => { if (actions.acceptItem(board.id, item.id)) refocus(item.id, `#${CSS.escape(`task-${item.id}`)}`, stageOf(row)); }}>
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
}

/**
 * Board tasks for someone (rows from src/lib/work.js prioritiesFor): **Waiting on you** (`waiting`: handed to them, not
 * yet accepted, one flat list; their owner accepts) or **My tasks** (the rest, in sections by stage: Stuck, In progress,
 * Up next, No priority, closed at first; each Urgent first, then due date). Do today puts one on their day, for them or
 * an admin. `personId`: whose; `act`: show the actions (their own Dashboard, or an admin's look at it); `title`: the
 * heading. `load` (workload()) adds the team-rule note to My tasks.
 */
export default function MyTasks({ rows, personId, waiting = false, act = false, title, load, empty }) {
  const [closed, setClosed] = useState(() => new Set(['No priority']));
  const notes = load ? [
    load.urgent > MAX_URGENT && `${load.urgent} Urgent: one at a time. Move the rest to High.`,
    load.inProgress > MAX_IN_PROGRESS && `${load.inProgress} In progress: finish or pause one (${MAX_IN_PROGRESS} at a time).`,
  ].filter(Boolean) : [];
  const Icon = waiting ? Inbox : Flag;
  const heading = title || (waiting ? 'Waiting on you' : 'My tasks');
  const toggle = (stage) => setClosed((s) => { const n = new Set(s); if (n.has(stage)) n.delete(stage); else n.add(stage); return n; });
  const row = (r) => <TaskRow key={r.item.id} row={r} personId={personId} waiting={waiting} act={act} />;

  return (
    <section aria-label={heading} className={cn('glass rounded-[24px]', waiting && 'glass-rim ring-1 ring-amber-300/40')}>
      <h2 className="flex items-center gap-2 px-5 pb-3 pt-4 font-extrabold text-[16px]">
        <Icon className="h-4 w-4" aria-hidden="true" />{heading}<span className="text-[12px] font-semibold dimmer tnum">{rows.length}</span>
      </h2>
      {notes.length > 0 && (
        <p className="mx-5 mb-3 rounded-2xl bg-amber-500/20 px-3 py-2 text-[13px] text-amber-100">{notes.join(' ')}</p>
      )}
      {rows.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">{empty || 'Nothing assigned.'}</p>
        : waiting ? <ol className="min-w-0">{rows.map(row)}</ol> : byStage(rows).map(({ stage, rows: list }) => {
          const open = !closed.has(stage);
          const id = `${heading}-${stage}`.replace(/\W+/g, '-');
          return (
            <div key={stage} className="border-t rowline">
              <h3>
                <button type="button" data-stage={stage} onClick={() => toggle(stage)} aria-expanded={open} aria-controls={id}
                  className="flex w-full items-center gap-2 px-5 py-2 text-left text-[13px] font-bold dim hover:text-white">
                  <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', !open && '-rotate-90')} aria-hidden="true" />
                  {stage}<span className="text-[12px] font-semibold dimmer tnum">{list.length}</span>
                </button>
              </h3>
              <ol id={id} hidden={!open} className="min-w-0">{open && list.map(row)}</ol>
            </div>
          );
        })}
    </section>
  );
}
