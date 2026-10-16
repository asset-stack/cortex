import { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, Clock, History } from 'lucide-react';
import { ensuredTodos, useStore, useUsers } from '@/data/store';
import { KpiRow } from '@/components/ui';
import DayNav from '@/components/work/DayNav';
import PersonSwitch from '@/components/work/PersonSwitch';
import TodoList from '@/components/work/TodoList';
import AddTodo from '@/components/work/AddTodo';
import OnBoards from '@/components/work/OnBoards';
import Mentions, { mentionsOf } from '@/components/work/Mentions';
import Tools from '@/components/work/Tools';
import TimesheetModal from '@/components/timesheet/TimesheetModal';
import { useAccess } from '@/lib/access';
import { addDays } from '@/lib/automations';
import { localYmd } from '@/lib/format';
import { dayLabel } from '@/lib/timesheet';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// By start time (timed ones first), then list order.
const byStart = (todos) => todos
  .map((t, position) => ({ t, position }))
  .sort((a, b) => (!a.t.start) - (!b.t.start) || (a.t.start < b.t.start ? -1 : a.t.start > b.t.start ? 1 : 0) || a.position - b.position)
  .map(({ t }) => t);

export default function MyWork() {
  const { state, actions } = useStore();
  const users = useUsers();
  const access = useAccess();
  const today = localYmd();
  const [offset, setOffset] = useState(0); // days from today, so "Today" follows the date past midnight
  const day = addDays(today, offset);
  const [picked, setPicked] = useState('');
  const [logging, setLogging] = useState(false);

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

  const title = offset === 0 ? 'Today' : offset === -1 ? 'Yesterday' : offset === 1 ? 'Tomorrow' : dayLabel(day);

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <h1 className="page-title text-[34px] md:text-[44px] leading-none">{self ? `${greeting()}, ${person?.name}` : person?.name}</h1>
        {self && (
          <button type="button" onClick={() => setLogging(true)} aria-label="Log time" title="Log time"
            className="btn-primary inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-full font-semibold sm:w-auto sm:px-5">
            <Clock className="h-4 w-4" /><span className="hidden sm:inline">Log time</span>
          </button>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <DayNav offset={offset} onChange={setOffset} day={day} />
        {access.isAdmin && <PersonSwitch value={personId} onChange={(id) => setPicked(id === state.me ? '' : id)} />}
      </div>

      <KpiRow items={[
        { value: dayTodos.length, label: offset === 0 ? 'To-dos today' : 'To-dos', tint: '#334155' },
        { value: dayTodos.filter((t) => t.done).length, label: 'Done', tint: '#0f9f6f' },
        { value: carried.length, label: 'Carried over', tint: '#f59e0b' },
        { value: mentions.length, label: 'Mentions', tint: '#579bfc' },
      ]} />

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          {offset === 0 && carried.length > 0 && (
            <TodoList title="Carried over" icon={History} todos={carried} showDay moveTo={{ day: today, label: 'today' }} />
          )}
          <TodoList title={title} icon={CalendarCheck} todos={dayTodos} empty="Nothing planned." rim>
            <AddTodo assignee={personId} day={day} />
          </TodoList>
          <OnBoards personId={personId} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Mentions mentions={mentions} person={person} />
          <Tools key={personId} person={person} />
        </div>
      </div>

      <TimesheetModal open={logging} onClose={() => setLogging(false)} day={day} />
    </div>
  );
}
