import { useEffect, useRef, useState } from 'react';
import {
  Building2, CalendarDays, ChevronDown, FolderKanban, GitBranch, LayoutDashboard, Loader2, LogOut, Mail, Megaphone, PanelLeftClose, PanelLeftOpen, Plus,
  RotateCcw, Settings, Users,
} from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { Avatar, Modal, Popover } from '@/components/ui';
import NewBoardModal from '@/components/board/NewBoard';
import { ROLE_LABELS, roleOf, useAccess } from '@/lib/access';
import { MENU_BOARD_MODULES, MODULE_HOMES, MODULE_LABELS, boardHref, boardTitle, resolveBoard } from '@/lib/boards';
import { hashParam } from '@/lib/router';
import { cn } from '@/lib/cn';

// Everything a page can link to, in nav order. `module` pages show only when the user can at least view that module
// (src/lib/access.js); the former Admin board is part of Projects, shown as Operations (§18).
export const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  // The team Calendar (0009) and Team (§18): no module of their own; each thing on them keeps its own access rule
  // (src/lib/calendar.js, src/lib/work.js).
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'projects', label: MODULE_LABELS.projects, icon: FolderKanban, module: 'projects' },
  { id: 'marketing', label: MODULE_LABELS.marketing, icon: Megaphone, module: 'marketing' },
  { id: 'outreach', label: MODULE_LABELS.outreach, icon: Mail, badge: 'AI', module: 'outreach' },
  { id: 'pipeline', label: MODULE_LABELS.pipeline, icon: GitBranch, module: 'pipeline' },
  { id: 'clients', label: MODULE_LABELS.clients, icon: Building2, module: 'clients' },
];
// Nav rows with a sub-menu: the board modules (their boards) and Team (a row per active person).
const SECTIONS = [...MENU_BOARD_MODULES, 'team'];

// Admin-only pages, kept out of NAV (page shortcuts list modules only).
const ADMIN_NAV = [{ id: 'settings', label: 'Settings', icon: Settings }];

/** The signed-in user's nav: modules at 'none' are hidden, Settings is admins only. */
export function useNav() {
  const access = useAccess();
  const nav = NAV.filter((n) => !n.module || access.canView(n.module));
  return access.isAdmin ? [...nav, ...ADMIN_NAV] : nav;
}

/**
 * What's listed under the board modules (Operations and Marketing: their team boards; Outreach and Clients: their own
 * page, then their team boards; personal pages are on each person's Dashboard as My notes), only the boards you can
 * open, and under Team each active person; and the id of the entry on screen (`current`: a board's id, a MODULE_HOMES id
 * on #/outreach or #/clients, a person's id on #/team/<id>, '' elsewhere).
 */
function useBoardNav(route, sub) {
  const { state } = useStore();
  const access = useAccess();
  const visible = (state.boards || []).filter(access.canViewBoard);
  const lists = Object.fromEntries(MENU_BOARD_MODULES.map((m) => [m, [
    ...(MODULE_HOMES[m] ? [MODULE_HOMES[m]] : []),
    ...visible.filter((b) => b.module === m && !b.owner).map((b) => ({ id: b.id, href: boardHref(b), title: boardTitle(state, b) })),
  ]]));
  lists.team = state.users.filter((u) => u.active !== false).map((u) => ({ id: u.id, href: `#/team/${encodeURIComponent(u.id)}`, title: u.name }));
  if (route === 'team') return { lists, current: sub, isAdmin: access.isAdmin };
  const home = !sub && MODULE_HOMES[route];
  const current = home || !MENU_BOARD_MODULES.includes(route) ? null : resolveBoard(state, visible, route, sub, hashParam('item'));
  return { lists, current: home ? home.id : current?.id || '', isAdmin: access.isAdmin };
}

// SuperAdmin / Admin / Staff (phase 1's 'member' reads as Staff).
function RoleChip({ role, className }) {
  return <span className={cn('inline-block rounded-full bg-white/15 px-1.5 text-[10.5px] font-semibold leading-[17px] dim', className)}>{ROLE_LABELS[role] || ROLE_LABELS.staff}</span>;
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
  const role = roleOf(state);
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
            <RoleChip role={role} className="mt-0.5" />
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
                <RoleChip role={roleOf(state, u.id)} />
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
                <RoleChip role={role} className="mt-1" />
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

/** A board module's nav row (or Team's): the link to its default page, a toggle, and (open) its boards plus admins' New
 *  board (Team: its people). */
function BoardSection({ item, route, boards, current, open, onToggle, onNew }) {
  const { id, label, icon: Icon, badge } = item;
  const here = route === id;
  const lit = open && boards.some((b) => b.id === current); // a child carries the highlight
  const listId = `nav-${id}-boards`;
  return (
    <div>
      <div className={cn('flex items-center rounded-full', here ? (lit ? 'bg-white/10 font-semibold text-white' : 'chip-on') : 'dim hover:bg-white/10 hover:text-white')}>
        <a href={`#/${id}`} aria-current={here && !lit ? 'page' : undefined} className="flex min-w-0 flex-1 items-center gap-3 rounded-full py-2.5 pl-3.5 pr-1">
          <Icon className="h-[18px] w-[18px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {badge && <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', here && !lit ? 'bg-[#1a2340]/10' : 'bg-white/20')}>{badge}</span>}
        </a>
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={listId} aria-label={`${open ? 'Hide' : 'Show'} ${label} ${id === 'team' ? 'people' : 'boards'}`}
          className={cn('mr-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-full', here && !lit ? 'hover:bg-[#1a2340]/10' : 'hover:bg-white/15')}>
          <ChevronDown className={cn('h-4 w-4 transition-transform', !open && '-rotate-90')} />
        </button>
      </div>
      <ul id={listId} hidden={!open} className={cn('ml-[23px] my-1 flex-col gap-0.5 border-l border-white/15 pl-2 text-[13px]', open ? 'flex' : 'hidden')}>
        {boards.map((b) => {
          const on = b.id === current;
          return (
            <li key={b.id}>
              <a href={b.href} title={b.title} aria-current={on ? 'page' : undefined}
                className={cn('block truncate rounded-full px-3 py-1.5', on ? 'chip-on font-semibold' : 'dim hover:bg-white/10 hover:text-white')}>{b.title}</a>
            </li>
          );
        })}
        {onNew && (
          <li>
            <button type="button" onClick={onNew} className="flex w-full items-center gap-2 rounded-full px-3 py-1.5 text-left dimmer hover:bg-white/10 hover:text-white">
              <Plus className="h-3.5 w-3.5 shrink-0" />New board
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

export default function Sidebar({ route, sub }) {
  const [collapsed, setCollapsed] = useState(false);
  const nav = useNav();
  const { lists, current, isAdmin } = useBoardNav(route, sub);
  // Which board sections are open: the current module's, plus whatever was toggled; going into a module opens it.
  const [open, setOpen] = useState(() => ({ [route]: true }));
  useEffect(() => { if (SECTIONS.includes(route)) setOpen((o) => (o[route] ? o : { ...o, [route]: true })); }, [route]);
  const [adding, setAdding] = useState(null); // module getting a new board

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
        {nav.map((item) => {
          const { id, label, icon: Icon, badge } = item;
          if (!collapsed && SECTIONS.includes(id)) {
            return (
              <BoardSection key={id} item={item} route={route} boards={lists[id]} current={current} open={!!open[id]}
                onToggle={() => setOpen((o) => ({ ...o, [id]: !o[id] }))} onNew={isAdmin && id !== 'team' ? () => setAdding(id) : undefined} />
            );
          }
          return (
            <a key={id} href={`#/${id}`} aria-current={route === id ? 'page' : undefined} title={collapsed ? label : undefined}
              className={cn('flex items-center gap-3 rounded-full px-3.5 py-2.5', route === id ? 'chip-on' : 'dim hover:bg-white/10 hover:text-white')}>
              <Icon className="h-[18px] w-[18px] shrink-0" />
              {!collapsed && <span className="flex-1">{label}</span>}
              {!collapsed && badge && <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', route === id ? 'bg-[#1a2340]/10' : 'bg-white/20')}>{badge}</span>}
            </a>
          );
        })}
      </nav>
      {adding && <NewBoardModal module={adding} onClose={() => setAdding(null)} />}

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

export function MobileNav({ route, sub }) {
  const nav = useNav();
  const { lists, current, isAdmin } = useBoardNav(route, sub);
  const boards = SECTIONS.includes(route) ? lists[route] : null;
  const label = nav.find((n) => n.id === route)?.label;
  const [adding, setAdding] = useState(false);
  // Keep the current board's chip in view in its scrolling row.
  const row = useRef(null);
  useEffect(() => {
    const el = row.current?.querySelector('[aria-current="page"]');
    const r = row.current;
    if (!el || !r) return;
    if (el.offsetLeft < r.scrollLeft || el.offsetLeft + el.offsetWidth > r.scrollLeft + r.clientWidth) r.scrollLeft = Math.max(0, el.offsetLeft - 16);
  }, [route, current]);
  return (
    <div className="glass md:hidden sticky top-0 z-20 rounded-b-[24px] px-4 py-3">
      <div className="flex items-center gap-2">
        <nav className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto text-[13px]">
          {nav.map(({ id, label: l }) => (
            <a key={id} href={`#/${id}`} aria-current={route === id && !boards?.some((b) => b.id === current) ? 'page' : undefined}
              className={cn('whitespace-nowrap rounded-full px-3 py-1.5', route === id ? 'chip-on font-semibold' : 'chip')}>{l}</a>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1 dim">
          <SyncDot className="mx-1" />
          <ResetDemo />
          <AccountMenu showName={false} align="right" />
        </div>
      </div>
      {boards && (
        <nav ref={row} aria-label={`${label} ${route === 'team' ? 'people' : 'boards'}`} className="relative mt-2 flex gap-1.5 overflow-x-auto text-[12.5px]">
          {boards.map((b) => (
            <a key={b.id} href={b.href} aria-current={b.id === current ? 'page' : undefined}
              className={cn('max-w-[220px] shrink-0 truncate whitespace-nowrap rounded-full px-3 py-1', b.id === current ? 'chip-on font-semibold' : 'chip')}>{b.title}</a>
          ))}
          {isAdmin && route !== 'team' && (
            <button type="button" onClick={() => setAdding(true)} aria-label="New board" title="New board"
              className="grid h-[28px] w-[28px] shrink-0 place-items-center rounded-full chip"><Plus className="h-3.5 w-3.5" /></button>
          )}
        </nav>
      )}
      {adding && boards && route !== 'team' && <NewBoardModal module={route} onClose={() => setAdding(false)} />}
    </div>
  );
}
