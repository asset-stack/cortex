import { useMemo, useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
import { useStore } from '@/data/store';
import { PRIORITY } from '@/data/boards';
import { Avatar, PageHeader } from '@/components/ui';
import NewTaskModal from '@/components/board/NewTaskModal';
import MyTasks from '@/components/work/MyTasks';
import { boardHref } from '@/lib/boards';
import { localClock, localYmd } from '@/lib/format';
import { byStage, prioritiesFor, workload } from '@/lib/work';
import { cn } from '@/lib/cn';

const COUNTS = [
  { key: 'waiting', label: 'Waiting', tint: 'text-amber-200' },
  { key: 'urgent', label: 'Urgent', tint: 'text-rose-300' },
  { key: 'inProgress', label: 'In progress', tint: '' },
  { key: 'overdue', label: 'Overdue', tint: 'text-rose-300' },
  { key: 'open', label: 'Open', tint: '' },
];

// Someone's tasks on the team boards (never their notes), as the viewer may see them.
const useRows = (personId) => {
  const { state } = useStore();
  const today = localYmd();
  return useMemo(() => prioritiesFor(state, personId, { today, teamOnly: true }), [state, personId, today]);
};

/** One person's card on the Team page: their numbers and top three tasks. */
function PersonCard({ user }) {
  const rows = useRows(user.id);
  const load = workload(rows);
  const href = `#/team/${encodeURIComponent(user.id)}`;
  // Top three by stage: what's stuck, what they're on, what's next (never the unprioritised backlog).
  const top = byStage(rows).filter((g) => g.stage !== 'No priority').flatMap((g) => g.rows).slice(0, 3);
  return (
    <section aria-label={user.name} className="glass glass-rim flex flex-col rounded-[24px] p-5">
      <a href={href} className="flex items-center gap-3 rounded-2xl hover:underline">
        <Avatar userId={user.id} size={40} ring={false} />
        <span className="min-w-0">
          <span className="block truncate text-[17px] font-extrabold">{user.name}</span>
          {user.timezone && <span className="block truncate text-[12.5px] dimmer">{localClock(user.timezone)}</span>}
        </span>
      </a>
      <dl className="mt-4 grid grid-cols-5 gap-1 text-center">
        {COUNTS.map((c) => (
          <div key={c.key} className="flex flex-col-reverse rounded-xl bg-white/5 px-1 py-2">
            <dt className="mt-1 truncate text-[11px] dimmer">{c.label}</dt>
            <dd className={cn('text-[20px] font-black leading-none tnum', load[c.key] > 0 ? c.tint : 'dimmer')}>{load[c.key]}</dd>
          </div>
        ))}
      </dl>
      <ol className="mt-4 flex flex-col gap-1">
        {top.map(({ item, board, priority }) => (
          <li key={item.id}>
            <a href={boardHref(board, item.id)} className="flex items-center gap-2 rounded-xl px-1.5 py-1 hover:bg-white/10">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PRIORITY[priority] || 'rgba(255,255,255,.2)' }} aria-hidden="true" />
              <span className="min-w-0 truncate">{item.name.trim() || 'Untitled task'}</span>
            </a>
          </li>
        ))}
        {rows.length === 0 && <li className="dimmer">Nothing assigned.</li>}
      </ol>
      {rows.length > 3 && <a href={href} className="mt-2 self-start text-[13px] font-semibold underline underline-offset-2">See all</a>}
    </section>
  );
}

/** One person's page: what waits on them and their tasks, and New task for them. */
function Person({ user }) {
  const { state } = useStore();
  const rows = useRows(user.id);
  const load = workload(rows);
  const [adding, setAdding] = useState(false);
  const self = user.id === state.me;
  return (
    <div>
      <a href="#/team" className="inline-flex items-center gap-1.5 text-[13px] dim hover:text-white"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Team</a>
      <div className="mt-3 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar userId={user.id} size={44} ring={false} />
          <div className="min-w-0">
            <h1 className="page-title truncate text-[34px] md:text-[44px] leading-none">{user.name}</h1>
            {user.timezone && <div className="mt-1 text-[12.5px] dimmer">{localClock(user.timezone)}</div>}
          </div>
        </div>
        <button type="button" onClick={() => setAdding(true)} aria-label={self ? 'New task' : `New task for ${user.name}`} title={self ? 'New task' : `New task for ${user.name}`}
          className="btn-primary inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-full font-semibold sm:w-auto sm:px-5">
          <Plus className="h-4 w-4" /><span className="hidden sm:inline">{self ? 'New task' : `New task for ${user.name.split(' ')[0]}`}</span>
        </button>
      </div>
      <div className="mt-6 flex flex-col gap-6">
        {load.waiting > 0 && <MyTasks rows={rows.filter((r) => r.waiting)} personId={user.id} waiting act={self} title={self ? 'Waiting on you' : `Waiting on ${user.name}`} />}
        <MyTasks rows={rows.filter((r) => !r.waiting)} personId={user.id} act={self} load={load} title={self ? 'My tasks' : 'Tasks'} />
      </div>
      {adding && <NewTaskModal onClose={() => setAdding(false)} owner={user.id} />}
    </div>
  );
}

/**
 * Team (docs/PHASE2.md §18): everyone's work on the team boards, so who has what and what comes first is in one place.
 * #/team: a card per active person; #/team/<id>: that person's tasks. No module of its own: each task keeps its board's
 * access rule for the viewer and the person (src/lib/work.js); personal notes never show here.
 */
export default function Team({ userId = '' }) {
  const { state } = useStore();
  const people = state.users.filter((u) => u.active !== false);
  const user = userId && people.find((u) => u.id === userId);
  if (user) return <Person key={user.id} user={user} />;
  return (
    <div>
      <PageHeader title="Team" />
      <div className="mt-7 grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
        {people.map((u) => <PersonCard key={u.id} user={u} />)}
      </div>
    </div>
  );
}
