import { useState } from 'react';
import { useStore } from '@/data/store';
import { STATUS } from '@/data/boards';
import { Avatar } from '@/components/ui';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

export default function KanbanView({ boardKey, groups, onOpen }) {
  const { actions } = useStore();
  const [over, setOver] = useState(null);
  const all = groups.flatMap((g) => g.items);

  return (
    <div className="mt-7 overflow-x-auto scroll-thin pb-2">
      <div className="grid grid-cols-4 gap-4 min-w-[860px]">
        {Object.entries(STATUS).map(([s, color]) => {
          const items = all.filter((i) => i.values.status === s);
          return (
            <div key={s}
              className={cn('rounded-[24px] glass p-3', over === s && 'drag-over')}
              onDragOver={(e) => { e.preventDefault(); setOver(s); }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault(); setOver(null);
                const itemId = e.dataTransfer.getData('text/plain');
                if (itemId) actions.updateItem(boardKey, itemId, { values: { status: s }, done: s === 'Done' });
              }}>
              <div className="mb-3 flex items-center justify-between px-1">
                <span className="pill" style={{ backgroundColor: color }}>{s}</span>
                <span className="text-[12px] dimmer tnum">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2 min-h-[90px]">
                {items.map((i) => (
                  <button key={i.id} type="button" draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', i.id); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => onOpen(i.id)}
                    className="float cursor-grab rounded-[18px] chip p-3 text-left active:cursor-grabbing">
                    <div className="font-semibold">{i.name}</div>
                    <div className="mt-2 flex items-center justify-between">
                      <Avatar userId={i.values.owner} size={26} />
                      <span className="text-[12px] dim tnum">{shortDate(i.values.due)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[12.5px] dimmer">Drag a card to change its status.</p>
    </div>
  );
}
