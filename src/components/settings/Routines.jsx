import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { CATEGORIES } from '@/data/boards';
import { Avatar, LabelPicker } from '@/components/ui';
import { cn } from '@/lib/cn';
import { Switch } from './controls';

// ISO weekdays (1 = Monday), as routines store them.
const WEEKDAYS = [[1, 'M', 'Monday'], [2, 'T', 'Tuesday'], [3, 'W', 'Wednesday'], [4, 'T', 'Thursday'], [5, 'F', 'Friday'], [6, 'S', 'Saturday'], [7, 'S', 'Sunday']];
const WORKDAYS = [1, 2, 3, 4, 5];
const MAX_MINUTES = 600;
const validMinutes = (v) => { const n = Number(v); return String(v).trim() !== '' && Number.isInteger(n) && n > 0 && n <= MAX_MINUTES; };
const minutesBox = 'field flex items-center gap-1 focus-within:border-white/55 focus-within:bg-white/[.14]';

// Keeps its own text so the box can be cleared while typing; only whole minutes are saved.
function MinutesInput({ value, onCommit, label, className }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText((t) => (Number(t) === value && t.trim() !== '' ? t : String(value))); }, [value]);
  return (
    <label className={cn(minutesBox, className)}>
      <input type="number" min={5} max={MAX_MINUTES} step={5} inputMode="numeric" value={text} aria-label={label}
        onChange={(e) => { setText(e.target.value); if (validMinutes(e.target.value)) onCommit(Number(e.target.value)); }}
        onBlur={() => setText(String(value))} className="w-full min-w-0 bg-transparent outline-none tnum" />
      <span className="dimmer" aria-hidden="true">m</span>
    </label>
  );
}

function Weekdays({ value, onChange, title }) {
  return (
    <div role="group" aria-label={`Days for ${title}`} className="inline-flex gap-1">
      {WEEKDAYS.map(([n, short, long]) => {
        const on = value.includes(n);
        return (
          <button key={n} type="button" aria-pressed={on} aria-label={long} title={long}
            onClick={() => onChange(on ? value.filter((x) => x !== n) : [...value, n].sort((a, b) => a - b))}
            className={cn('grid h-8 w-8 place-items-center rounded-full text-[12px] font-semibold', on ? 'chip-on' : 'chip dim')}>{short}</button>
        );
      })}
    </div>
  );
}

/** One routine, edited in place: title, category, minutes, start time, weekdays, active. */
function RoutineRow({ routine: r }) {
  const { actions } = useStore();
  const update = (patch) => actions.updateRoutine(r.id, patch);
  const name = (r.title || '').trim() || 'Untitled';
  return (
    <li className="flex flex-col gap-2 border-t rowline px-4 py-3 sm:px-5">
      <div className="flex items-center gap-2">
        <input value={r.title || ''} onChange={(e) => update({ title: e.target.value })} placeholder="Routine" aria-label="Routine"
          className={cn('field min-w-0 flex-1 font-semibold', r.active === false && 'opacity-60')} />
        <button type="button" onClick={() => actions.deleteRoutine(r.id)} aria-label={`Delete ${name}`} title="Delete"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><Trash2 className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
        <div className="sm:w-[128px]">
          <LabelPicker label={`Category for ${name}`} value={r.category} options={CATEGORIES} allowEmpty={false} onChange={(category) => update({ category })} />
        </div>
        <MinutesInput value={r.minutes} onCommit={(minutes) => update({ minutes })} label={`Minutes for ${name}`} className="sm:!w-[92px]" />
        <input type="time" value={r.start || ''} onChange={(e) => update({ start: e.target.value })} aria-label={`Start time for ${name}`}
          className="field tnum sm:!w-[132px]" />
        <span className="flex items-center justify-end gap-2 text-[12.5px] dim sm:order-last sm:ml-auto">Active
          <Switch checked={r.active !== false} label={`${name} active`} onChange={(active) => update({ active })} />
        </span>
        <div className="col-span-2">
          <Weekdays value={r.weekdays || []} onChange={(weekdays) => update({ weekdays })} title={name} />
        </div>
      </div>
    </li>
  );
}

/** Inline add for one person: title, category, minutes and an optional time; weekdays start Monday to Friday. */
function AddRoutine({ assignee, name }) {
  const { actions } = useStore();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Other');
  const [minutes, setMinutes] = useState('30');
  const [start, setStart] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    const id = actions.addRoutine({
      assignee, title: title.trim(), category, minutes: validMinutes(minutes) ? Number(minutes) : 30, start, weekdays: WORKDAYS, active: true,
    });
    if (id !== false) { setTitle(''); setStart(''); }
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-t rowline px-4 py-3 sm:px-5">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a routine" aria-label={`New routine for ${name}`}
        className="field min-w-0 flex-1 basis-full sm:basis-[220px]" />
      <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="field !w-auto">
        {Object.keys(CATEGORIES).map((c) => <option key={c}>{c}</option>)}
      </select>
      <label className={cn(minutesBox, '!w-[92px]')}>
        <input type="number" min={5} max={MAX_MINUTES} step={5} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)}
          aria-label="Minutes" className="w-full min-w-0 bg-transparent outline-none tnum" />
        <span className="dimmer" aria-hidden="true">m</span>
      </label>
      <input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start time" className="field !w-[132px] tnum" />
      <button type="submit" aria-label={`Add routine for ${name}`} title="Add" className="grid h-10 w-10 shrink-0 place-items-center rounded-full chip"><Plus className="h-4 w-4" /></button>
    </form>
  );
}

/** Admins: each person's daily routines (the Dashboard turns them into to-dos on their weekdays). */
export default function Routines() {
  const { state } = useStore();
  const routines = state.routines || [];
  // Active people, plus anyone inactive who still has routines (so they can be cleared).
  const people = state.users.filter((u) => u.active !== false || routines.some((r) => r.assignee === u.id));
  return (
    <div className="flex flex-col gap-5">
      {people.map((u) => {
        const list = routines.filter((r) => r.assignee === u.id);
        const active = u.active !== false;
        return (
          <section key={u.id} aria-label={u.name} className="glass glass-rim rounded-[24px]">
            <h2 className={cn('flex items-center gap-2.5 px-4 pb-3 pt-4 font-extrabold text-[16px] sm:px-5', !active && 'opacity-60')}>
              <Avatar userId={u.id} size={28} ring={false} />
              <span className="min-w-0 truncate">{u.name}</span>
              <span className="text-[12px] font-semibold dimmer tnum">{list.length}</span>
            </h2>
            {list.length > 0 && <ul>{list.map((r) => <RoutineRow key={r.id} routine={r} />)}</ul>}
            {active && <AddRoutine assignee={u.id} name={u.name} />}
          </section>
        );
      })}
    </div>
  );
}
