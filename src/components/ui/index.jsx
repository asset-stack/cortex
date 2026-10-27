import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isOpenDeal } from '@/lib/accounts';
import { createPortal } from 'react-dom';
import { Check, Plus, Search, User, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore, useUsers } from '@/data/store';
import { canEditBoard } from '@/lib/access';

export function Avatar({ userId, size = 28, ring = true, className }) {
  const users = useUsers();
  const u = users[userId];
  if (!u) {
    return (
      <span className={cn('inline-grid place-items-center rounded-full border border-dashed border-white/50 dimmer shrink-0', className)} style={{ width: size, height: size }}>
        <User className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span
      title={u.name}
      className={cn('inline-grid place-items-center rounded-full font-bold text-white shrink-0', ring && 'ring-2 ring-white/40', className)}
      style={{ width: size, height: size, background: u.color, fontSize: size * 0.38 }}
    >
      {u.initials}
    </span>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const focusAnchor = (anchor) => (anchor?.matches?.(FOCUSABLE) ? anchor : anchor?.querySelector?.(FOCUSABLE))?.focus({ preventScroll: true });

// A popover taller than the window scrolls: keep the option keyboard focus moved to inside its visible part (the page
// itself never scrolls for it: focus uses preventScroll).
function reveal(box, el) {
  if (!box || !el) return;
  const a = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (a.bottom > b.bottom) box.scrollTop += a.bottom - b.bottom + 8;
  else if (a.top < b.top) box.scrollTop -= b.top - a.top + 8;
}

/** Popover rendered in a portal with fixed positioning, so table scroll containers can't clip it.
 *  Inside a Drawer/Modal it portals into that dialog, so it stays in the aria-modal subtree. */
export function Popover({ anchor, open, onClose, children, width = 200, align = 'center' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  // Uses the real height to flip above the anchor, and follows the anchor on scroll and resize.
  useLayoutEffect(() => {
    if (!open || !anchor) { setPos(null); return; }
    const update = () => {
      const r = anchor.getBoundingClientRect();
      const max = window.innerHeight - 24; // taller than the window: it scrolls
      if (ref.current) ref.current.style.maxHeight = `${max}px`; // measured at this window's cap, not the last one
      const h = ref.current?.offsetHeight || 0;
      let left = align === 'center' ? r.left + r.width / 2 - width / 2 : align === 'right' ? r.right - width : r.left;
      left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
      const below = r.bottom + 6;
      const top = below + h + 12 > window.innerHeight ? Math.max(12, r.top - 6 - h) : below;
      setPos({ left, top, max });
    };
    update();
    const onScroll = (e) => { if (!ref.current?.contains(e.target)) update(); };
    window.addEventListener('scroll', onScroll, true); // capture: also catches <main>, drawer bodies and table scrollers
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', update); };
  }, [open, anchor, width, align]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && !anchor?.contains(e.target)) onClose(); };
    // Capture phase + preventDefault: Escape closes only this popover, not the Drawer/Modal under it.
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open, onClose, anchor]);
  // Focus the current (or first) option once placed; if the popover closes with focus inside it
  // (a pick, Escape), hand focus back to the anchor instead of dropping it to <body>.
  const placed = !!pos;
  useEffect(() => {
    if (!open || !placed) return;
    const el = ref.current;
    const first = el?.querySelector('[aria-selected="true"], [aria-pressed="true"]') || el?.querySelector(FOCUSABLE);
    first?.focus({ preventScroll: true });
    reveal(el, first);
    return () => { if (!document.activeElement || document.activeElement === document.body) focusAnchor(anchor); };
  }, [open, placed, anchor]);
  // Arrow keys, Home and End move between options; Tab closes and carries on from the anchor.
  const onKeyDown = (e) => {
    const items = [...ref.current.querySelectorAll(FOCUSABLE)];
    const i = items.indexOf(document.activeElement);
    const move = (k) => {
      e.preventDefault();
      const to = items[(k + items.length) % items.length];
      to?.focus({ preventScroll: true });
      reveal(ref.current, to);
    };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(-1);
    else if (e.key === 'Tab') { focusAnchor(anchor); onClose(); }
  };
  if (!open) return null;
  return createPortal(
    <div ref={ref} onKeyDown={onKeyDown} className="glass-dark fixed z-[80] overflow-y-auto overscroll-contain rounded-2xl p-2 scroll-thin"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width, maxHeight: pos?.max, visibility: pos ? 'visible' : 'hidden' }}>
      {children}
    </div>,
    anchor?.closest?.('[role="dialog"]') || document.body,
  );
}

/** Monday-style coloured cell; click to pick a value. `label` names the field for screen readers. `hints`: what each
 *  option means (Priority's), shown under it in the list and as the cell's tooltip. `readOnly` shows the same pill
 *  without the picker (view access). `labels`: what each option is called when that isn't its value (Department's
 *  module keys); `muted`: shown without its colour (a value that is only the default). */
export function LabelPicker({ value, options, onChange, className, allowEmpty = true, label, hints, placeholder = '', readOnly = false, labels, muted = false }) {
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  const color = value && !muted ? options[value] : null;
  const hint = (value && hints?.[value]) || undefined;
  const text = (v) => labels?.[v] ?? v; // `labels`: what an option is called, when it isn't its value (Department)
  const shown = value ? text(value) : '';
  if (readOnly) {
    return (
      <span className={cn('pill w-full', (!value || muted) && 'pill-empty', className)} style={color ? { backgroundColor: color } : undefined} title={hint}>
        {label && <span className="sr-only">{label}: </span>}{shown || <span className="sr-only">Not set</span>}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        ref={setAnchor}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={cn('pill w-full', (!value || muted) && 'pill-empty', className)}
        style={color ? { backgroundColor: color } : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label ? `${label}: ${shown || 'Not set'}` : (shown || 'Not set')}
        title={hint}
      >
        {shown || placeholder || ' '}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={hints ? 220 : 180}>
        <div role="listbox" aria-label={label} className="flex flex-col gap-1.5">
          {Object.entries(options).map(([opt, c]) => (hints?.[opt] ? (
            <button key={opt} type="button" role="option" aria-selected={opt === value} onClick={() => { onChange(opt); setOpen(false); }}
              className={cn('flex flex-col gap-1 rounded-[14px] p-1 text-left hover:bg-white/10', opt === value && 'bg-white/15')}>
              <span className="pill w-full" style={{ backgroundColor: c }}>{text(opt)}</span>
              <span className="px-1.5 text-[11.5px] leading-snug dim">{hints[opt]}</span>
            </button>
          ) : (
            <button key={opt} type="button" role="option" aria-selected={opt === value} className="pill" style={{ backgroundColor: c }} onClick={() => { onChange(opt); setOpen(false); }}>
              {text(opt)}
            </button>
          )))}
          {allowEmpty && (
            <button type="button" role="option" aria-selected={false} className="pill pill-empty dim" onClick={() => { onChange(''); setOpen(false); }}>Clear</button>
          )}
        </div>
      </Popover>
    </>
  );
}

/** Single owner (deals, clients, contacts). `readOnly` shows just the avatar (view access). */
export function PersonPicker({ value, onChange, size = 28, readOnly = false }) {
  const { state } = useStore();
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  const owner = state.users.find((u) => u.id === value);
  const people = state.users.filter((u) => u.active !== false || u.id === value); // deactivated staff can't be picked
  if (readOnly) {
    return (
      <span className="inline-flex rounded-full">
        <Avatar userId={value} size={size} /><span className="sr-only">Owner: {owner?.name || 'Unassigned'}</span>
      </span>
    );
  }
  return (
    <>
      <button type="button" ref={setAnchor} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-label={`Owner: ${owner?.name || 'Unassigned'}. Change owner`} aria-haspopup="true" aria-expanded={open} className="rounded-full">
        <Avatar userId={value} size={size} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={190}>
        <div className="flex flex-col">
          {people.map((u) => (
            <button key={u.id} type="button" aria-pressed={value === u.id} onClick={() => { onChange(u.id); setOpen(false); }}
              className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', value === u.id && 'bg-white/15')}>
              <Avatar userId={u.id} size={24} ring={false} />{u.name}
            </button>
          ))}
          <button type="button" aria-pressed={!value} onClick={() => { onChange(''); setOpen(false); }} className="rounded-xl px-2 py-1.5 text-left dimmer hover:bg-white/10">Unassigned</button>
        </div>
      </Popover>
    </>
  );
}

/** Overlapping avatars for a list of user ids, with a +N chip past `max`. Not interactive (safe inside a card button).
 *  Unknown ids are skipped; nobody shows the dashed placeholder. */
export function AvatarStack({ userIds, size = 28, max = 3, label, className, empty = 'Unassigned' }) {
  const users = useUsers();
  const ids = [...new Set(Array.isArray(userIds) ? userIds : [])].filter((id) => users[id]);
  const shown = ids.length > max ? ids.slice(0, Math.max(1, max - 1)) : ids;
  const extra = ids.length - shown.length;
  const names = ids.map((id) => users[id].name).join(', ') || empty;
  return (
    <span className={cn('inline-flex items-center', className)}>
      <span aria-hidden="true" className="inline-flex items-center">
        {ids.length === 0 && <Avatar userId="" size={size} />}
        {shown.map((id, k) => <Avatar key={id} userId={id} size={size} className={k ? '-ml-2' : undefined} />)}
        {extra > 0 && (
          <span title={ids.slice(shown.length).map((id) => users[id].name).join(', ')}
            className="chip-on -ml-2 inline-grid place-items-center rounded-full font-bold tnum ring-2 ring-white/40 shrink-0"
            style={{ width: size, height: size, fontSize: size * 0.36 }}>+{extra}</span>
        )}
      </span>
      <span className="sr-only">{label ? `${label}: ${names}` : names}</span>
    </span>
  );
}

/** Multi-person picker (the boards' people column, Also on): an avatar stack that opens a list of toggles. Only active
 *  people can be added (`allow`: only these ids, e.g. who can see the board); someone already in `value` stays listed so
 *  they can be taken off. `empty`: what nobody reads as. `onChange(ids)`.
 *  Keyboard: Enter/Space opens, arrows/Home/End move, Enter/Space toggles, Escape or Tab closes. */
export function PeoplePicker({ value, onChange, size = 28, max = 3, label = 'People', readOnly = false, allow, empty = 'Unassigned' }) {
  const { state } = useStore();
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  const [listed, setListed] = useState([]); // who was on it when opened, so a removed inactive person keeps their row
  const ids = Array.isArray(value) ? value : [];
  if (readOnly) return <AvatarStack userIds={ids} size={size} max={max} label={label} empty={empty} />;
  const names = ids.map((id) => state.users.find((u) => u.id === id)?.name).filter(Boolean).join(', ');
  const people = state.users.filter((u) => (allow ? allow.includes(u.id) : u.active !== false) || ids.includes(u.id) || listed.includes(u.id));
  const toggle = (id) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <>
      <button type="button" ref={setAnchor} onClick={(e) => { e.stopPropagation(); if (!open) setListed(ids); setOpen((o) => !o); }}
        aria-label={`${label}: ${names || empty}. Change people`} aria-haspopup="true" aria-expanded={open} className="rounded-full">
        <AvatarStack userIds={ids} size={size} max={max} empty={empty} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={210}>
        <div role="group" aria-label={label} className="flex flex-col">
          {people.map((u) => {
            const on = ids.includes(u.id);
            const inactive = u.active === false;
            return (
              <button key={u.id} type="button" aria-pressed={on} onClick={() => toggle(u.id)}
                className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', on && 'bg-white/15')}>
                <Avatar userId={u.id} size={24} ring={false} />
                <span className={cn('min-w-0 flex-1 truncate', inactive && 'dimmer')}>{u.name}</span>
                {inactive && <span className="text-[11px] dimmer">Inactive</span>}
                <Check className={cn('h-4 w-4 shrink-0', !on && 'invisible')} aria-hidden="true" />
              </button>
            );
          })}
          {ids.length > 0 && (
            <button type="button" onClick={() => { onChange([]); setOpen(false); }} className="rounded-xl px-2 py-1.5 text-left dimmer hover:bg-white/10">Clear</button>
          )}
        </div>
      </Popover>
    </>
  );
}

/** A board task's Owner (the owner column): one person, kept as `values.people` = [id]. A task that still has several
 *  people shows the first and +N until someone picks one. Only active people who can edit `board` are offered: an owner
 *  must be able to update their task (a task handed to someone who can't would be in nobody's Priorities); its current
 *  owner stays listed. `onChange(id)` ('' for Unassigned). */
export function OwnerPicker({ value, onChange, board, size = 28, label = 'Owner', readOnly = false }) {
  const { state } = useStore();
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  const ids = Array.isArray(value) ? value : [];
  if (readOnly) return <AvatarStack userIds={ids} size={size} max={1} label={label} />;
  const names = ids.map((id) => state.users.find((u) => u.id === id)?.name).filter(Boolean).join(', ');
  const owner = ids.length === 1 ? ids[0] : ''; // with several people, nobody is ticked: picking one makes them the owner
  const people = state.users.filter((u) => u.id === owner || (u.active !== false && (!board || canEditBoard(state, board, u.id))));
  return (
    <>
      <button type="button" ref={setAnchor} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-label={`${label}: ${names || 'Unassigned'}. Change owner`} aria-haspopup="true" aria-expanded={open} className="rounded-full">
        <AvatarStack userIds={ids} size={size} max={1} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={200}>
        <div role="group" aria-label={label} className="flex flex-col">
          {people.map((u) => (
            <button key={u.id} type="button" aria-pressed={owner === u.id} onClick={() => { onChange(u.id); setOpen(false); }}
              className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', owner === u.id && 'bg-white/15')}>
              <Avatar userId={u.id} size={24} ring={false} />
              <span className={cn('min-w-0 flex-1 truncate', u.active === false && 'dimmer')}>{u.name}</span>
              {u.active === false && <span className="text-[11px] dimmer">Inactive</span>}
            </button>
          ))}
          <button type="button" aria-pressed={!ids.length} onClick={() => { onChange(''); setOpen(false); }} className="rounded-xl px-2 py-1.5 text-left dimmer hover:bg-white/10">Unassigned</button>
        </div>
      </Popover>
    </>
  );
}

/** Which client a task is for (Clients boards' Client column): a list of the clients by name. `readOnly` shows the
 *  name. A client that has been deleted shows as none. */
export function ClientPicker({ value, onChange, label = 'Client', className, readOnly = false }) {
  const { state } = useStore();
  const clients = [...(state.clients || [])].sort((a, b) => a.name.localeCompare(b.name));
  const current = clients.find((c) => c.id === value);
  if (readOnly) {
    return <span className={cn('block truncate py-1.5', !current && 'dimmer', className)}><span className="sr-only">{label}: </span>{current?.name || '—'}</span>;
  }
  return (
    <select value={current ? value : ''} aria-label={label} onChange={(e) => onChange(e.target.value)} onClick={(e) => e.stopPropagation()}
      className={cn('field !py-1.5 truncate', className)}>
      <option value="">No client</option>
      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

/** Which deal a task is a next step on (Outreach boards' Deal column): the open deals by name (and the one it's on, if
 *  that's been made a client). `readOnly` shows the name. */
export function DealPicker({ value, onChange, label = 'Deal', className, readOnly = false }) {
  const { state } = useStore();
  const deals = (state.deals || []).filter((d) => isOpenDeal(d) || d.id === value).sort((a, b) => a.name.localeCompare(b.name)); // not made a client or lost
  const current = deals.find((d) => d.id === value);
  if (readOnly) {
    return <span className={cn('block truncate py-1.5', !current && 'dimmer', className)}><span className="sr-only">{label}: </span>{current?.name || '—'}</span>;
  }
  return (
    <select value={current ? value : ''} aria-label={label} onChange={(e) => onChange(e.target.value)} onClick={(e) => e.stopPropagation()}
      className={cn('field !py-1.5 truncate', className)}>
      <option value="">No deal</option>
      {deals.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );
}

/** Toggle-button group (not tabs: there are no tab panels or arrow-key roving). */
export function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full chip p-1 text-[13px]">
      {options.map(({ id, icon: Icon, label: l }) => (
        <button key={id} type="button" aria-pressed={value === id} aria-label={l} title={Icon ? l : undefined} onClick={() => onChange(id)}
          className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5', value === id ? 'chip-on font-semibold' : 'dim')}>
          {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}<span className={cn(Icon && 'hidden sm:inline')}>{l}</span>
        </button>
      ))}
    </div>
  );
}

export function IconButton({ icon: Icon, label, onClick, active, className }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className={cn('grid h-10 w-10 place-items-center rounded-full shrink-0', active ? 'chip-on' : 'chip', className)}>
      <Icon className="h-4 w-4" />
    </button>
  );
}

export function SearchField({ value, onChange, placeholder = 'Search' }) {
  return (
    <label className="flex flex-1 min-w-[160px] items-center gap-2 rounded-full chip px-4 h-10">
      <Search className="h-4 w-4 dim shrink-0" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="w-full bg-transparent outline-none" />
      {value && <button type="button" onClick={() => onChange('')} aria-label="Clear search"><X className="h-4 w-4 dim" /></button>}
    </label>
  );
}

export function PageHeader({ title, action, onAction }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 tabIndex={-1} className="page-title text-[34px] md:text-[44px] leading-none outline-none">{title}</h1>
      {action && (
        <button type="button" onClick={onAction} className="btn-primary inline-flex items-center gap-2 rounded-full px-5 h-11 font-semibold shrink-0">
          <Plus className="h-4 w-4" />{action}
        </button>
      )}
    </div>
  );
}

export function KpiRow({ items }) {
  return (
    <div className="mt-7 grid grid-cols-2 lg:grid-cols-4 gap-4">
      {items.map(({ value, label, tint }) => (
        <div key={label} className="glass glass-rim float rounded-[24px] p-5" style={{ background: `linear-gradient(155deg, ${tint}99, ${tint}33)` }}>
          <div className="text-[30px] font-black tracking-[-0.03em] leading-none tnum">{value}</div>
          <div className="mt-2 text-[13px] dim">{label}</div>
        </div>
      ))}
    </div>
  );
}

// Dialog focus: remember the trigger, make the page behind (#root) inert, focus the panel unless a
// child autoFocused, and give focus back to the trigger when the dialog closes. #root rather than a
// Tab trap, so popovers portalled next to the panel stay reachable. Open dialog shells stack (oldest
// first): every one under the top is inert too, so Tab can't leave a Modal opened over a Drawer.
const shells = [];
function syncInert() {
  document.getElementById('root')?.toggleAttribute('inert', shells.length > 0);
  shells.forEach((el, i) => el?.toggleAttribute('inert', i < shells.length - 1));
}
// Escape closes only the topmost Drawer / Modal (a Modal opened over a Drawer closes alone). Popovers handle Escape
// first (capture phase + preventDefault), so an open popover closes before any dialog under it.
const layers = [];
function onLayerKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || !layers.length) return;
  e.preventDefault();
  layers[layers.length - 1].current();
}
function useEscapeLayer(open, onClose) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    layers.push(close);
    if (layers.length === 1) document.addEventListener('keydown', onLayerKey);
    return () => {
      const i = layers.indexOf(close);
      if (i >= 0) layers.splice(i, 1);
      if (!layers.length) document.removeEventListener('keydown', onLayerKey);
    };
  }, [open]);
}

function useDialogFocus(open, panelRef) {
  const returnTo = useRef(null);
  // Captured during render: a child's autoFocus runs before this component's effects.
  if (open && !returnTo.current) returnTo.current = document.activeElement;
  if (!open) returnTo.current = null;
  useEffect(() => {
    if (!open) return;
    const prev = returnTo.current;
    const panel = panelRef.current;
    const shell = panel?.parentElement || null;
    shells.push(shell);
    syncInert();
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    return () => {
      // Un-inert the dialog underneath before handing focus back into it.
      shells.splice(shells.lastIndexOf(shell), 1);
      syncInert();
      // Only when focus went away with the dialog (not on StrictMode's effect re-run).
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && prev?.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function Drawer({ open, onClose, title, children, width = 520 }) {
  const panel = useRef(null);
  useDialogFocus(open, panel);
  useEscapeLayer(open, onClose);
  if (!open) return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} className="drawer-shell fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/30 no-print" aria-hidden="true" onClick={onClose} />
      <aside ref={panel} tabIndex={-1}
        className="drawer-panel glass-dark absolute right-3 top-3 bottom-3 flex flex-col rounded-[28px] overflow-hidden"
        style={{ width: `min(${width}px, calc(100vw - 24px))` }}>
        <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 no-print">
          <h2 className="text-[20px] font-extrabold truncate">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full chip"><X className="h-4 w-4" /></button>
        </div>
        <div className="drawer-body flex-1 overflow-y-auto scroll-thin px-6 pb-6">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

/** `closable={false}` while something is in flight: Escape, the backdrop and X do nothing (X shows disabled). */
export function Modal({ open, onClose, title, children, width = 440, closable = true }) {
  const panel = useRef(null);
  const close = closable ? onClose : () => {};
  useDialogFocus(open, panel);
  useEscapeLayer(open, close);
  if (!open) return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-[70] grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={close} />
      <div ref={panel} tabIndex={-1} className="glass-dark relative rounded-[26px] p-6" style={{ width: `min(${width}px, 100%)` }}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[18px] font-extrabold">{title}</h2>
          <button type="button" onClick={close} disabled={!closable} aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full chip disabled:cursor-not-allowed disabled:opacity-50"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Single-line input that submits on Enter. */
export function QuickAdd({ placeholder, onSubmit, className }) {
  const [v, setV] = useState('');
  return (
    <form className={cn('flex items-center gap-2', className)} onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onSubmit(v.trim()); setV(''); } }}>
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="field" />
      <button type="submit" aria-label="Add" className="grid h-10 w-10 shrink-0 place-items-center rounded-full chip"><Plus className="h-4 w-4" /></button>
    </form>
  );
}

/** Asks before deleting: `title` like "Delete Landing Page?", `children` an optional line on what else goes
 *  ("Its 3 tasks are deleted too."), then Cancel / Delete. `onConfirm` runs, then `onClose`. Escape closes only this
 *  dialog when it is opened over a Drawer. */
export function ConfirmModal({ open, onClose, onConfirm, title, children, action = 'Delete' }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {children && <p className="dim">{children}</p>}
      <div className={cn('flex justify-end gap-2', children && 'mt-4')}>
        <button type="button" onClick={onClose} className="rounded-full chip px-4 h-10 font-semibold">Cancel</button>
        <button type="button" onClick={() => { onConfirm(); onClose(); }}
          className="rounded-full bg-rose-600 px-4 h-10 font-semibold text-white hover:bg-rose-700">{action}</button>
      </div>
    </Modal>
  );
}

/** Rename in place (focused, text selected): Enter or leaving the field saves, Escape cancels; a blank or unchanged
 *  name saves nothing. `onSave(trimmed)`, then `onDone(byKey)`: true after Enter/Escape, so the caller can put focus
 *  back on what it renamed. Escape doesn't reach a Drawer underneath. */
export function InlineRename({ value, label, onSave, onDone, className }) {
  const start = String(value ?? '');
  const [v, setV] = useState(start);
  const done = useRef(false); // Enter/Escape then the blur from unmounting: finish once
  const finish = (save, byKey) => {
    if (done.current) return;
    done.current = true;
    const t = v.trim();
    if (save && t && t !== start.trim()) onSave(t);
    onDone(byKey);
  };
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} aria-label={label} autoFocus onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
      }}
      onBlur={() => finish(true, false)}
      className={cn('field', className)} />
  );
}
