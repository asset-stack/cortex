// Pieces the Clients tabs share: invoice status groups, totals, small inputs and the finance file link.
import { useState } from 'react';
import { ChevronLeft, ChevronRight, Paperclip } from 'lucide-react';
import { useStore } from '@/data/store';
import { INVOICE_STATUS } from '@/data/boards';
import { addMonths } from '@/lib/automations';
import { invoiceTotals, isBadAmount, monthLabel, owingOn, parseAmount } from '@/lib/format';
import { cn } from '@/lib/cn';

// Links typed by people (demo, platform, a Doc): src/lib/format.js.
export { safeUrl } from '@/lib/format';

// Not issued yet (no date that counts, nothing owed); issued and waiting to be paid; and the statuses only admins set.
export const UNISSUED = ['Draft', 'Awaiting approval'];
export const OPEN = ['Approved', 'Sent', 'Overdue'];
export const ADMIN_STATUSES = ['Approved', 'Sent', 'Paid', 'Void'];

// Status as light text on glass (side lists).
export const STATUS_TEXT = {
  Draft: '#e2e8f0', 'Awaiting approval': '#fde68a', Approved: '#e9d5ff', Sent: '#bae6fd', Paid: '#86efac', Overdue: '#fecdd3', Void: '#cbd5e1',
};

const desc = (a, b) => String(b || '').localeCompare(String(a || ''));

// Every invoice with its client: Awaiting approval first, then newest first.
export function invoicesOf(clients) {
  const rank = (s) => (s === 'Awaiting approval' ? 0 : 1);
  return clients.flatMap((c) => c.invoices.map((inv) => ({ c, inv })))
    .sort((a, b) => rank(a.inv.status) - rank(b.inv.status) || desc(a.inv.issued, b.inv.issued) || desc(a.inv.number, b.inv.number));
}

// Owed (issued, less `payments`: pass [] for staff, who never see money in), overdue, paid in total, and how many await
// approval.
export function owedTotals(clients, payments) {
  let outstanding = 0, overdue = 0, paid = 0, awaiting = 0;
  clients.forEach((c) => c.invoices.forEach((i) => {
    if (OPEN.includes(i.status)) {
      const o = owingOn(i, payments);
      outstanding += o;
      if (i.status === 'Overdue') overdue += o;
    }
    if (i.status === 'Paid') paid += invoiceTotals(i).total;
    if (i.status === 'Awaiting approval') awaiting += 1;
  }));
  return { outstanding, overdue, paid, awaiting };
}

// An amount that doesn't parse counts as $0, so the printed copy would contradict its own totals.
export const hasBadAmounts = (inv) => inv.lines.some((l) => isBadAmount(l.qty) || isBadAmount(l.rate));

export function StatusPill({ status, className }) {
  return <span className={cn('pill !h-6 !text-[12px] shrink-0', className)} style={{ backgroundColor: INVOICE_STATUS[status] || '#5c6370' }}>{status}</span>;
}

/** A titled glass panel (same header as the Dashboard's lists). `action` sits at the right of the title. */
export function Panel({ title, icon: Icon, count, action, rim, className, children }) {
  return (
    <section aria-label={title} className={cn('glass min-w-0 rounded-[24px]', rim && 'glass-rim', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-3 pt-4">
        <h2 className="flex items-center gap-2 font-extrabold text-[16px]">
          {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}{title}
          {count !== undefined && <span className="text-[12px] font-semibold dimmer tnum">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative h-7 w-12 shrink-0 rounded-full border border-white/25 transition-colors disabled:opacity-50', checked ? 'bg-emerald-400/70' : 'bg-white/10')}>
      <span className={cn('absolute top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow transition-[left]', checked ? 'left-[22px]' : 'left-[2px]')} />
    </button>
  );
}

/** A number box that keeps what is typed ('12.' or an emptied box) and saves on blur or Enter: `onCommit(number)`.
 *  Blank or unparseable goes back to the saved value. Shown through `format` when not being edited. `readOnly` for
 *  view access. */
export function NumField({ value, onCommit, readOnly = false, decimal = false, format, className, ...props }) {
  const saved = value === '' || value === null || value === undefined ? '' : String(value);
  const [text, setText] = useState(null); // what is typed while focused; null shows the saved value
  const shown = saved !== '' && format ? format(Number(saved)) : saved;
  const commit = () => {
    if (text === null) return;
    const n = parseAmount(text);
    setText(null);
    if (text.trim() === '' || !Number.isFinite(n)) return;
    if (String(n) !== saved) onCommit(n);
  };
  return (
    <input className={cn('field tnum', className)} inputMode={decimal ? 'decimal' : 'numeric'} autoComplete="off" readOnly={readOnly}
      value={readOnly || text === null ? shown : text}
      onFocus={readOnly ? undefined : () => setText(saved)}
      onChange={(e) => setText(e.target.value)}
      onBlur={readOnly ? undefined : commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      {...props} />
  );
}

// Money in a NumField: 2,400.00.
export const moneyField = (n) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ‹ Oct 2026 › for a 'YYYY-MM-01' month. */
export function MonthNav({ month, onChange }) {
  return (
    <div role="group" aria-label="Month" className="inline-flex items-center gap-0.5 rounded-full chip p-1 text-[13px]">
      <button type="button" onClick={() => onChange(addMonths(month, -1))} aria-label="Previous month" title="Previous month"
        className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"><ChevronLeft className="h-4 w-4" /></button>
      <span className="min-w-[88px] px-1 text-center font-semibold tnum" aria-live="polite">{monthLabel(month)}</span>
      <button type="button" onClick={() => onChange(addMonths(month, 1))} aria-label="Next month" title="Next month"
        className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"><ChevronRight className="h-4 w-4" /></button>
    </div>
  );
}

// Browsers won't open a data: URL in a tab (demo files are data URLs), so it goes as a blob URL instead. Decoded by
// hand rather than fetched, which the CSP's connect-src would refuse.
function openable(url) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  if (!m) return url;
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const href = URL.createObjectURL(new Blob([bytes], { type: m[1] || 'application/octet-stream' }));
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  return href;
}

/** View a bank screenshot or receipt (admins) in a new tab. The tab opens on the click, because the pop-up allowance
 *  doesn't last through the wait for the short-lived link, and then goes to the file. */
export function FileLink({ path, label = 'View' }) {
  const { actions } = useStore();
  const [note, setNote] = useState(''); // '' | 'busy' | 'missing' | 'blocked'
  if (!path) return <span className="dimmer" aria-label="No file">—</span>;
  const open = async () => {
    const tab = window.open('', '_blank');
    setNote('busy');
    let url = '';
    try { url = await actions.fileUrl(path); } catch { url = ''; }
    try { url = url ? openable(url) : ''; } catch { url = ''; }
    if (!url) { tab?.close(); setNote('missing'); return; }
    if (!tab) { setNote('blocked'); return; }
    tab.opener = null;
    tab.location.replace(url);
    setNote('');
  };
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={open} disabled={note === 'busy'}
        className="inline-flex items-center gap-1.5 rounded-full chip px-3 py-1 text-[12.5px] font-semibold disabled:opacity-60">
        <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />{label}
      </button>
      {(note === 'missing' || note === 'blocked') && (
        <span role="status" className="text-[12px] text-amber-200">{note === 'missing' ? 'File not available' : 'Pop-up blocked'}</span>
      )}
    </span>
  );
}

/** A labelled form control. */
export function Labelled({ label, className, children }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-[12px] dimmer">{label}</span>
      {children}
    </label>
  );
}

// File inputs styled like the glass fields.
export const FILE_INPUT = 'field !py-1.5 text-[13px] file:mr-3 file:rounded-full file:border-0 file:bg-white/20 file:px-3 file:py-1 file:font-semibold file:text-white';

// Forms in a Modal scroll inside it when the screen is short (a phone on its side).
export const MODAL_FORM = 'flex max-h-[calc(100dvh-8rem)] flex-col gap-3 overflow-y-auto scroll-thin -m-1 p-1';
