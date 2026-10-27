// Small pieces the CRM screens share (docs/PHASE2.md §22): pills for a deal's stage, an account's lifecycle and who a
// deal waits on, days in stage, the local time where someone is, and the pickers for time zones and accounts.
import { Clock } from 'lucide-react';
import { STALE_DAYS, WAITING_ON, daysInStage } from '@/data/boards';
import { ACCOUNT_KINDS, LIFECYCLES, TIMEZONES } from '@/lib/accounts';
import { zoneNow } from '@/lib/format';
import { cn } from '@/lib/cn';

export const PRIORITY_BG = { P1: 'bg-rose-500', P2: 'bg-amber-500', P3: 'bg-sky-500' };
const LIFECYCLE_BG = {
  new: 'bg-slate-500/60', contacted: 'bg-sky-600/70', engaged: 'bg-indigo-500/70', meeting: 'bg-violet-500/70', opportunity: 'bg-fuchsia-600/70',
  customer: 'bg-emerald-600/80', nurture: 'bg-amber-600/70', rfp: 'bg-teal-600/70', not_now: 'bg-slate-600/70', suppressed: 'bg-rose-700/70',
};

export const Pill = ({ className, children, title }) => (
  <span title={title} className={cn('inline-flex h-[22px] shrink-0 items-center rounded-full px-2 text-[11.5px] font-semibold', className)}>{children}</span>
);
export const LifecyclePill = ({ value }) => <Pill className={LIFECYCLE_BG[value] || LIFECYCLE_BG.new}>{LIFECYCLES[value] || LIFECYCLES.new}</Pill>;
export const KindPill = ({ value }) => <Pill className="chip">{ACCOUNT_KINDS[value] || ACCOUNT_KINDS.prospect}</Pill>;
/** Who the deal waits on, when set. */
export const WaitingPill = ({ value }) => (value in WAITING_ON
  ? <Pill className={value === 'us' ? 'bg-amber-500/80 text-black' : 'chip'} title={value === 'us' ? 'Waiting on us' : 'Waiting on them'}>
      <span className="sr-only">Waiting on </span>{value === 'us' ? 'On us' : 'On them'}
    </Pill>
  : null);

/** Days in its stage: amber from STALE_DAYS, red from twice that. */
export function DaysInStage({ deal, className }) {
  const days = daysInStage(deal);
  if (days === null) return null;
  const tone = days >= STALE_DAYS * 2 ? 'bg-rose-500/80' : days >= STALE_DAYS ? 'bg-amber-500/80 text-black' : 'chip';
  return <Pill className={cn(tone, 'tnum', className)} title={`${days} day${days === 1 ? '' : 's'} in this stage`}>{days}d<span className="sr-only"> in this stage</span></Pill>;
}

/** The time now where someone is ("Tue 9:30 am"), for booking calls; nothing without a time zone. */
export function TheirTime({ timezone, className }) {
  const at = zoneNow(timezone);
  if (!at) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] dim', className)} title={timezone}>
      <Clock className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only">Their time: </span>{at.day} {at.time}
    </span>
  );
}

/** A time zone picker: the zones the team sells into, plus the current one if it isn't among them. */
export function ZoneSelect({ value, onChange, label = 'Time zone' }) {
  const zones = value && !TIMEZONES.includes(value) ? [value, ...TIMEZONES] : TIMEZONES;
  return (
    <select className="field" aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}</option>
      {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
    </select>
  );
}

/** A labelled row in a profile's details. */
export const Detail = ({ label, children }) => (children || children === 0
  ? <><dt className="dimmer">{label}</dt><dd className="min-w-0 break-words">{children}</dd></>
  : null);

/** A button that reads as a link, for opening another record from a profile or a table. */
export const OpenLink = ({ onClick, children, className, label, ...rest }) => (
  <button type="button" onClick={onClick} aria-label={label} className={cn('min-w-0 truncate text-left font-semibold hover:underline', className)} {...rest}>{children}</button>
);

/** An account's guardrails (what not to say), shown where a call is prepared. */
export const Guardrails = ({ text }) => (String(text || '').trim()
  ? (
    <div className="rounded-2xl border border-amber-300/40 bg-amber-500/15 px-4 py-3 text-[13.5px]">
      <div className="text-[12px] font-bold uppercase tracking-wide text-amber-200">Guardrails</div>
      <p className="mt-1 whitespace-pre-wrap break-words">{text}</p>
    </div>
  ) : null);
