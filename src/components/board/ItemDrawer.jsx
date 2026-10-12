import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { Avatar, Drawer, LabelPicker, PeoplePicker, QuickAdd } from '@/components/ui';
import { MessageText } from '@/lib/mentions';
import { ago, shortDate } from '@/lib/format';

export default function ItemDrawer({ boardKey, schema, itemId, onClose, readOnly = false }) {
  const { state, actions } = useStore();
  const users = useUsers();
  const [update, setUpdate] = useState('');
  const [nameDraft, setNameDraft] = useState(null); // holds a blank name locally so '' never reaches the store
  const item = itemId ? state.boards[boardKey]?.groups.flatMap((g) => g.items).find((i) => i.id === itemId) : null;

  return (
    <Drawer open={!!item} onClose={onClose} title={item?.name.trim() || 'Untitled task'}>
      {item && (
        <div className="flex flex-col gap-6">
          <input value={nameDraft ?? item.name} aria-label="Task name" className="field text-[16px] font-semibold" readOnly={readOnly}
            onChange={(e) => {
              const v = e.target.value;
              if (v.trim()) { setNameDraft(null); actions.updateItem(boardKey, item.id, { name: v }); } else setNameDraft(v);
            }}
            onBlur={() => setNameDraft(null)} />

          <div className="grid grid-cols-2 gap-3">
            {schema.columns.map((c) => (
              <div key={c.key} className="flex flex-col gap-1.5">
                <span className="text-[12px] dimmer">{c.label}</span>
                {c.type === 'people' && (
                  <div>
                    <PeoplePicker value={item.values.people || []} label={c.label} size={32} max={5} readOnly={readOnly}
                      onChange={(v) => actions.updateItem(boardKey, item.id, { values: { people: v } })} />
                  </div>
                )}
                {c.type === 'date' && (readOnly
                  ? <span className="py-1.5 tnum">{shortDate(item.values[c.key])}</span>
                  : <input type="date" value={item.values[c.key] || ''} className="field !py-1.5" aria-label={c.label}
                      onChange={(e) => actions.updateItem(boardKey, item.id, { values: { [c.key]: e.target.value } })} />)}
                {(c.type === 'status' || c.type === 'label') && (
                  <LabelPicker label={c.label} value={item.values[c.key] || ''} options={c.options} allowEmpty={c.type !== 'status'} readOnly={readOnly}
                    onChange={(v) => actions.updateItem(boardKey, item.id, { values: { [c.key]: v }, ...(c.key === 'status' ? { done: v === 'Done' } : {}) })} />
                )}
              </div>
            ))}
          </div>

          <section>
            <h3 className="font-bold">Subtasks</h3>
            <ul className="mt-2 flex flex-col gap-1">
              {item.subtasks.map((s) => (
                <li key={s.id}>
                  <label className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-white/5">
                    <input type="checkbox" checked={s.done} disabled={readOnly} onChange={() => actions.toggleSubtask(boardKey, item.id, s.id)} className="h-4 w-4 accent-[#5fd4ff] disabled:opacity-60" />
                    <span className={s.done ? 'line-through dimmer' : ''}>{s.text}</span>
                  </label>
                </li>
              ))}
            </ul>
            {!readOnly && <QuickAdd className="mt-2" placeholder="Add subtask" onSubmit={(t) => actions.addSubtask(boardKey, item.id, t)} />}
          </section>

          <section>
            <h3 className="font-bold">Updates</h3>
            {/* An @Name in an update adds that person to the task (the store does it). */}
            {!readOnly && (
              <form className="mt-2 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (update.trim()) { actions.addUpdate(boardKey, item.id, update.trim()); setUpdate(''); } }}>
                <textarea value={update} onChange={(e) => setUpdate(e.target.value)} rows={3} placeholder="Write an update" aria-label="Write an update" className="field resize-none" />
                <button type="submit" disabled={!update.trim()} className="btn-primary self-end rounded-full px-4 h-9 font-semibold">Post update</button>
              </form>
            )}
            <ol className={readOnly ? 'mt-2 flex flex-col gap-3' : 'mt-4 flex flex-col gap-3'}>
              {item.updates.map((u) => (
                <li key={u.id} className="flex gap-3 rounded-2xl chip p-3">
                  <Avatar userId={u.user} size={30} />
                  <div className="min-w-0">
                    <div className="text-[12.5px] dimmer">{users[u.user]?.name} · {ago(u.ts)}</div>
                    <p className="mt-0.5 whitespace-pre-wrap"><MessageText text={u.text} users={state.users.filter((x) => x.name)} me={users[state.me]} /></p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {!readOnly && (
            <button type="button" onClick={() => { actions.deleteItem(boardKey, item.id); onClose(); }}
              className="inline-flex items-center gap-2 self-start rounded-full chip px-4 h-9 text-rose-200">
              <Trash2 className="h-4 w-4" />Delete task
            </button>
          )}
        </div>
      )}
    </Drawer>
  );
}
