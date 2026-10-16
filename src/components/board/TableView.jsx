import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, MessageCircle, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { findBoard } from '@/lib/boards';
import { ConfirmModal, InlineRename, LabelPicker, PeoplePicker, Popover } from '@/components/ui';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const ICON = 'grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white';
// Row actions: on touch widths always shown; from md up on row hover or keyboard focus.
const ROW_ACTION = 'md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 focus-visible:opacity-100';
const MENU_ITEM = 'flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent';
const taskName = (it) => it.name.trim() || 'Untitled task';
const tasksGo = (n) => (n ? `Its ${n} ${n === 1 ? 'task is' : 'tasks are'} deleted too.` : null);

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

/** Group name (collapse toggle) and, for editors, its options: rename, move up/down, delete. */
function GroupHead({ group, count, first, last, collapsed, renaming, readOnly, toggleRef, onToggle, onRename, onRenamed, onMove, onDelete }) {
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  if (renaming) {
    return (
      <div className="flex max-w-full items-center gap-2" style={{ color: group.color }}>
        <ChevronDown className={cn('h-5 w-5 shrink-0', collapsed && '-rotate-90')} aria-hidden="true" />
        <InlineRename value={group.name} label="Group name" onSave={onRename} onDone={onRenamed}
          className="!w-72 max-w-full !py-1 !px-2.5 text-[17px] font-extrabold" />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button ref={toggleRef} type="button" className="flex min-w-0 items-center gap-2 text-[17px] font-extrabold" style={{ color: group.color }}
        onClick={onToggle} aria-expanded={!collapsed}>
        <ChevronDown className={cn('h-5 w-5 shrink-0 transition-transform', collapsed && '-rotate-90')} />
        <span className="truncate">{group.name}</span><span className="text-[12px] font-semibold dimmer">{count}</span>
      </button>
      {!readOnly && (
        <>
          <button ref={setAnchor} type="button" onClick={() => setOpen((o) => !o)} aria-label={`Options for ${group.name}`} title="Group options"
            aria-haspopup="true" aria-expanded={open} className={ICON}>
            <MoreHorizontal className="h-4 w-4" />
          </button>
          <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={180} align="left">
            <div className="flex flex-col">
              <button type="button" className={MENU_ITEM} onClick={() => { setOpen(false); onRename(null); }}>
                <Pencil className="h-4 w-4" aria-hidden="true" />Rename
              </button>
              <button type="button" className={MENU_ITEM} disabled={first} onClick={() => { setOpen(false); onMove(-1); }}>
                <ArrowUp className="h-4 w-4" aria-hidden="true" />Move up
              </button>
              <button type="button" className={MENU_ITEM} disabled={last} onClick={() => { setOpen(false); onMove(1); }}>
                <ArrowDown className="h-4 w-4" aria-hidden="true" />Move down
              </button>
              {/* Focus the options button first, so the confirm dialog hands focus back to it on Cancel. */}
              <button type="button" className={cn(MENU_ITEM, 'text-rose-200')} onClick={() => { anchor?.focus(); setOpen(false); onDelete(); }}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />Delete group
              </button>
            </div>
          </Popover>
        </>
      )}
    </div>
  );
}

export default function TableView({ boardId, schema, groups, onOpen, onAdd, readOnly = false }) {
  const { state, actions } = useStore();
  const all = findBoard(state, boardId)?.groups || []; // `groups` may be filtered; counts and ends come from the board
  const [collapsed, setCollapsed] = useState({});
  const [renaming, setRenaming] = useState(null); // 'g:<group id>' | 't:<task id>'
  const [confirm, setConfirm] = useState(null); // { title, body, run }
  // After Enter/Escape in a rename, focus goes back to the group toggle / task name it replaced.
  const focusable = useRef({});
  const [refocus, setRefocus] = useState(null);
  useEffect(() => {
    if (!refocus) return;
    focusable.current[refocus]?.focus();
    setRefocus(null);
  }, [refocus]);
  const keep = (key) => (el) => { if (el) focusable.current[key] = el; else delete focusable.current[key]; };
  const renamed = (key) => (byKey) => { setRenaming(null); if (byKey) setRefocus(key); };

  const addGroup = () => {
    const id = actions.addGroup(boardId, 'New group');
    if (id) setRenaming(`g:${id}`); // type its name straight away
  };
  const cols = schema.columns.length + (readOnly ? 2 : 3);

  return (
    <>
      {groups.map((g, gi) => {
        const at = all.findIndex((x) => x.id === g.id);
        const total = at >= 0 ? all[at].items.length : g.items.length;
        const gKey = `g:${g.id}`;
        return (
          <section key={g.id} className="mt-8">
            <GroupHead group={g} count={g.items.length} first={at <= 0} last={at < 0 || at === all.length - 1}
              collapsed={collapsed[g.id]} renaming={renaming === gKey} readOnly={readOnly} toggleRef={keep(gKey)}
              onToggle={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}
              onRename={(name) => (name == null ? setRenaming(gKey) : actions.renameGroup(boardId, g.id, name))}
              onRenamed={renamed(gKey)}
              onMove={(dir) => actions.moveGroup(boardId, g.id, dir)}
              onDelete={() => setConfirm({ title: `Delete ${g.name}?`, body: tasksGo(total), run: () => actions.removeGroup(boardId, g.id) })} />
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
                        {!readOnly && <th className="w-[80px]"><span className="sr-only">Actions</span></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map((it) => {
                        const tKey = `t:${it.id}`;
                        const name = taskName(it);
                        return (
                          <tr key={it.id} className="group border-t rowline hover:bg-white/5">
                            <td className="p-3 text-center">
                              <input type="checkbox" checked={it.done} aria-label={`Mark ${it.name} done`} disabled={readOnly}
                                onChange={() => actions.updateItem(boardId, it.id, { done: !it.done, values: { status: it.done ? 'Not started' : 'Done' } })}
                                className="h-4 w-4 accent-[#5fd4ff] disabled:opacity-60" />
                            </td>
                            <td className={renaming === tKey ? 'px-1.5 py-1' : 'p-3'}>
                              {renaming === tKey ? (
                                <InlineRename value={it.name} label="Task name" className="!py-1.5 !px-2 font-semibold"
                                  onSave={(v) => actions.updateItem(boardId, it.id, { name: v })} onDone={renamed(tKey)} />
                              ) : (
                                <>
                                  <button ref={keep(tKey)} type="button" onClick={() => onOpen(it.id)} className={cn('text-left font-semibold hover:underline', it.done && 'line-through opacity-60')}>{name}</button>
                                  {it.subtasks.length > 0 && <span className="ml-2 text-[11.5px] dimmer tnum">{it.subtasks.filter((s) => s.done).length}/{it.subtasks.length}</span>}
                                </>
                              )}
                            </td>
                            <td className="text-center">
                              <button type="button" onClick={() => onOpen(it.id)} aria-label="Open updates" className="relative inline-grid place-items-center dimmer hover:text-white">
                                <MessageCircle className="h-[18px] w-[18px]" />
                                {it.updates.length > 0 && <span className="absolute -right-2 -top-1.5 rounded-full bg-[#2337EE] px-1 text-[10px] font-bold text-white">{it.updates.length}</span>}
                              </button>
                            </td>
                            {schema.columns.map((c) => {
                              const val = it.values[c.key] ?? '';
                              if (c.type === 'people') {
                                return (
                                  <td key={c.key} className="text-center">
                                    <PeoplePicker value={it.values.people || []} label={`${c.label} for ${it.name}`} readOnly={readOnly}
                                      onChange={(v) => actions.updateItem(boardId, it.id, { values: { people: v } })} />
                                  </td>
                                );
                              }
                              if (c.type === 'date' && readOnly) {
                                return <td key={c.key} className="text-center dim tnum">{shortDate(val)}</td>;
                              }
                              if (c.type === 'date') {
                                return (
                                  <td key={c.key} className="text-center">
                                    <label className="relative inline-block cursor-pointer rounded-[10px] px-1 dim tnum hover:text-white has-[:focus-visible]:text-white has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-white">
                                      {shortDate(val)}
                                      <input type="date" value={val} aria-label={`${c.label} date for ${it.name}`} onChange={(e) => actions.updateItem(boardId, it.id, { values: { [c.key]: e.target.value } })}
                                        className="absolute inset-0 opacity-0 cursor-pointer" />
                                    </label>
                                  </td>
                                );
                              }
                              return (
                                <td key={c.key} className="px-1.5">
                                  <LabelPicker label={`${c.label} for ${it.name}`} value={val} options={c.options} allowEmpty={c.type !== 'status'} readOnly={readOnly}
                                    onChange={(v) => actions.updateItem(boardId, it.id, { values: { [c.key]: v }, ...(c.key === 'status' ? { done: v === 'Done' } : {}) })} />
                                </td>
                              );
                            })}
                            {!readOnly && (
                              <td className="pr-2">
                                {renaming !== tKey && (
                                  <div className="flex justify-end">
                                    <button type="button" onClick={() => setRenaming(tKey)} aria-label={`Rename ${name}`} title="Rename task" className={cn(ICON, ROW_ACTION)}>
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button type="button" aria-label={`Delete ${name}`} title="Delete task" className={cn(ICON, ROW_ACTION)}
                                      onClick={(e) => { e.currentTarget.focus(); setConfirm({ title: `Delete ${name}?`, run: () => actions.deleteItem(boardId, it.id) }); }}>
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                      {!readOnly && <AddRow colSpan={cols - 1} onAdd={(name) => onAdd(g.id, name)} />}
                    </tbody>
                  </table>
                </div>
                <StatusBar items={g.items} />
              </>
            )}
            {!readOnly && gi === groups.length - 1 && <AddGroup onAdd={addGroup} />}
          </section>
        );
      })}
      {/* A board with no groups at all; when filters hide every group there's nothing to add after. */}
      {!readOnly && !all.length && !groups.length && <div className="mt-8"><AddGroup onAdd={addGroup} flush /></div>}

      <ConfirmModal open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.title} onConfirm={() => confirm?.run()}>
        {confirm?.body}
      </ConfirmModal>
    </>
  );
}

function AddGroup({ onAdd, flush = false }) {
  return (
    <button type="button" onClick={onAdd} className={cn('inline-flex items-center gap-2 rounded-full chip px-4 h-10 font-semibold', !flush && 'mt-6')}>
      <Plus className="h-4 w-4" aria-hidden="true" />Add group
    </button>
  );
}
