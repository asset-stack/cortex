// A client's contracts (the drawer's Contract tab), newest first. Admins make one from the Google Doc template as
// themselves (their own Google account, and the template and folder from Settings → Business) or link an existing
// Doc, then move it Draft → Sent for signature → Signed, or Cancelled. Signatures are requested in Google Docs
// (eSignature has no API), so Cortex only records each step. Everyone else with Clients access sees the list.
import { useState } from 'react';
import { Check, ExternalLink, FileSignature, Link2, PenLine, Plus, Send, Trash2 } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { PLAN_FREQUENCIES } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { PLAN_MONTHS, isPlanDate } from '@/lib/automations';
import { CONTRACT_DEFAULTS, CONTRACT_STATUS, newContractDetails, termEnd } from '@/lib/contract';
import { TEAM_TIMEZONE, fullDate, money2, parseAmount, ymdIn } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Labelled, Switch, moneyField, safeUrl } from './shared';

const str = (v) => String(v ?? '').trim();
const ACTION = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50';
const SETTINGS = '#/settings?tab=business';

// A date box is '' or a real day; an end date can't come before the start.
const badDate = (v) => v !== '' && !isPlanDate(v);
// Money as typed: '' is nothing, anything else must be a number, not below zero.
const badMoney = (v) => {
  const n = parseAmount(v);
  return str(v) !== '' && !(Number.isFinite(n) && n >= 0);
};

// Signing sets up billing from the payment terms: annually unless they say monthly or quarterly, the annual fee split
// over the year.
const termsFrequency = (terms) => (/month/i.test(terms) ? 'monthly' : /quarter/i.test(terms) ? 'quarterly' : 'annually');
const perInvoice = (fee, frequency) => Math.round(((Number(fee) || 0) * (PLAN_MONTHS[frequency] || 12)) / 12 * 100) / 100;

function DocLink({ url, primary = false }) {
  const href = safeUrl(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn(ACTION, primary ? 'btn-primary' : 'chip')}>
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Open in Google Docs
    </a>
  );
}

/** Mark signed: the date, and (on unless the client already has an active plan) the billing plan it starts. */
function SignForm({ c, k, onClose }) {
  const { actions } = useStore();
  const [signedAt, setSignedAt] = useState(() => ymdIn(TEAM_TIMEZONE));
  const [billing, setBilling] = useState(() => !(c.plans || []).some((p) => p.active));
  const [frequency, setFrequency] = useState(() => termsFrequency(k.paymentTerms));
  const [amount, setAmount] = useState(null); // as typed; until then it follows the frequency
  const [nextDate, setNextDate] = useState(k.startDate || '');
  const shown = amount ?? (Number(k.annualFee) ? moneyField(perInvoice(k.annualFee, frequency)) : '');
  const n = parseAmount(shown);
  const amountBad = billing && badMoney(shown);
  const blocked = !isPlanDate(signedAt) || (billing && (!(Number.isFinite(n) && n > 0) || !isPlanDate(nextDate)));
  const submit = (e) => {
    e.preventDefault();
    if (blocked) return;
    const plan = billing ? { amount: n, frequency, nextDate } : null;
    if (actions.updateContract(c.id, k.id, { status: 'Signed', signedAt }, { plan }) !== false) onClose();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-2xl border border-dashed border-white/25 p-3">
      <div className="grid grid-cols-2 items-end gap-2">
        <Labelled label="Signed on" className="col-span-2 sm:col-span-1">
          <input type="date" min="2000-01-01" max="2099-12-31" className={cn('field !px-3 tnum', badDate(signedAt) && '!border-rose-400')}
            aria-invalid={badDate(signedAt) || undefined} value={signedAt} onChange={(e) => setSignedAt(e.target.value)} />
        </Labelled>
        <div className="col-span-2 flex h-[42px] items-center gap-2.5 sm:col-span-1">
          <Switch checked={billing} label="Set up billing" onChange={setBilling} />
          <span className="text-[13px] font-semibold" aria-hidden="true">Set up billing</span>
        </div>
      </div>
      {billing && (
        <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-3">
          <Labelled label="Amount (ex GST)">
            <input className={cn('field tnum', amountBad && '!border-rose-400')} inputMode="decimal" autoComplete="off" aria-invalid={amountBad || undefined}
              value={shown} onChange={(e) => setAmount(e.target.value)} />
          </Labelled>
          <Labelled label="Frequency">
            <select className="field" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              {Object.entries(PLAN_FREQUENCIES).map(([key, l]) => <option key={key} value={key}>{l}</option>)}
            </select>
          </Labelled>
          <Labelled label="First invoice" className="col-span-2 sm:col-span-1">
            <input type="date" min="2000-01-01" max="2099-12-31" className={cn('field !px-3 tnum', badDate(nextDate) && '!border-rose-400')}
              aria-invalid={badDate(nextDate) || undefined} value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          </Labelled>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={blocked} className={cn(ACTION, 'btn-primary')}><Check className="h-3.5 w-3.5" aria-hidden="true" />Mark signed</button>
        <button type="button" onClick={onClose} className={cn(ACTION, 'chip')}>Close</button>
      </div>
    </form>
  );
}

function ContractRow({ c, k, admin }) {
  const { actions } = useStore();
  const users = useUsers();
  const [signing, setSigning] = useState(false);
  const title = k.title || CONTRACT_DEFAULTS.title;
  const set = (patch) => actions.updateContract(c.id, k.id, patch);
  const cancel = () => { if (window.confirm(`Cancel ${title}?`)) set({ status: 'Cancelled' }); };
  const remove = () => { if (window.confirm(`Remove ${title}? Its Google Doc stays in Drive.`)) actions.removeContract(c.id, k.id); };
  const terms = [
    k.startDate || k.endDate ? `${fullDate(k.startDate)} – ${fullDate(k.endDate)}` : '',
    Number(k.annualFee) ? `${money2(k.annualFee)} a year ex GST` : '',
  ].filter(Boolean).join(' · ');
  const sender = users[k.sentBy]?.name;
  const history = [
    k.sentAt ? `Sent${sender ? ` by ${sender}` : ''} ${fullDate(k.sentAt)}` : '',
    k.status === 'Signed' && k.signedAt ? `Signed ${fullDate(k.signedAt)}` : '',
  ].filter(Boolean).join(' · ');
  const removable = k.status === 'Draft' || k.status === 'Cancelled';
  const showSign = admin && signing && k.status === 'Sent for signature'; // gone if someone else moves it on meanwhile
  return (
    <li className="flex flex-col gap-2 rounded-2xl chip p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-extrabold break-words">{title}</div>
          {terms && <div className="text-[12.5px] dimmer tnum">{terms}</div>}
          {history && <div className="text-[12.5px] dim tnum">{history}</div>}
        </div>
        <span className="pill !h-6 !text-[12px] shrink-0" style={{ backgroundColor: CONTRACT_STATUS[k.status] || '#5c6370' }}>{k.status}</span>
      </div>
      {!showSign && (admin || safeUrl(k.docUrl)) && (
        <div className="flex flex-wrap items-center gap-2">
          <DocLink url={k.docUrl} />
          {admin && k.status === 'Draft' && (
            <button type="button" onClick={() => set({ status: 'Sent for signature' })} className={cn(ACTION, 'btn-primary')}>
              <Send className="h-3.5 w-3.5" aria-hidden="true" />Mark as sent for signature
            </button>
          )}
          {admin && k.status === 'Sent for signature' && (
            <button type="button" onClick={() => setSigning(true)} className={cn(ACTION, 'btn-primary')}>
              <PenLine className="h-3.5 w-3.5" aria-hidden="true" />Mark signed
            </button>
          )}
          {admin && k.status !== 'Cancelled' && (
            <button type="button" onClick={cancel} aria-label={`Cancel ${title}`} className={cn(ACTION, 'chip')}>Cancel</button>
          )}
          {admin && removable && (
            <button type="button" onClick={remove} aria-label={`Remove ${title}`} title="Remove"
              className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><Trash2 className="h-4 w-4" /></button>
          )}
        </div>
      )}
      {admin && k.status === 'Draft' && <p className="text-[12px] dimmer">In Google Docs: Tools › eSignature › Request signature</p>}
      {showSign && <SignForm c={c} k={k} onClose={() => setSigning(false)} />}
    </li>
  );
}

// Why Create contract can't run yet (null when it can; '' while your Google account is still loading).
function createBlocker(google, org) {
  if (google.demo) return 'Live mode only';
  if (!google.ready) return '';
  const settings = (text) => <a href={SETTINGS} className="underline underline-offset-2 hover:text-white">{text}</a>;
  if (!google.connected) return settings('Connect your Google account in Settings');
  if (!str(org.contractTemplate) || !str(org.contractFolder)) return settings('Add the contract template and folder in Settings → Business');
  return null;
}

/** Admins: Key Details (prefilled from the client) → a copy of the template in Drive, or a link to an existing Doc. */
function NewContract({ c, onClose }) {
  const { state, actions, google } = useStore();
  const [f, setF] = useState(() => {
    const d = newContractDetails(c);
    return { ...d, annualFee: d.annualFee ? moneyField(d.annualFee) : '' };
  });
  const [endTyped, setEndTyped] = useState(false); // the end date follows the start until it is edited
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(''); // '' | 'create' | 'link'
  const [error, setError] = useState('');
  const [made, setMade] = useState(null); // the new Doc's link
  const blocker = createBlocker(google, state.org || {});
  const startBad = badDate(f.startDate);
  const endBad = badDate(f.endDate) || (f.startDate !== '' && f.endDate !== '' && f.endDate < f.startDate);
  const feeBad = badMoney(f.annualFee);
  const invalid = startBad || endBad || feeBad;
  const linkHref = safeUrl(link);
  const linkBad = str(link) !== '' && !linkHref;

  const setStart = (startDate) => setF((x) => ({ ...x, startDate, ...(endTyped ? {} : { endDate: isPlanDate(startDate) ? termEnd(startDate) : '' }) }));
  const details = () => ({ ...f, annualFee: str(f.annualFee) ? parseAmount(f.annualFee) : 0 });
  const run = async (docUrl) => {
    setBusy(docUrl ? 'link' : 'create');
    setError('');
    try {
      const res = await actions.createContract(c.id, details(), docUrl ? { docUrl } : undefined);
      if (!res?.ok) setError(res?.error || 'Could not create the contract.');
      else if (docUrl) onClose();
      else setMade(res.url || '');
    } catch (e) {
      setError(e?.message || 'Could not create the contract.');
    } finally {
      setBusy('');
    }
  };
  const create = (e) => { e.preventDefault(); if (blocker === null && !invalid && !busy) run(''); };
  const linkDoc = (e) => { e.preventDefault(); if (linkHref && !invalid && !busy) run(linkHref); };

  if (made !== null) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-2 rounded-2xl chip p-3">
        <span className="inline-flex items-center gap-1.5 font-semibold"><Check className="h-4 w-4 text-emerald-300" aria-hidden="true" />Contract created</span>
        <DocLink url={made} primary />
        <button type="button" onClick={onClose} className={cn(ACTION, 'chip ml-auto')}>Done</button>
      </div>
    );
  }

  const text = (key, label, className) => (
    <Labelled label={label} className={className}>
      <input className="field" autoComplete="off" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </Labelled>
  );
  const date = (key, label, bad, onChange) => (
    <Labelled label={label} className="col-span-2 sm:col-span-1">
      <input type="date" min="2000-01-01" max="2099-12-31" className={cn('field !px-3 tnum', bad && '!border-rose-400')}
        aria-invalid={bad || undefined} value={f[key]} onChange={(e) => onChange(e.target.value)} />
    </Labelled>
  );
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-white/25 p-3">
      <form onSubmit={create} className="grid grid-cols-2 gap-2">
        {text('title', 'Title', 'col-span-2')}
        {text('platform', 'Platform', 'col-span-2')}
        {date('startDate', 'Start date', startBad, setStart)}
        {date('endDate', 'End date', endBad, (endDate) => { setEndTyped(true); setF({ ...f, endDate }); })}
        <Labelled label="Annual fee (ex GST)">
          <input className={cn('field tnum', feeBad && '!border-rose-400')} inputMode="decimal" autoComplete="off" aria-invalid={feeBad || undefined}
            value={f.annualFee} onChange={(e) => setF({ ...f, annualFee: e.target.value })} />
        </Labelled>
        {text('mobileApp', 'Mobile app')}
        {text('paymentTerms', 'Payment terms', 'col-span-2')}
        {text('userLimit', 'User limit', 'col-span-2')}
        {text('customisations', 'Customisations', 'col-span-2')}
        {text('governingLaw', 'Governing law', 'col-span-2')}
        <div className="col-span-2 mt-1 flex flex-wrap items-center gap-2">
          <button type="submit" disabled={blocker !== null || invalid || Boolean(busy)} className="btn-primary inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold">
            <FileSignature className="h-4 w-4" aria-hidden="true" />{busy === 'create' ? 'Creating…' : 'Create contract'}
          </button>
          <button type="button" onClick={onClose} className="chip inline-flex h-10 items-center rounded-full px-4 font-semibold">Close</button>
        </div>
        {blocker && <p className="col-span-2 text-[12.5px] text-amber-200">{blocker}</p>}
      </form>
      <form onSubmit={linkDoc} noValidate className="flex flex-wrap gap-2 border-t rowline pt-3">
        <input type="url" className={cn('field min-w-0 flex-1 basis-[180px]', linkBad && '!border-rose-400')} placeholder="Google Doc link" aria-label="Google Doc link"
          autoComplete="off" aria-invalid={linkBad || undefined} value={link} onChange={(e) => setLink(e.target.value)} />
        <button type="submit" disabled={!linkHref || invalid || Boolean(busy)} className="chip inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50">
          <Link2 className="h-4 w-4" aria-hidden="true" />{busy === 'link' ? 'Linking…' : 'Link existing Doc'}
        </button>
      </form>
      {error && <div role="alert" className="text-[12.5px] text-rose-200">{error}</div>}
    </div>
  );
}

/** The Contract tab. Admins act; everyone else sees the list. */
export default function ContractTab({ c }) {
  const { isAdmin } = useAccess();
  const [adding, setAdding] = useState(false);
  const contracts = c.contracts || [];
  return (
    <div className="flex flex-col gap-3">
      {isAdmin && (adding ? <NewContract c={c} onClose={() => setAdding(false)} /> : (
        <button type="button" onClick={() => setAdding(true)} className="btn-primary self-start inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold">
          <Plus className="h-4 w-4" />New contract
        </button>
      ))}
      {contracts.length === 0 && <p className="dimmer">No contracts yet.</p>}
      {contracts.length > 0 && (
        <ul className="flex flex-col gap-2">{contracts.map((k) => <ContractRow key={k.id} c={c} k={k} admin={isAdmin} />)}</ul>
      )}
    </div>
  );
}
