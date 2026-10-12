import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useStore } from '@/data/store';
import { CATEGORIES } from '@/data/boards';

/** Inline add: title, category, minutes and an optional start time, for `assignee` on `day`. */
export default function AddTodo({ assignee, day }) {
  const { actions } = useStore();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Other');
  const [minutes, setMinutes] = useState('30');
  const [start, setStart] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    const id = actions.addTodo({ assignee, day, title: title.trim(), category, minutes: parseInt(minutes, 10) || 30, start });
    if (id !== false) { setTitle(''); setStart(''); }
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-t rowline px-5 py-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a to-do" aria-label="To-do"
        className="field min-w-0 flex-1 basis-full sm:basis-[220px]" />
      <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="field !w-auto">
        {Object.keys(CATEGORIES).map((c) => <option key={c}>{c}</option>)}
      </select>
      <label className="field flex !w-[92px] items-center gap-1 focus-within:border-white/55 focus-within:bg-white/[.14]">
        <input type="number" min={5} max={600} step={5} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)}
          aria-label="Minutes" className="w-full min-w-0 bg-transparent outline-none tnum" />
        <span className="dimmer" aria-hidden="true">m</span>
      </label>
      <input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start time" className="field !w-[116px] tnum" />
      <button type="submit" aria-label="Add to-do" title="Add" className="grid h-10 w-10 shrink-0 place-items-center rounded-full chip"><Plus className="h-4 w-4" /></button>
    </form>
  );
}
