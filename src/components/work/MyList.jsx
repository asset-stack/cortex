import { useEffect, useRef, useState } from 'react';
import { ListChecks, Plus, X } from 'lucide-react';
import { useStore } from '@/data/store';
import { LIST_MAX, listOf } from '@/lib/myList';
import { cn } from '@/lib/cn';

/** One line: tick it, click its text to change it (Enter or leaving saves, Escape cancels, saving it empty deletes it),
 *  or delete it. */
function Line({ item, onGone }) {
  const { actions } = useStore();
  const [draft, setDraft] = useState(null); // the text being edited, or null
  const input = useRef(null);
  const text = item.text.trim() || 'Untitled';
  useEffect(() => { if (draft !== null) input.current?.focus(); }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (!next) { actions.removeListItem(item.id); onGone(item.id); return; }
    if (next !== item.text) actions.updateListItem(item.id, { text: next });
  };
  return (
    <li data-line={item.id} className="group flex items-start gap-3 border-t rowline px-5 py-2.5">
      <input type="checkbox" checked={Boolean(item.done)} onChange={() => actions.updateListItem(item.id, { done: !item.done })}
        aria-label={`Mark ${text} done`} className="mt-[5px] h-4 w-4 shrink-0 accent-[#5fd4ff]" />
      {draft !== null ? (
        <input ref={input} value={draft} maxLength={LIST_MAX} aria-label="Change line" className="field !py-1 min-w-0 flex-1"
          onChange={(e) => setDraft(e.target.value)} onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(null); }
          }} />
      ) : (
        <button type="button" onClick={() => setDraft(item.text)} aria-label={`Edit ${text}`}
          className={cn('min-w-0 flex-1 break-words text-left font-semibold hover:underline', item.done && 'line-through opacity-60')}>{text}</button>
      )}
      <button type="button" onClick={() => { actions.removeListItem(item.id); onGone(item.id); }} aria-label={`Delete ${text}`} title="Delete"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * My list (0017, docs/PHASE2.md §27): the signed-in person's own lines at the top of their Dashboard, not linked to any
 * task, day or deal. Add one (Enter, then type the next), tick, edit in place, delete. Private: only on your own
 * Dashboard, and hidden until 0017 has run (useStore().missing).
 */
export default function MyList() {
  const { state, actions, missing = [] } = useStore();
  const [text, setText] = useState('');
  const list = useRef(null);
  const add = useRef(null);
  const lines = listOf(state, state.me);
  if (missing.includes('my_list')) return null;
  // A deleted line's focus goes to the next one (else the one before, else the add box), never to the page.
  const onGone = (id) => {
    const ids = lines.map((x) => x.id);
    const k = ids.indexOf(id);
    const nextId = ids[k + 1] || ids[k - 1];
    requestAnimationFrame(() => {
      const next = nextId && list.current?.querySelector(`[data-line="${CSS.escape(nextId)}"] button`);
      (next || add.current)?.focus();
    });
  };
  const submit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    if (actions.addListItem(text) !== false) setText('');
  };
  return (
    <section aria-label="My list" className="glass glass-rim rounded-[24px]">
      <h2 className="flex items-center gap-2 px-5 pb-3 pt-4 font-extrabold text-[16px]">
        <ListChecks className="h-4 w-4" aria-hidden="true" />My list
        <span className="text-[12px] font-semibold dimmer tnum">{lines.filter((x) => !x.done).length}</span>
      </h2>
      {lines.length > 0 && <ul ref={list}>{lines.map((x) => <Line key={x.id} item={x} onGone={onGone} />)}</ul>}
      <form onSubmit={submit} className="flex items-center gap-2 border-t rowline px-5 py-3">
        <input ref={add} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a line" aria-label="Add a line"
          maxLength={LIST_MAX} className="field min-w-0 flex-1" />
        <button type="submit" aria-label="Add line" title="Add" className="grid h-10 w-10 shrink-0 place-items-center rounded-full chip"><Plus className="h-4 w-4" /></button>
      </form>
    </section>
  );
}
