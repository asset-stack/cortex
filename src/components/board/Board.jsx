import { useMemo, useState } from 'react';
import { ArrowUpDown, Calendar, Columns3, ListFilter, Table2, User } from 'lucide-react';
import { useStore } from '@/data/store';
import { BOARD_SCHEMAS, STATUS } from '@/data/boards';
import { IconButton, PageHeader, Popover, SearchField, Segmented, Avatar } from '@/components/ui';
import { cn } from '@/lib/cn';
import TableView from './TableView';
import KanbanView from './KanbanView';
import CalendarView from './CalendarView';
import ItemDrawer from './ItemDrawer';

const VIEWS = [
  { id: 'table', label: 'Table', icon: Table2 },
  { id: 'kanban', label: 'Kanban', icon: Columns3 },
  { id: 'calendar', label: 'Calendar', icon: Calendar },
];

export default function Board({ boardKey }) {
  const { state, actions } = useStore();
  const schema = BOARD_SCHEMAS[boardKey];
  const board = state.boards[boardKey];
  const [view, setView] = useState('table');
  const [q, setQ] = useState('');
  const [person, setPerson] = useState('');
  const [status, setStatus] = useState('');
  const [sortDue, setSortDue] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [personAnchor, setPersonAnchor] = useState(null);
  const [statusAnchor, setStatusAnchor] = useState(null);
  const [popover, setPopover] = useState(null);

  const groups = useMemo(() => board.groups.map((g) => {
    let items = g.items.filter((it) =>
      (!q || it.name.toLowerCase().includes(q.toLowerCase())) &&
      (!person || it.values.owner === person) &&
      (!status || it.values.status === status));
    if (sortDue) items = [...items].sort((a, b) => (a.values.due || '9999').localeCompare(b.values.due || '9999'));
    return { ...g, items };
  }), [board.groups, q, person, status, sortDue]);

  const newTask = () => setOpenId(actions.addItem(boardKey, board.groups[0]?.id));

  return (
    <div>
      <PageHeader title={schema.title} action="New task" onAction={newTask} />
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Segmented options={VIEWS} value={view} onChange={setView} label="View" />
        <SearchField value={q} onChange={setQ} />
        <span ref={setPersonAnchor}>
          <IconButton icon={User} label={person ? 'Person filter on' : 'Filter by person'} active={!!person} onClick={() => setPopover(popover === 'person' ? null : 'person')} />
        </span>
        <span ref={setStatusAnchor}>
          <IconButton icon={ListFilter} label={status ? `Status: ${status}` : 'Filter by status'} active={!!status} onClick={() => setPopover(popover === 'status' ? null : 'status')} />
        </span>
        <IconButton icon={ArrowUpDown} label={sortDue ? 'Sorted by due date' : 'Sort by due date'} active={sortDue} onClick={() => setSortDue((s) => !s)} />
      </div>

      <Popover anchor={personAnchor} open={popover === 'person'} onClose={() => setPopover(null)} width={190} align="right">
        {[{ id: '', name: 'Everyone' }, ...state.users].map((u) => (
          <button key={u.id || 'all'} type="button" onClick={() => { setPerson(u.id); setPopover(null); }}
            className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', person === u.id && 'bg-white/15')}>
            {u.id ? <Avatar userId={u.id} size={22} ring={false} /> : <span className="w-[22px]" />}{u.name}
          </button>
        ))}
      </Popover>
      <Popover anchor={statusAnchor} open={popover === 'status'} onClose={() => setPopover(null)} width={180} align="right">
        <div className="flex flex-col gap-1.5">
          {Object.entries(STATUS).map(([s, c]) => (
            <button key={s} type="button" className={cn('pill', status === s && 'ring-2 ring-white')} style={{ backgroundColor: c }} onClick={() => { setStatus(s); setPopover(null); }}>{s}</button>
          ))}
          <button type="button" className="pill pill-empty" onClick={() => { setStatus(''); setPopover(null); }}>All statuses</button>
        </div>
      </Popover>

      {view === 'table' && <TableView boardKey={boardKey} schema={schema} groups={groups} onOpen={setOpenId} />}
      {view === 'kanban' && <KanbanView boardKey={boardKey} groups={groups} onOpen={setOpenId} />}
      {view === 'calendar' && <CalendarView groups={groups} onOpen={setOpenId} />}

      <ItemDrawer boardKey={boardKey} schema={schema} itemId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
