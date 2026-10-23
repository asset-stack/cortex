import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Calendar, CalendarClock, CalendarDays, CalendarOff, Columns3, Flag, ListFilter, MoreHorizontal, Pencil, Plus,
  Table2, Trash2, User,
} from 'lucide-react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { BOARD_SCHEMAS, STATUS, hasDates, itemWord } from '@/data/boards';
import { boardHref, boardItems, boardTitle, personalBoard, teamBoards } from '@/lib/boards';
import { Avatar, ConfirmModal, IconButton, Modal, Popover, SearchField, Segmented } from '@/components/ui';
import PersonSwitch from '@/components/work/PersonSwitch';
import { cn } from '@/lib/cn';
import { hashParam } from '@/lib/router';
import TableView from './TableView';
import KanbanView from './KanbanView';
import CalendarView from './CalendarView';
import BoardCalendar from './BoardCalendar';
import ItemDrawer from './ItemDrawer';

const VIEWS = [
  { id: 'table', label: 'Table', icon: Table2 },
  { id: 'kanban', label: 'Kanban', icon: Columns3 },
  { id: 'calendar', label: 'Calendar', icon: Calendar },
];

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const MENU_ITEM = 'flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent';

/** Admins: rename a team board. Opens on mount. */
function RenameBoard({ board, onClose }) {
  const { actions } = useStore();
  const [name, setName] = useState(board.name || '');
  const submit = (e) => {
    e.preventDefault();
    if (name.trim() && actions.renameBoard(board.id, name)) onClose();
  };
  return (
    <Modal open onClose={onClose} title="Rename board">
      <form onSubmit={submit}>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" autoFocus onFocus={(e) => e.target.select()} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-full chip px-4 h-10 font-semibold">Cancel</button>
          <button type="submit" disabled={!name.trim()} className="btn-primary rounded-full px-4 h-10 font-semibold disabled:opacity-50">Save</button>
        </div>
      </form>
    </Modal>
  );
}

/** A board with its views, filters and task drawer. `embedded`: shown on its module's page under the main content (Work
 *  in Progress on the Pipeline page): a section heading, and its admins' options are Rename only (it isn't in a menu). */
export default function Board({ board, embedded = false }) {
  const { state, actions } = useStore();
  const access = useAccess();
  const editable = access.canEditBoard(board); // at view: no adding, pickers, drag or typing
  const schema = BOARD_SCHEMAS[board.module];
  const title = boardTitle(state, board);
  const dated = hasDates(schema); // no dates: no calendar, no sort by due
  const prioritised = (schema?.columns || []).some((c) => c.key === 'priority');
  const word = itemWord(schema);
  const views = dated ? VIEWS : VIEWS.filter((v) => v.id !== 'calendar');
  const [view, setView] = useState('table');
  const [q, setQ] = useState('');
  const [person, setPerson] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState(() => hashParam('item')); // My Work links to #/<module>/<board>?item=<id>
  const [added, setAdded] = useState([]); // created under the current filters; shown even if they don't match
  const [personAnchor, setPersonAnchor] = useState(null);
  const [statusAnchor, setStatusAnchor] = useState(null);
  const [sortAnchor, setSortAnchor] = useState(null);
  const [optionsAnchor, setOptionsAnchor] = useState(null);
  const [popover, setPopover] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { setAdded((a) => (a.length ? [] : a)); }, [q, person, status]);

  // A board opens fresh (keyed by id). If the control that switched to it went away with the old board (person switch,
  // delete, move), focus fell to the page: start keyboard users at this board's title instead of the top.
  const heading = useRef(null);
  useEffect(() => {
    if (embedded) return; // part of its module's page, which opened at the top
    if (!document.activeElement || document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
  }, [embedded]);

  // Tasks show in their saved order (dragged, or set by Sort); search and the filters only hide some.
  const groups = useMemo(() => (board.groups || []).map((g) => ({
    ...g,
    items: g.items.filter((it) => added.includes(it.id) || (
      (!q || it.name.toLowerCase().includes(q.toLowerCase())) &&
      (!person || (it.values.people || []).includes(person)) &&
      (!status || it.values.status === status))),
  })), [board.groups, q, person, status, added]);
  // Sort (editors): every group's tasks in a new saved order, for everyone; dragging carries on from there.
  const sorts = editable ? [dated && { id: 'due', label: 'Due date', icon: CalendarClock }, prioritised && { id: 'priority', label: 'Priority', icon: Flag }].filter(Boolean) : [];

  const add = (groupId, name) => {
    const id = actions.addItem(board.id, groupId, name);
    if (id) setAdded((a) => [...a, id]);
    return id || null;
  };
  const newTask = () => { const id = add(board.groups[0]?.id, `New ${word.toLowerCase()}`); if (id) setOpenId(id); };
  const closeItem = () => {
    setOpenId(null);
    // Drop ?item= so a reload or Back doesn't reopen it; replaceState fires no hashchange.
    if (window.location.hash.includes('?')) window.history.replaceState(null, '', `#/${board.module}/${board.id}`);
    // The drawer hands focus back to what opened it; a task moved here from another board was opened by a row on that
    // board, which is gone, so focus would fall to the page: put it on this board's title instead.
    window.setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
    }, 50);
  };

  // Personal page: whose page to show, for those who see more than their own (SuperAdmin: everyone; admin: staff).
  const people = board.owner
    ? state.users.filter((u) => (u.active !== false || u.id === board.owner) && access.canViewBoard(personalBoard(state, u.id))).map((u) => u.id)
    : [];
  const showPerson = (id) => { const b = personalBoard(state, id); if (b) window.location.hash = boardHref(b); };

  // Team board options (admins). A menu choice moves focus to the options button first, so it gets focus back after.
  const options = !board.owner && access.isAdmin;
  const team = teamBoards(state, board.module);
  const at = team.findIndex((b) => b.id === board.id);
  const fromMenu = (fn) => () => { optionsAnchor?.querySelector('button')?.focus({ preventScroll: true }); setPopover(null); fn(); };
  const groupCount = board.groups.length;
  const taskCount = boardItems(board).length;
  const goes = [groupCount && count(groupCount, 'group'), taskCount && count(taskCount, 'task')].filter(Boolean);
  // Replace, not push: Back shouldn't lead to the deleted board's address.
  const remove = () => { if (actions.removeBoard(board.id)) window.location.replace(`#/${board.module}`); };

  if (!schema) return null;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
          {embedded
            ? <h2 ref={heading} tabIndex={-1} className="page-title min-w-0 break-words text-[26px] md:text-[32px] leading-none outline-none">{title}</h2>
            : <h1 ref={heading} tabIndex={-1} className="page-title min-w-0 break-words text-[34px] md:text-[44px] leading-none outline-none">{title}</h1>}
          {people.length > 1 && <PersonSwitch value={board.owner} onChange={showPerson} people={people} />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {options && (
            <span ref={setOptionsAnchor} className="shrink-0">
              <IconButton icon={MoreHorizontal} label="Board options" active={popover === 'options'} onClick={() => setPopover(popover === 'options' ? null : 'options')} />
            </span>
          )}
          {editable && (
            <button type="button" onClick={newTask} aria-label={`New ${word.toLowerCase()}`} title={`New ${word.toLowerCase()}`}
              className="btn-primary inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-full font-semibold sm:w-auto sm:px-5">
              <Plus className="h-4 w-4" /><span className="hidden sm:inline">New {word.toLowerCase()}</span>
            </button>
          )}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Segmented options={views} value={view} onChange={setView} label="View" />
        <SearchField value={q} onChange={setQ} />
        <span ref={setPersonAnchor}>
          <IconButton icon={User} label={person ? 'Person filter on' : 'Filter by person'} active={!!person} onClick={() => setPopover(popover === 'person' ? null : 'person')} />
        </span>
        <span ref={setStatusAnchor}>
          <IconButton icon={ListFilter} label={status ? `Status: ${status}` : 'Filter by status'} active={!!status} onClick={() => setPopover(popover === 'status' ? null : 'status')} />
        </span>
        {sorts.length > 0 && (
          <span ref={setSortAnchor}>
            <IconButton icon={ArrowUpDown} label="Sort" active={popover === 'sort'} onClick={() => setPopover(popover === 'sort' ? null : 'sort')} />
          </span>
        )}
      </div>

      <Popover anchor={personAnchor} open={popover === 'person'} onClose={() => setPopover(null)} width={190} align="right">
        {[{ id: '', name: 'Everyone' }, ...state.users].map((u) => (
          <button key={u.id || 'all'} type="button" aria-pressed={person === u.id} onClick={() => { setPerson(u.id); setPopover(null); }}
            className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', person === u.id && 'bg-white/15')}>
            {u.id ? <Avatar userId={u.id} size={22} ring={false} /> : <span className="w-[22px]" />}{u.name}
          </button>
        ))}
      </Popover>
      <Popover anchor={statusAnchor} open={popover === 'status'} onClose={() => setPopover(null)} width={180} align="right">
        <div className="flex flex-col gap-1.5">
          {Object.entries(STATUS).map(([s, c]) => (
            <button key={s} type="button" aria-pressed={status === s} className={cn('pill', status === s && 'ring-2 ring-white')} style={{ backgroundColor: c }} onClick={() => { setStatus(s); setPopover(null); }}>{s}</button>
          ))}
          <button type="button" aria-pressed={!status} className="pill pill-empty" onClick={() => { setStatus(''); setPopover(null); }}>All statuses</button>
        </div>
      </Popover>
      {sorts.length > 0 && (
        <Popover anchor={sortAnchor} open={popover === 'sort'} onClose={() => setPopover(null)} width={170} align="right">
          <div className="flex flex-col">
            {sorts.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className={MENU_ITEM} onClick={() => { setPopover(null); actions.sortItems(board.id, id); }}>
                <Icon className="h-4 w-4 dim" aria-hidden="true" />{label}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {options && (
        <Popover anchor={optionsAnchor} open={popover === 'options'} onClose={() => setPopover(null)} width={190} align="right">
          <div className="flex flex-col">
            <button type="button" className={MENU_ITEM} onClick={fromMenu(() => setRenaming(true))}><Pencil className="h-4 w-4 dim" />Rename</button>
            {/* The 3-month calendar above its tasks (0009; on for Posting schedule to start). */}
            {dated && (
              <button type="button" className={MENU_ITEM} onClick={fromMenu(() => actions.setBoardCalendar(board.id, !board.calendar))}>
                {board.calendar ? <CalendarOff className="h-4 w-4 dim" /> : <CalendarDays className="h-4 w-4 dim" />}
                {board.calendar ? 'Hide calendar' : 'Show calendar'}
              </button>
            )}
            {!embedded && (
              <>
                <button type="button" className={MENU_ITEM} disabled={at <= 0} onClick={fromMenu(() => actions.moveBoard(board.id, -1))}><ArrowUp className="h-4 w-4 dim" />Move up</button>
                <button type="button" className={MENU_ITEM} disabled={at < 0 || at >= team.length - 1} onClick={fromMenu(() => actions.moveBoard(board.id, 1))}><ArrowDown className="h-4 w-4 dim" />Move down</button>
                <button type="button" className={MENU_ITEM} onClick={fromMenu(() => setDeleting(true))}><Trash2 className="h-4 w-4 dim" />Delete board</button>
              </>
            )}
          </div>
        </Popover>
      )}
      {renaming && <RenameBoard board={board} onClose={() => setRenaming(false)} />}
      <ConfirmModal open={deleting} onClose={() => setDeleting(false)} onConfirm={remove} title={`Delete ${title}?`}>
        {goes.length ? `Its ${goes.join(' and ')} ${groupCount + taskCount === 1 ? 'is' : 'are'} deleted too.` : null}
      </ConfirmModal>

      {board.calendar && !board.owner && dated && view !== 'calendar' && <BoardCalendar groups={groups} onOpen={setOpenId} />}
      {view === 'table' && <TableView boardId={board.id} schema={schema} groups={groups} onOpen={setOpenId} onAdd={add} readOnly={!editable} />}
      {view === 'kanban' && <KanbanView boardId={board.id} groups={groups} onOpen={setOpenId} readOnly={!editable} />}
      {view === 'calendar' && <CalendarView groups={groups} onOpen={setOpenId} />}

      {/* Keyed by task so its local drafts (name, update) never carry over to another task. */}
      <ItemDrawer key={openId ?? 'closed'} boardId={board.id} schema={schema} itemId={openId} onClose={closeItem} readOnly={!editable} />
    </div>
  );
}
