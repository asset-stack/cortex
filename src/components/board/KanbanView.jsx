import { useState } from 'react';
import { useStore } from '@/data/store';
import { PRIORITY, STATUS } from '@/data/boards';
import { DEPARTMENTS, MODULE_LABELS } from '@/lib/boards';
import { AvatarStack } from '@/components/ui';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

export default function KanbanView({ boardId, schema, groups, onOpen, readOnly = false }) {
  const { actions } = useStore();
  const [over, setOver] = useState(null);
  const who = schema?.columns.find((c) => c.key === 'people'); // Owner (one person) or People
  const prioritised = schema?.columns.some((c) => c.key === 'priority');
  const departments = schema?.columns.some((c) => c.type === 'department'); // a card says its department when it isn't the board's
  // Columns mix groups: their tasks in board order (each group's saved order, the groups in theirs).
  const all = groups.flatMap((g) => g.items);
  // View access: cards still open the task, but nothing can be dragged or dropped.
  const drop = readOnly ? () => ({}) : (s) => ({
    onDragOver: (e) => { e.preventDefault(); setOver(s); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); },
    onDrop: (e) => {
      e.preventDefault(); setOver(null);
      const itemId = e.dataTransfer.getData('text/plain');
      if (itemId) actions.updateItem(boardId, itemId, { values: { status: s }, done: s === 'Done' });
    },
  });

  return (
    <div className="mt-7 overflow-x-auto scroll-thin pb-2">
      <div className="grid grid-cols-4 gap-4 min-w-[860px]">
        {Object.entries(STATUS).map(([s, color]) => {
          const items = all.filter((i) => i.values.status === s);
          return (
            <div key={s} className={cn('rounded-[24px] glass p-3', over === s && 'drag-over')} {...drop(s)}>
              <div className="mb-3 flex items-center justify-between px-1">
                <span className="pill" style={{ backgroundColor: color }}>{s}</span>
                <span className="text-[12px] dimmer tnum">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2 min-h-[90px]">
                {items.map((i) => (
                  <button key={i.id} type="button" draggable={!readOnly}
                    onDragStart={readOnly ? undefined : (e) => { e.dataTransfer.setData('text/plain', i.id); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => onOpen(i.id)}
                    className={cn('float rounded-[18px] chip p-3 text-left', readOnly ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing')}>
                    <div className="font-semibold">{i.name}</div>
                    <div className="mt-2 flex items-center gap-2">
                      <AvatarStack userIds={i.values.people} size={26} max={who?.type === 'owner' ? 1 : 3} label={who?.label || 'People'} />
                      {prioritised && PRIORITY[i.values.priority] && (
                        <span className="pill !h-[22px] !px-2 !text-[11px]" style={{ backgroundColor: PRIORITY[i.values.priority] }}>
                          <span className="sr-only">Priority: </span>{i.values.priority}
                        </span>
                      )}
                      {departments && DEPARTMENTS[i.values.department] && (
                        <span className="pill !h-[22px] !px-2 !text-[11px]" style={{ backgroundColor: DEPARTMENTS[i.values.department] }}>
                          <span className="sr-only">Department: </span>{MODULE_LABELS[i.values.department]}
                        </span>
                      )}
                      <span className="ml-auto text-[12px] dim tnum">{shortDate(i.values.due)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {!readOnly && <p className="mt-3 text-[12.5px] dimmer">Drag a card to change its status.</p>}
    </div>
  );
}
