import { useState } from 'react';
import { ChevronDown, MessageCircle, Plus } from 'lucide-react';
import { useStore } from '@/data/store';
import { LabelPicker, PersonPicker } from '@/components/ui';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

function StatusBar({ items }) {
  const counts = {};
  items.forEach((i) => { counts[i.values.status] = (counts[i.values.status] || 0) + 1; });
  const colors = { 'Not started': '#9aa3b5', 'In progress': '#fdab3d', Stuck: '#e2445c', Done: '#00c875' };
  if (!items.length) return null;
  return (
    <div className="mx-5 mt-2 flex h-1.5 overflow-hidden rounded-full" aria-hidden="true">
      {Object.entries(counts).map(([s, n]) => <div key={s} style={{ flex: n, background: colors[s] || '#666' }} />)}
    </div>
  );
}

function AddRow({ onAdd, colSpan }) {
  const [v, setV] = useState('');
  return (
    <tr className="border-t rowline">
      <td className="p-3 text-center dimmer"><Plus className="h-4 w-4 inline" /></td>
      <td colSpan={colSpan} className="p-1.5">
        <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onAdd(v.trim()); setV(''); } }}>
          <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Add task" aria-label="Add task"
            className="w-full rounded-lg bg-transparent px-1.5 py-1.5 outline-none focus:bg-white/10" />
        </form>
      </td>
    </tr>
  );
}

export default function TableView({ boardKey, schema, groups, onOpen }) {
  const { actions } = useStore();
  const [collapsed, setCollapsed] = useState({});

  return groups.map((g) => (
    <section key={g.id} className="mt-8">
      <button type="button" className="flex items-center gap-2 text-[17px] font-extrabold" style={{ color: g.color }}
        onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))} aria-expanded={!collapsed[g.id]}>
        <ChevronDown className={cn('h-5 w-5 transition-transform', collapsed[g.id] && '-rotate-90')} />
        {g.name}<span className="text-[12px] font-semibold dimmer">{g.items.length}</span>
      </button>
      {!collapsed[g.id] && (
        <>
          <div className="mt-3 overflow-x-auto scroll-thin rounded-[24px] glass">
            <table className="w-full min-w-[820px] border-collapse text-[13.5px]">
              <thead>
                <tr className="text-[12px] dimmer">
                  <th className="w-12 p-3"><span className="sr-only">Done</span></th>
                  <th className="text-left p-3 font-medium">Task</th>
                  <th className="w-10"><span className="sr-only">Updates</span></th>
                  {schema.columns.map((c) => <th key={c.key} className="p-3 font-medium w-[124px]">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {g.items.map((it) => (
                  <tr key={it.id} className="border-t rowline hover:bg-white/5">
                    <td className="p-3 text-center">
                      <input type="checkbox" checked={it.done} aria-label={`Mark ${it.name} done`}
                        onChange={() => actions.updateItem(boardKey, it.id, { done: !it.done, values: !it.done ? { status: 'Done' } : {} })}
                        className="h-4 w-4 accent-[#5fd4ff]" />
                    </td>
                    <td className="p-3">
                      <button type="button" onClick={() => onOpen(it.id)} className={cn('text-left font-semibold hover:underline', it.done && 'line-through opacity-60')}>{it.name}</button>
                      {it.subtasks.length > 0 && <span className="ml-2 text-[11.5px] dimmer tnum">{it.subtasks.filter((s) => s.done).length}/{it.subtasks.length}</span>}
                    </td>
                    <td className="text-center">
                      <button type="button" onClick={() => onOpen(it.id)} aria-label="Open updates" className="relative inline-grid place-items-center dimmer hover:text-white">
                        <MessageCircle className="h-[18px] w-[18px]" />
                        {it.updates.length > 0 && <span className="absolute -right-2 -top-1.5 rounded-full bg-[#2337EE] px-1 text-[10px] font-bold text-white">{it.updates.length}</span>}
                      </button>
                    </td>
                    {schema.columns.map((c) => {
                      const val = it.values[c.key] ?? '';
                      if (c.type === 'person') return <td key={c.key} className="text-center"><PersonPicker value={val} onChange={(v) => actions.updateItem(boardKey, it.id, { values: { owner: v } })} /></td>;
                      if (c.type === 'date') {
                        return (
                          <td key={c.key} className="text-center">
                            <label className="relative inline-block cursor-pointer dim tnum hover:text-white">
                              {shortDate(val)}
                              <input type="date" value={val} aria-label="Due date" onChange={(e) => actions.updateItem(boardKey, it.id, { values: { [c.key]: e.target.value } })}
                                className="absolute inset-0 opacity-0 cursor-pointer" />
                            </label>
                          </td>
                        );
                      }
                      return (
                        <td key={c.key} className="px-1.5">
                          <LabelPicker value={val} options={c.options} allowEmpty={c.type !== 'status'}
                            onChange={(v) => actions.updateItem(boardKey, it.id, { values: { [c.key]: v }, ...(c.key === 'status' ? { done: v === 'Done' } : {}) })} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <AddRow colSpan={schema.columns.length + 2} onAdd={(name) => actions.addItem(boardKey, g.id, name)} />
              </tbody>
            </table>
          </div>
          <StatusBar items={g.items} />
        </>
      )}
    </section>
  ));
}
