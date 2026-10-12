import { ArrowDownToLine, Repeat, Trash2, Zap } from 'lucide-react';
import { useStore } from '@/data/store';
import { CATEGORIES } from '@/data/boards';
import { LabelPicker } from '@/components/ui';
import { useAccess } from '@/lib/access';
import { formatMinutes } from '@/lib/timesheet';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const SOURCES = {
  routine: { icon: Repeat, label: 'Routine' },
  automation: { icon: Zap, label: 'Automation' },
};

function SourceIcon({ source }) {
  const s = SOURCES[source];
  if (!s) return null;
  const Icon = s.icon;
  return <span role="img" aria-label={s.label} title={s.label} className="inline-grid shrink-0 dimmer"><Icon className="h-3.5 w-3.5" aria-hidden="true" /></span>;
}

// Keeps the time / category / minutes columns lined up on wide screens when a row has no move or delete button.
const ButtonSlot = () => <span className="hidden h-7 w-7 shrink-0 sm:block" aria-hidden="true" />;

/** One to-do: checkbox, title, source, time, category, minutes, and move / delete where allowed. */
function TodoRow({ todo: t, showDay, moveTo }) {
  const { state, actions } = useStore();
  const { isAdmin } = useAccess();
  const mine = t.assignee === state.me || isAdmin; // tick, recategorise, move (the store checks the same)
  const removable = isAdmin || t.createdBy === state.me;
  // Not onto a day that already has this routine's (or this automation's) to-do: the database keeps one.
  const movable = moveTo && mine && !state.todos.some((x) => x.id !== t.id && x.assignee === t.assignee && x.day === moveTo.day
    && ((t.routineId && x.routineId === t.routineId) || (t.source === 'automation' && x.source === 'automation' && x.ref === t.ref)));
  const title = t.title.trim() || 'Untitled';
  return (
    <li className="flex items-start gap-3 border-t rowline px-5 py-3">
      <input type="checkbox" checked={t.done} disabled={!mine} onChange={() => actions.toggleTodo(t.id)} aria-label={`Mark ${title} done`}
        className="mt-[3px] h-4 w-4 shrink-0 accent-[#5fd4ff] disabled:opacity-50" />
      <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className={cn('flex items-center gap-1.5 font-semibold', t.done && 'line-through opacity-60')}>
            <span className="min-w-0 break-words">{title}</span>
            <SourceIcon source={t.source} />
          </div>
          {t.notes && <p className="mt-0.5 line-clamp-2 text-[12.5px] dimmer">{t.notes}</p>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] sm:mt-0 sm:flex-nowrap">
          {showDay && <span className="whitespace-nowrap dimmer tnum">{shortDate(t.day)}</span>}
          {t.start && <span className="dim tnum">{t.start}</span>}
          <div className="sm:w-[128px]">
            <LabelPicker label={`Category for ${title}`} value={t.category} options={CATEGORIES} allowEmpty={false} readOnly={!mine}
              onChange={(category) => actions.updateTodo(t.id, { category })} />
          </div>
          <span className="whitespace-nowrap dim tnum sm:w-12 sm:text-right">{formatMinutes(t.minutes)}</span>
        </div>
      </div>
      {movable ? (
        <button type="button" onClick={() => actions.moveTodo(t.id, moveTo.day)} aria-label={`Move ${title} to ${moveTo.label}`} title={`Move to ${moveTo.label}`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><ArrowDownToLine className="h-4 w-4" /></button>
      ) : moveTo && <ButtonSlot />}
      {removable ? (
        <button type="button" onClick={() => actions.deleteTodo(t.id)} aria-label={`Delete ${title}`} title="Delete"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><Trash2 className="h-4 w-4" /></button>
      ) : <ButtonSlot />}
    </li>
  );
}

/** A titled list of to-dos. `moveTo` ({ day, label }) adds a move button (carried-over to-dos). */
export default function TodoList({ title, icon: Icon, todos, empty, showDay, moveTo, rim, children }) {
  return (
    <section aria-label={title} className={cn('glass rounded-[24px]', rim && 'glass-rim')}>
      <h2 className="flex items-center gap-2 px-5 pb-3 pt-4 font-extrabold text-[16px]">
        {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}{title}
        <span className="text-[12px] font-semibold dimmer tnum">{todos.length}</span>
      </h2>
      {todos.length === 0 && empty && <p className="border-t rowline px-5 py-3 dimmer">{empty}</p>}
      {todos.length > 0 && <ul>{todos.map((t) => <TodoRow key={t.id} todo={t} showDay={showDay} moveTo={moveTo} />)}</ul>}
      {children}
    </section>
  );
}
