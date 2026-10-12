import { useState } from 'react';
import { Building2, ClipboardList, FolderKanban, GitBranch, Loader2, LogOut, Mail, Megaphone, PanelLeftClose, PanelLeftOpen, RotateCcw, Settings, Sparkle } from 'lucide-react';
import { useIsAdmin, useStore, useUsers } from '@/data/store';
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

// Admin-only pages, kept out of NAV so the My Work shortcuts are the same for everyone.
const ADMIN_NAV = [{ id: 'settings', label: 'Settings', icon: Settings }];

function useNav() {
  return useIsAdmin() ? [...NAV, ...ADMIN_NAV] : NAV;
}

const ROLE = { admin: 'Admin', member: 'Member' };

function RoleChip({ role, className }) {
  return <span className={cn('inline-block rounded-full bg-white/15 px-1.5 text-[10.5px] font-semibold leading-[17px] dim', className)}>{ROLE[role] || ROLE.member}</span>;
}

const SYNC = {
  saved: { color: '#34d399', label: 'All changes saved' },
  saving: { color: '#fbbf24', label: 'Saving' },
  error: { color: '#f87171', label: 'Not saved' },
  offline: { color: '#94a3b8', label: 'Offline' },
};

/** Live mode only: green saved, amber saving, red error, grey offline. */
function SyncDot({ className }) {
  const { state, sync } = useStore();
  if (state.mode !== 'live') return null;
  const s = SYNC[sync?.state] || SYNC.saved;
  const label = sync?.message && sync.state !== 'saved' ? `${s.label}: ${sync.message}` : s.label;
  return (
    <span role="img" aria-label={label} title={label} style={{ background: s.color }}
      className={cn('block h-2.5 w-2.5 rounded-full ring-2 ring-[#0d1a24]/70', sync?.state === 'saving' && 'animate-pulse', className)} />
  );
}

/** Avatar button. Demo: the "Viewing as" picker. Live: name, email and Sign out. Shared by Sidebar and MobileNav. */
function AccountMenu({ showName = true, align = 'left' }) {
  const { state, actions } = useStore();
  const users = useUsers();
  const me = users[state.me];
  const demo = state.mode !== 'live';
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  // Sign-out waits for edits to save; if some still haven't, it asks before dropping them.
  const signOut = async (force) => {
    setBusy(true);
    const r = await actions.signOut({ force });
    setBusy(false);
    if (r?.unsaved) { setOpen(false); setUnsaved(true); }
  };
  return (
    <>
      <button type="button" ref={setAnchor} onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open}
        className={cn('flex min-w-0 items-center gap-2 rounded-full text-left hover:bg-white/10', showName && 'pr-2')}
        aria-label={demo ? 'Switch team member' : 'Account'} title={demo ? 'Switch team member (demo)' : undefined}>
        <Avatar userId={state.me} size={30} />
        {showName && (
          <span className="min-w-0 leading-tight">
            <span className="block truncate font-semibold">{me?.name}</span>
            <RoleChip role={me?.role} className="mt-0.5" />
          </span>
        )}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={demo ? 210 : 240} align={align}>
        {demo ? (
          <>
            <div className="px-2 pb-1 pt-0.5 text-[12px] dimmer">Viewing as (demo)</div>
            {state.users.map((u) => (
              <button key={u.id} type="button" onClick={() => { actions.setMe(u.id); setOpen(false); }}
                className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', u.id === state.me && 'bg-white/15')}>
                <Avatar userId={u.id} size={24} ring={false} /><span className="flex-1 truncate">{u.name}</span>
                {u.role === 'admin' && <RoleChip role="admin" />}
              </button>
            ))}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2.5 px-2 pb-2 pt-1">
              <Avatar userId={state.me} size={34} ring={false} />
              <div className="min-w-0">
                <div className="truncate font-semibold">{me?.name}</div>
                <div className="truncate text-[12.5px] dimmer">{me?.email}</div>
                <RoleChip role={me?.role} className="mt-1" />
              </div>
            </div>
            <button type="button" onClick={() => signOut(false)} disabled={busy}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}Sign out
            </button>
          </>
        )}
      </Popover>
      <Modal open={unsaved} onClose={() => setUnsaved(false)} title="Some changes aren’t saved yet">
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setUnsaved(false)} className="rounded-full chip px-4 h-10 font-semibold">Cancel</button>
          <button type="button" onClick={() => signOut(true)} disabled={busy} className="btn-primary inline-flex items-center gap-2 rounded-full px-4 h-10 font-semibold">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Sign out anyway
          </button>
        </div>
      </Modal>
    </>
  );
}

/** Reset button with its confirm dialog (demo mode). Shared by Sidebar and MobileNav. */
function ResetDemo() {
  const { state, actions } = useStore();
  const [confirm, setConfirm] = useState(false);
  if (state.mode === 'live') return null;
  return (
    <>
      <button type="button" onClick={() => setConfirm(true)} aria-label="Reset demo data" title="Reset demo data" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10"><RotateCcw className="h-4 w-4" /></button>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Reset demo data?">
        <p className="dim">This replaces everything in this browser with the original example data.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirm(false)} className="rounded-full chip px-4 h-10 font-semibold">Cancel</button>
          <button type="button" onClick={() => { actions.reset(); setConfirm(false); }} className="btn-primary rounded-full px-4 h-10 font-semibold">Reset</button>
        </div>
      </Modal>
    </>
  );
}

export default function Sidebar({ route }) {
  const [collapsed, setCollapsed] = useState(false);
  const nav = useNav();

  return (
    <aside className={cn('glass glass-rim hidden md:flex shrink-0 flex-col m-4 mr-0 rounded-[30px] transition-[width] duration-300', collapsed ? 'w-[76px]' : 'w-[220px]')}>
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-5">
        <div className="relative shrink-0">
          <div className="btn-primary grid h-9 w-9 place-items-center rounded-xl"><div className="h-3.5 w-3.5 rounded-[4px] border-[3px] border-white" /></div>
          <SyncDot className="absolute -right-1 -top-1" />
        </div>
        {!collapsed && <div className="font-extrabold text-[16px]">Cortex</div>}
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 text-[14px]">
        {nav.map(({ id, label, icon: Icon, badge }) => (
          <a key={id} href={`#/${id}`} aria-current={route === id ? 'page' : undefined} title={collapsed ? label : undefined}
            className={cn('flex items-center gap-3 rounded-full px-3.5 py-2.5', route === id ? 'chip-on' : 'dim hover:bg-white/10 hover:text-white')}>
            <Icon className="h-[18px] w-[18px] shrink-0" />
            {!collapsed && <span className="flex-1">{label}</span>}
            {!collapsed && badge && <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', route === id ? 'bg-[#1a2340]/10' : 'bg-white/20')}>{badge}</span>}
          </a>
        ))}
      </nav>

      <div className={cn('flex items-center gap-2 px-4 pb-4 pt-3', collapsed ? 'flex-col' : 'justify-between')}>
        <AccountMenu showName={!collapsed} />
        <div className={cn('flex shrink-0 gap-1 dim', collapsed && 'flex-col')}>
          <button type="button" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10">
            {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
          </button>
          <ResetDemo />
        </div>
      </div>
    </aside>
  );
}

export function MobileNav({ route }) {
  const nav = useNav();
  return (
    <div className="glass md:hidden sticky top-0 z-20 rounded-b-[24px] px-4 py-3 flex items-center gap-2">
      <nav className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto text-[13px]">
        {nav.map(({ id, label }) => (
          <a key={id} href={`#/${id}`} aria-current={route === id ? 'page' : undefined} className={cn('whitespace-nowrap rounded-full px-3 py-1.5', route === id ? 'chip-on font-semibold' : 'chip')}>{label}</a>
        ))}
      </nav>
      <div className="flex shrink-0 items-center gap-1 dim">
        <SyncDot className="mx-1" />
        <ResetDemo />
        <AccountMenu showName={false} align="right" />
      </div>
    </div>
  );
}
