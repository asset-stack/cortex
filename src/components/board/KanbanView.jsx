import { useState } from 'react';
import { useStore } from '@/data/store';
import { STATUS } from '@/data/boards';
import { AvatarStack } from '@/components/ui';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

export default function KanbanView({ boardId, groups, sortDue, onOpen, readOnly = false }) {
  const { actions } = useStore();
  const [over, setOver] = useState(null);
  // Board sorts within each group; columns mix groups, so sort the combined list too.
  const all = groups.flatMap((g) => g.items);
  if (sortDue) all.sort((a, b) => (a.values.due || '9999').localeCompare(b.values.due || '9999'));
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
                    <div className="mt-2 flex items-center justify-between">
                      <AvatarStack userIds={i.values.people} size={26} label="People" />
                      <span className="text-[12px] dim tnum">{shortDate(i.values.due)}</span>
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
