import { useState } from 'react';
import { Building2, ClipboardList, FolderKanban, GitBranch, LogOut, Mail, Megaphone, PanelLeftClose, PanelLeftOpen, RotateCcw, Sparkle } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { Avatar, Modal, Popover } from '@/components/ui';
import { cn } from '@/lib/cn';

export const NAV = [
  { id: 'work', label: 'My Work', icon: Sparkle },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'admin', label: 'Admin', icon: ClipboardList },
  { id: 'outreach', label: 'Outreach', icon: Mail, badge: 'AI' },
  { id: 'marketing', label: 'Marketing', icon: Megaphone },
  { id: 'pipeline', label: 'Pipeline', icon: GitBranch },
  { id: 'clients', label: 'Clients', icon: Building2 },
];

export default function Sidebar({ route }) {
  const { state, actions } = useStore();
  const users = useUsers();
  const [collapsed, setCollapsed] = useState(false);
  const [level, setLevel] = useState('Admin');
  const [anchor, setAnchor] = useState(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <aside className={cn('glass glass-rim hidden md:flex shrink-0 flex-col m-4 mr-0 rounded-[30px] transition-[width] duration-300', collapsed ? 'w-[76px]' : 'w-[220px]')}>
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-5">
        <div className="btn-primary grid h-9 w-9 shrink-0 place-items-center rounded-xl"><div className="h-3.5 w-3.5 rounded-[4px] border-[3px] border-white" /></div>
        {!collapsed && <div className="font-extrabold text-[16px]">AssetStack</div>}
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 text-[14px]">
        {NAV.map(({ id, label, icon: Icon, badge }) => (
          <a key={id} href={`#/${id}`} aria-current={route === id ? 'page' : undefined} title={collapsed ? label : undefined}
            className={cn('flex items-center gap-3 rounded-full px-3.5 py-2.5', route === id ? 'chip-on' : 'dim hover:bg-white/10 hover:text-white')}>
            <Icon className="h-[18px] w-[18px] shrink-0" />
            {!collapsed && <span className="flex-1">{label}</span>}
            {!collapsed && badge && <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', route === id ? 'bg-[#1a2340]/10' : 'bg-white/20')}>{badge}</span>}
          </a>
        ))}
      </nav>

      {!collapsed && (
        <div className="m-3 grid grid-cols-2 gap-1 rounded-full chip p-1 text-[12.5px]" role="radiogroup" aria-label="Viewing level">
          {['Admin', 'Manager'].map((l) => (
            <button key={l} type="button" role="radio" aria-checked={level === l} onClick={() => setLevel(l)} className={cn('rounded-full py-1.5', level === l ? 'chip-on font-semibold' : 'dim')}>{l}</button>
          ))}
        </div>
      )}

      <div className={cn('flex items-center gap-2 px-4 pb-4 pt-1', collapsed ? 'flex-col' : 'justify-between')}>
        <button type="button" ref={setAnchor} onClick={() => setWhoOpen((o) => !o)} className="flex items-center gap-2 rounded-full pr-2 hover:bg-white/10" aria-label="Switch team member" title="Switch team member (demo)">
          <Avatar userId={state.me} size={30} />{!collapsed && <span className="font-semibold">{users[state.me]?.name}</span>}
        </button>
        <div className={cn('flex gap-1 dim', collapsed && 'flex-col')}>
          <button type="button" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10">
            {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
          </button>
          <button type="button" onClick={() => setConfirmReset(true)} aria-label="Reset demo data" title="Reset demo data" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10"><RotateCcw className="h-4 w-4" /></button>
          <button type="button" aria-label="Log out" title="Sign-in arrives with the backend" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10"><LogOut className="h-[18px] w-[18px]" /></button>
        </div>
      </div>

      <Popover anchor={anchor} open={whoOpen} onClose={() => setWhoOpen(false)} width={200} align="left">
        <div className="px-2 pb-1 pt-0.5 text-[12px] dimmer">Viewing as (demo)</div>
        {state.users.map((u) => (
          <button key={u.id} type="button" onClick={() => { actions.setMe(u.id); setWhoOpen(false); }}
            className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', u.id === state.me && 'bg-white/15')}>
            <Avatar userId={u.id} size={24} ring={false} />{u.name}
          </button>
        ))}
      </Popover>
      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset demo data?">
        <p className="dim">This replaces everything in this browser with the original example data.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirmReset(false)} className="rounded-full chip px-4 h-10 font-semibold">Cancel</button>
          <button type="button" onClick={() => { actions.reset(); setConfirmReset(false); }} className="btn-primary rounded-full px-4 h-10 font-semibold">Reset</button>
        </div>
      </Modal>
    </aside>
  );
}

export function MobileNav({ route }) {
  return (
    <div className="glass md:hidden sticky top-0 z-20 rounded-b-[24px] px-4 py-3">
      <nav className="flex gap-1.5 overflow-x-auto text-[13px]">
        {NAV.map(({ id, label }) => (
          <a key={id} href={`#/${id}`} aria-current={route === id ? 'page' : undefined} className={cn('whitespace-nowrap rounded-full px-3 py-1.5', route === id ? 'chip-on font-semibold' : 'chip')}>{label}</a>
        ))}
      </nav>
    </div>
  );
}
