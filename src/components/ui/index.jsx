import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Search, User, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore, useUsers } from '@/data/store';

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

/** Popover rendered in a portal with fixed positioning, so table scroll containers can't clip it. */
export function Popover({ anchor, open, onClose, children, width = 200, align = 'center' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const r = anchor.getBoundingClientRect();
    let left = align === 'center' ? r.left + r.width / 2 - width / 2 : align === 'right' ? r.right - width : r.left;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    const below = r.bottom + 6;
    const top = below + 260 > window.innerHeight ? Math.max(12, r.top - 6 - 260) : below;
    setPos({ left, top });
  }, [open, anchor, width, align]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && !anchor?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, onClose, anchor]);
  if (!open || !pos) return null;
  return createPortal(
    <div ref={ref} className="glass-dark fixed z-[80] rounded-2xl p-2" style={{ left: pos.left, top: pos.top, width }}>
      {children}
    </div>,
    document.body,
  );
}

/** Monday-style coloured cell; click to pick a value. */
export function LabelPicker({ value, options, onChange, className, allowEmpty = true }) {
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  const color = value ? options[value] : null;
  return (
    <>
      <button
        type="button"
        ref={setAnchor}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={cn('pill w-full', !value && 'pill-empty', className)}
        style={color ? { backgroundColor: color } : undefined}
        aria-haspopup="listbox"
      >
        {value || ' '}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={180}>
        <div role="listbox" className="flex flex-col gap-1.5">
          {Object.entries(options).map(([label, c]) => (
            <button key={label} type="button" className="pill" style={{ backgroundColor: c }} onClick={() => { onChange(label); setOpen(false); }}>
              {label}
            </button>
          ))}
          {allowEmpty && (
            <button type="button" className="pill pill-empty dim" onClick={() => { onChange(''); setOpen(false); }}>Clear</button>
          )}
        </div>
      </Popover>
    </>
  );
}

export function PersonPicker({ value, onChange, size = 28 }) {
  const { state } = useStore();
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" ref={setAnchor} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} aria-label="Change owner" className="rounded-full">
        <Avatar userId={value} size={size} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={190}>
        <div className="flex flex-col">
          {state.users.map((u) => (
            <button key={u.id} type="button" onClick={() => { onChange(u.id); setOpen(false); }}
              className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', value === u.id && 'bg-white/15')}>
              <Avatar userId={u.id} size={24} ring={false} />{u.name}
            </button>
          ))}
          <button type="button" onClick={() => { onChange(''); setOpen(false); }} className="rounded-xl px-2 py-1.5 text-left dimmer hover:bg-white/10">Unassigned</button>
        </div>
      </Popover>
    </>
  );
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-full chip p-1 text-[13px]">
      {options.map(({ id, icon: Icon, label: l }) => (
        <button key={id} role="tab" aria-selected={value === id} type="button" onClick={() => onChange(id)}
          className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5', value === id ? 'chip-on font-semibold' : 'dim')}>
          {Icon && <Icon className="h-4 w-4" />}<span className={cn(Icon && 'hidden sm:inline')}>{l}</span>
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
      <h1 className="page-title text-[34px] md:text-[44px] leading-none">{title}</h1>
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

export function Drawer({ open, onClose, title, children, width = 520 }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/30 no-print" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={title}
        className="glass-dark print-area absolute right-3 top-3 bottom-3 flex flex-col rounded-[28px] overflow-hidden"
        style={{ width: `min(${width}px, calc(100vw - 24px))` }}>
        <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 no-print">
          <h2 className="text-[20px] font-extrabold truncate">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full chip"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin px-6 pb-6">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

export function Modal({ open, onClose, title, children, width = 440 }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={title} className="glass-dark relative rounded-[26px] p-6" style={{ width: `min(${width}px, 100%)` }}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[18px] font-extrabold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full chip"><X className="h-4 w-4" /></button>
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
