import { useEffect, useId, useRef, useState } from 'react';
import { Pencil, Trash2, X } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { useAccess } from '@/lib/access';
import { boardHref, boardTitle, findBoard, sameAudience } from '@/lib/boards';
import { itemWord } from '@/data/boards';
import { Avatar, ConfirmModal, Drawer, InlineRename, LabelPicker, PeoplePicker, QuickAdd } from '@/components/ui';
import { MessageText } from '@/lib/mentions';
import { ago, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const ICON = 'grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white';

// A text column (Work in Progress' Details): saved when you leave it (Escape undoes what you typed).
function TextField({ value, label, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <textarea value={v} aria-label={label} rows={2} className="field !py-1.5 resize-y" onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v.trim() !== value) onSave(v.trim()); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setV(value); } }} />
  );
}

export default function ItemDrawer({ boardId, schema, itemId, onClose, readOnly = false }) {
  const { state, actions } = useStore();
  const access = useAccess();
  const users = useUsers();
  const ids = useId();
  const [update, setUpdate] = useState('');
  const [nameDraft, setNameDraft] = useState(null); // holds a blank name locally so '' never reaches the store
  const [renamingSub, setRenamingSub] = useState(null);
  const [editing, setEditing] = useState(null); // { id, text }: the update being edited
  const [confirmDelete, setConfirmDelete] = useState(false);
  // After a subtask rename (Enter/Escape) or an update edit, focus goes back to the button that started it.
  const focusable = useRef({});
  const [refocus, setRefocus] = useState(null);
  useEffect(() => {
    if (!refocus) return;
    focusable.current[refocus]?.focus();
    setRefocus(null);
  }, [refocus]);
  const keep = (key) => (el) => { if (el) focusable.current[key] = el; else delete focusable.current[key]; };

  const board = findBoard(state, boardId);
  const group = itemId ? board?.groups.find((g) => g.items.some((i) => i.id === itemId)) : null;
  const item = group?.items.find((i) => i.id === itemId) || null;
  const title = item?.name.trim() || 'Untitled task';
  // Where it can move: this module's boards you can edit (this one first if, oddly, it isn't among them).
  const boards = board ? state.boards.filter((b) => sameAudience(board, b) && access.canEditBoard(b)) : [];
  if (board && !boards.includes(board)) boards.unshift(board);

  const moveToBoard = (toId) => {
    const to = findBoard(state, toId);
    if (!to || to.id === boardId || actions.moveItem(boardId, item.id, { board: toId }) === false) return;
    window.location.hash = boardHref(to, item.id).replace(/^#/, ''); // the drawer opens again on that board
  };
  const stopEditing = () => { setRefocus(`u:${editing.id}`); setEditing(null); };
  const saveUpdate = (e) => {
    e.preventDefault();
    const text = editing.text.trim();
    if (!text) return;
    if (text !== item.updates.find((u) => u.id === editing.id)?.text) actions.editUpdate(boardId, item.id, editing.id, text);
    stopEditing();
  };

  return (
    <Drawer open={!!item} onClose={onClose} title={title}>
      {item && (
        <div className="flex flex-col gap-6">
          <input value={nameDraft ?? item.name} aria-label={`${itemWord(schema)} name`} className="field text-[16px] font-semibold" readOnly={readOnly}
            onChange={(e) => {
              const v = e.target.value;
              if (v.trim()) { setNameDraft(null); actions.updateItem(boardId, item.id, { name: v }); } else setNameDraft(v);
            }}
            onBlur={() => setNameDraft(null)} />

          <div className="grid grid-cols-2 gap-3">
            {schema.columns.map((c) => (
              <div key={c.key} className={cn('flex flex-col gap-1.5', c.type === 'text' && 'col-span-2')}>
                <span className="text-[12px] dimmer">{c.label}</span>
                {c.type === 'people' && (
                  <div>
                    <PeoplePicker value={item.values.people || []} label={c.label} size={32} max={5} readOnly={readOnly}
                      onChange={(v) => actions.updateItem(boardId, item.id, { values: { people: v } })} />
                  </div>
                )}
                {c.type === 'text' && (readOnly
                  ? <span className="py-1.5">{item.values[c.key] || '—'}</span>
                  : <TextField value={String(item.values[c.key] ?? '')} label={c.label}
                      onSave={(v) => actions.updateItem(boardId, item.id, { values: { [c.key]: v } })} />)}
                {c.type === 'date' && (readOnly
                  ? <span className="py-1.5 tnum">{shortDate(item.values[c.key])}</span>
                  : <input type="date" value={item.values[c.key] || ''} className="field !py-1.5" aria-label={c.label}
                      onChange={(e) => actions.updateItem(boardId, item.id, { values: { [c.key]: e.target.value } })} />)}
                {(c.type === 'status' || c.type === 'label') && (
                  <LabelPicker label={c.label} value={item.values[c.key] || ''} options={c.options} allowEmpty={c.type !== 'status'} readOnly={readOnly}
                    onChange={(v) => actions.updateItem(boardId, item.id, { values: { [c.key]: v }, ...(c.key === 'status' ? { done: v === 'Done' } : {}) })} />
                )}
              </div>
            ))}
            {!readOnly && boards.length > 1 && (
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[12px] dimmer">Board</span>
                <select className="field !py-1.5" value={board.id} onChange={(e) => moveToBoard(e.target.value)}>
                  {boards.map((b) => <option key={b.id} value={b.id}>{boardTitle(state, b)}</option>)}
                </select>
              </label>
            )}
            {!readOnly && (
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[12px] dimmer">Group</span>
                <select className="field !py-1.5" value={group.id} onChange={(e) => actions.moveItem(boardId, item.id, { group: e.target.value })}>
                  {board.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
            )}
          </div>

          <section>
            <h3 className="font-bold">Subtasks</h3>
            <ul className="mt-2 flex flex-col gap-1">
              {item.subtasks.map((s) => {
                const box = `${ids}-sub-${s.id}`;
                return (
                  <li key={s.id} className="flex items-center gap-2.5 rounded-xl py-1 pl-2 pr-1 hover:bg-white/5">
                    {/* The checkbox stays the same element while the text turns into a rename field. */}
                    <input id={box} type="checkbox" checked={s.done} disabled={readOnly} onChange={() => actions.toggleSubtask(boardId, item.id, s.id)}
                      className="h-4 w-4 shrink-0 accent-[#5fd4ff] disabled:opacity-60" />
                    {renamingSub === s.id ? (
                      <InlineRename value={s.text} label="Subtask" className="min-w-0 flex-1 !py-1 !px-2"
                        onSave={(t) => actions.renameSubtask(boardId, item.id, s.id, t)}
                        onDone={(byKey) => { setRenamingSub(null); if (byKey) setRefocus(`s:${s.id}`); }} />
                    ) : (
                      <label htmlFor={box} className={cn('min-w-0 flex-1 break-words py-0.5', s.done && 'line-through dimmer')}>{s.text}</label>
                    )}
                    {!readOnly && renamingSub !== s.id && (
                      <span className="flex shrink-0">
                        <button ref={keep(`s:${s.id}`)} type="button" onClick={() => setRenamingSub(s.id)} aria-label={`Rename ${s.text}`} title="Rename" className={ICON}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => actions.removeSubtask(boardId, item.id, s.id)} aria-label={`Remove ${s.text}`} title="Remove" className={ICON}>
                          <X className="h-4 w-4" />
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {!readOnly && <QuickAdd className="mt-2" placeholder="Add subtask" onSubmit={(t) => actions.addSubtask(boardId, item.id, t)} />}
          </section>

          <section>
            <h3 className="font-bold">Updates</h3>
            {/* An @Name in an update adds that person to the task (the store does it). */}
            {!readOnly && (
              <form className="mt-2 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (update.trim()) { actions.addUpdate(boardId, item.id, update.trim()); setUpdate(''); } }}>
                <textarea value={update} onChange={(e) => setUpdate(e.target.value)} rows={3} placeholder="Write an update" aria-label="Write an update" className="field resize-none" />
                <button type="submit" disabled={!update.trim()} className="btn-primary self-end rounded-full px-4 h-9 font-semibold">Post update</button>
              </form>
            )}
            <ol className={readOnly ? 'mt-2 flex flex-col gap-3' : 'mt-4 flex flex-col gap-3'}>
              {item.updates.map((u) => {
                const own = !readOnly && (u.user === state.me || access.isAdmin); // as the store and the database allow
                const isEditing = editing?.id === u.id;
                return (
                  <li key={u.id} className="flex gap-3 rounded-2xl chip p-3">
                    <Avatar userId={u.user} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1 text-[12.5px] dimmer">{users[u.user]?.name} · {ago(u.ts)}</div>
                        {own && !isEditing && (
                          <div className="-mr-1.5 -mt-1.5 flex shrink-0">
                            <button ref={keep(`u:${u.id}`)} type="button" onClick={() => setEditing({ id: u.id, text: u.text })} aria-label="Edit update" title="Edit" className={ICON}>
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button type="button" onClick={() => actions.removeUpdate(boardId, item.id, u.id)} aria-label="Delete update" title="Delete" className={ICON}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      {isEditing ? (
                        <form className="mt-1.5 flex flex-col gap-2" onSubmit={saveUpdate}>
                          <textarea value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} rows={3} autoFocus
                            aria-label="Edit update" className="field resize-none"
                            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); stopEditing(); } }} />
                          <div className="flex justify-end gap-2">
                            <button type="button" onClick={stopEditing} className="rounded-full chip px-4 h-9 font-semibold">Cancel</button>
                            <button type="submit" disabled={!editing.text.trim()} className="btn-primary rounded-full px-4 h-9 font-semibold">Save</button>
                          </div>
                        </form>
                      ) : (
                        <p className="mt-0.5 whitespace-pre-wrap break-words"><MessageText text={u.text} users={state.users.filter((x) => x.name)} me={users[state.me]} /></p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          {!readOnly && (
            <button type="button" onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-2 self-start rounded-full chip px-4 h-9 text-rose-200">
              <Trash2 className="h-4 w-4" />Delete task
            </button>
          )}
          <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${title}?`}
            onConfirm={() => { actions.deleteItem(boardId, item.id); onClose(); }} />
        </div>
      )}
    </Drawer>
  );
}
