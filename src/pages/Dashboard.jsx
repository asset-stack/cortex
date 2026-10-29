import { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, Clock, History, Plus } from 'lucide-react';
import { ensuredTodos, useStore, useUsers } from '@/data/store';
import { KpiRow } from '@/components/ui';
import Board from '@/components/board/Board';
import NewTaskModal from '@/components/board/NewTaskModal';
import DayNav from '@/components/work/DayNav';
import PersonSwitch from '@/components/work/PersonSwitch';
import TodoList from '@/components/work/TodoList';
import AddTodo from '@/components/work/AddTodo';
import MyTasks from '@/components/work/MyTasks';
import NeedsAttention from '@/components/work/NeedsAttention';
import MyDeals from '@/components/work/MyDeals';
import Mentions, { mentionsOf } from '@/components/work/Mentions';
import Tools from '@/components/work/Tools';
import TimesheetModal from '@/components/timesheet/TimesheetModal';
import { useAccess } from '@/lib/access';
import { addDays } from '@/lib/automations';
import { personalBoard } from '@/lib/boards';
import { localYmd } from '@/lib/format';
import { dayLabel } from '@/lib/timesheet';
import { prioritiesFor, workload } from '@/lib/work';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// By start time (timed ones first), then list order.
const byStart = (todos) => todos
  .map((t, position) => ({ t, position }))
  .sort((a, b) => (!a.t.start) - (!b.t.start) || (a.t.start < b.t.start ? -1 : a.t.start > b.t.start ? 1 : 0) || a.position - b.position)
  .map(({ t }) => t);

/**
 * The Dashboard (docs/PHASE2.md §18, §20; was My Work): someone's master task list (Waiting on you, the day's to-dos, My
 * tasks: a card per board, in its order, with the tasks they're also on) and their notes (their own page), with Needs
 * attention (admins), Mentions and Tools beside it. Admins look at anyone's.
 */
export default function Dashboard() {
  const { state, actions } = useStore();
  const users = useUsers();
  const access = useAccess();
  const today = localYmd();
  const [offset, setOffset] = useState(0); // days from today, so "Today" follows the date past midnight
  const day = addDays(today, offset);
  const [picked, setPicked] = useState('');
  const [logging, setLogging] = useState(false);
  const [adding, setAdding] = useState(false);

  // Routine to-dos (and an admin's Monday bank reminder) are made once per signed-in person and day.
  useEffect(() => {
    const key = `${state.me}|${today}`;
    if (!state.me || ensuredTodos.has(key)) return;
    ensuredTodos.add(key);
    actions.ensureTodos(today).then((r) => { if (r === false) ensuredTodos.delete(key); });
  }, [state.me, today, actions]);

  useEffect(() => { setPicked(''); }, [state.me]); // back to your own list when the signed-in person changes (demo switcher)

  // Admins can look at anyone's list; everyone else sees their own.
  const personId = access.isAdmin && users[picked] ? picked : state.me;
  const person = users[personId];
  const self = personId === state.me;

  const mine = useMemo(() => state.todos.filter((t) => t.assignee === personId), [state.todos, personId]);
  const dayTodos = useMemo(() => byStart(mine.filter((t) => t.day === day)), [mine, day]);
  const carried = useMemo(() => mine.filter((t) => !t.done && t.day < today)
    .map((t, position) => ({ t, position }))
    .sort((a, b) => (a.t.day < b.t.day ? -1 : a.t.day > b.t.day ? 1 : 0) || a.position - b.position)
    .map(({ t }) => t), [mine, today]);
  const mentions = useMemo(() => mentionsOf(state, person), [state, person]);
  const rows = useMemo(() => prioritiesFor(state, personId, { today }), [state, personId, today]);
  const load = workload(rows);
  const notes = personalBoard(state, personId);
  const showNotes = notes && access.canViewBoard(notes);

  const title = offset === 0 ? 'Today' : offset === -1 ? 'Yesterday' : offset === 1 ? 'Tomorrow' : dayLabel(day);

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <h1 className="page-title text-[34px] md:text-[44px] leading-none">{self ? `${greeting()}, ${person?.name}` : person?.name}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {self && (
            <button type="button" onClick={() => setLogging(true)} aria-label="Log time" title="Log time"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-full chip font-semibold sm:w-auto sm:px-5">
              <Clock className="h-4 w-4" /><span className="hidden sm:inline">Log time</span>
            </button>
          )}
          <button type="button" onClick={() => setAdding(true)} aria-label="New task" title="New task"
            className="btn-primary inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-full font-semibold sm:w-auto sm:px-5">
            <Plus className="h-4 w-4" /><span className="hidden sm:inline">New task</span>
          </button>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <DayNav offset={offset} onChange={setOffset} day={day} />
        {access.isAdmin && <PersonSwitch value={personId} onChange={(id) => setPicked(id === state.me ? '' : id)} />}
      </div>

      <KpiRow items={[
        { value: load.waiting, label: 'Waiting on you', tint: '#f59e0b' },
        { value: load.urgent, label: 'Urgent', tint: '#e2445c' },
        { value: load.overdue, label: 'Overdue', tint: '#7c3aed' },
        { value: dayTodos.length, label: offset === 0 ? 'To-dos today' : 'To-dos', tint: '#334155' },
      ]} />

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          {load.waiting > 0 && <MyTasks rows={rows.filter((r) => r.waiting)} personId={personId} waiting act title={self ? 'Waiting on you' : `Waiting on ${person?.name}`} />}
          {offset === 0 && carried.length > 0 && (
            <TodoList title="Carried over" icon={History} todos={carried} showDay moveTo={{ day: today, label: 'today' }} />
          )}
          <TodoList title={title} icon={CalendarCheck} todos={dayTodos} empty="Nothing planned." rim>
            <AddTodo assignee={personId} day={day} />
          </TodoList>
          {/* Their notes page is below as My notes, so it has no card of its own here. */}
          <MyTasks rows={rows.filter((r) => !r.waiting && !(showNotes && r.board.id === notes.id))} personId={personId} act load={load}
            title={self ? 'My tasks' : `${person?.name}’s tasks`}
            empty={self ? 'Nothing assigned to you.' : 'Nothing assigned.'} />
          {showNotes && <section aria-label={self ? 'My notes' : `${person?.name}’s notes`} className="mt-4"><Board key={notes.id} board={notes} embedded title={self ? 'My notes' : `${person?.name}’s notes`} /></section>}
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <MyDeals personId={personId} />
          {access.isAdmin && <NeedsAttention />}
          <Mentions mentions={mentions} person={person} />
          <Tools key={personId} person={person} />
        </div>
      </div>

      <TimesheetModal open={logging} onClose={() => setLogging(false)} day={day} />
      {adding && <NewTaskModal onClose={() => setAdding(false)} owner={self ? '' : personId} />}
    </div>
  );
}
