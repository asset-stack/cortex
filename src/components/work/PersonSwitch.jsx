import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useStore } from '@/data/store';
import { Avatar, Popover } from '@/components/ui';
import { cn } from '@/lib/cn';
import { localClock, localTime } from '@/lib/format';

/** Admins: whose Dashboard (or notes page) to show. Active team members only; `people` (user ids) narrows the list. */
export default function PersonSwitch({ value, onChange, people: only }) {
  const { state } = useStore();
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  const current = state.users.find((u) => u.id === value);
  const people = state.users.filter((u) => (u.active !== false || u.id === value) && (!only || only.includes(u.id)));
  return (
    <>
      <button type="button" ref={setAnchor} onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open}
        aria-label={`Showing ${current?.name || 'nobody'}. Change person`}
        className="inline-flex h-10 min-w-0 items-center gap-2 rounded-full chip pl-1.5 pr-3 font-semibold">
        <Avatar userId={value} size={28} ring={false} />
        <span className="max-w-[160px] truncate">{current?.name}</span>
        {current?.timezone && <span className="hidden truncate text-[12.5px] font-normal dimmer sm:inline" title={current.timezone}>{localClock(current.timezone)}</span>}
        <ChevronDown className="h-4 w-4 shrink-0 dim" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={240} align="right">
        <div className="flex flex-col">
          {people.map((u) => (
            <button key={u.id} type="button" aria-pressed={u.id === value} onClick={() => { onChange(u.id); setOpen(false); }}
              className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', u.id === value && 'bg-white/15')}>
              <Avatar userId={u.id} size={24} ring={false} /><span className="flex-1 truncate">{u.name}</span>
              {u.timezone && <span className="shrink-0 text-[12px] dimmer">{localTime(u.timezone)}</span>}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
