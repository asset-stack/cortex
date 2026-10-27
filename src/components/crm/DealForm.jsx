// New deal and Edit deal (docs/PHASE2.md §14, §22): the account (one there is, or a new one by its name), the deal's
// name (its account's unless it has its own), the people at that account on it, value and currency, close date,
// probability (the stage's unless set), owner, priority, who it waits on, next step, stage (Lost with a reason), and on
// editing Delete and Make client. Editing saves only what changed, so a change someone else (or the booking automation)
// made while it was open stays; it closes if the deal is deleted or made a client meanwhile.
import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useStore } from '@/data/store';
import {
  ALL_DEAL_STAGES, CURRENCIES, DEAL_PRIORITIES, DEAL_STAGES, LOST, LOST_REASONS, STAGE_PROBABILITY, WAITING_ON, dealStage,
} from '@/data/boards';
import { CONTACT_ROLES, accountById, accountNamed, peopleOf } from '@/lib/accounts';
import { ConfirmModal, Modal, PersonPicker } from '@/components/ui';
import { cn } from '@/lib/cn';

// '250,000' | '$250k' | '85 000' | '1.2m' -> number; '' -> 0; anything else -> null.
export function parseValue(s) {
  const t = String(s ?? '').replace(/[$£€,\s]/g, '').toLowerCase();
  if (!t) return 0;
  const m = t.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1));
}

const FIELDS = ['name', 'sector', 'priority', 'contact', 'next', 'stage', 'currency', 'closeOn', 'waitingOn', 'lostReason'];
const formOf = (deal, state) => {
  const account = accountById(state, deal.accountId);
  return {
    account: account?.name || '', name: deal.name, sector: deal.sector || '', value: deal.value ? String(deal.value) : '',
    priority: deal.priority || 'P2', contact: deal.contact || '', next: deal.next || '', stage: dealStage(deal),
    currency: deal.currency || 'AUD', closeOn: deal.closeOn || '', probability: Number.isInteger(deal.probability) ? String(deal.probability) : '',
    waitingOn: deal.waitingOn || '', lostReason: deal.lostReason || '', contactIds: [...(deal.contactIds || [])],
  };
};

/** Make <name> a client? Converting can't be undone: the deal leaves the board for Clients. */
export function ConfirmMakeClient({ name, open, onClose, onConfirm }) {
  return (
    <ConfirmModal open={open} onClose={onClose} onConfirm={onConfirm} action="Make client" title={`Make ${name} a client?`}>
      It moves to Clients and leaves the Pipeline.
    </ConfirmModal>
  );
}

export default function DealForm({ deal: opened, onClose, onDone, canConvert, presetAccount = '' }) {
  const { state, actions, missing } = useStore();
  const crm = !missing.includes('accounts');
  const editing = Boolean(opened);
  const deal = editing ? state.deals.find((x) => x.id === opened.id) : null;
  const start = useRef(editing ? formOf(opened, state) : {
    account: accountById(state, presetAccount)?.name || '', name: '', sector: '', value: '', priority: 'P2', contact: state.me, next: '',
    stage: DEAL_STAGES[0], currency: 'AUD', closeOn: '', probability: '', waitingOn: '', lostReason: '', contactIds: [],
  });
  const [f, setF] = useState(start.current);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(null); // 'delete' | 'client': asks on top of the form
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const gone = editing && (!deal || Boolean(deal.clientId));
  useEffect(() => { if (gone) onClose(); }, [gone, onClose]);

  const account = crm ? accountNamed(state, f.account) : null; // the account typed, when it exists
  const people = account ? peopleOf(state, account.id).filter((p) => p.status !== 'do_not_contact' || f.contactIds.includes(p.id)) : [];
  const togglePerson = (id) => setF((x) => ({ ...x, contactIds: x.contactIds.includes(id) ? x.contactIds.filter((p) => p !== id) : [...x.contactIds, id] }));

  // The form's value, or null (and a hint) when it isn't one; a deal needs an account or a name.
  const checked = () => {
    if (!f.account.trim() && !f.name.trim()) { setErr('Add the account'); return null; }
    const value = parseValue(f.value);
    if (value === null) { setErr('Enter an amount, e.g. 250000, 250,000 or 250k'); return null; }
    const p = f.probability.trim();
    if (p && !(/^\d+$/.test(p) && Number(p) <= 100)) { setErr('Probability is a number from 0 to 100'); return null; }
    return value;
  };
  // The account's id: the one named, else a new prospect by that name ('' without one).
  const accountId = () => {
    if (!crm || !f.account.trim()) return '';
    if (account) return account.id;
    const id = actions.addAccount({ name: f.account.trim(), lifecycle: 'opportunity', owner: f.contact || state.me });
    return id || '';
  };
  // Only what changed since the form opened.
  const changes = (value) => {
    const out = {};
    FIELDS.forEach((k) => { if (f[k] !== start.current[k]) out[k] = f[k]; });
    if (value !== parseValue(start.current.value)) out.value = value;
    if (f.probability !== start.current.probability) out.probability = f.probability.trim();
    if (crm && f.account.trim() !== start.current.account) out.accountId = accountId();
    if (crm && f.contactIds.join() !== start.current.contactIds.join()) out.contactIds = f.contactIds;
    if (out.stage && out.stage !== LOST) out.lostReason = '';
    return out;
  };
  const save = (value) => {
    const patch = changes(value);
    if (Object.keys(patch).length) actions.updateDeal(deal.id, patch);
  };
  const submit = (e) => {
    e.preventDefault();
    const value = checked();
    if (value === null) return;
    if (editing) save(value);
    else {
      const id = accountId();
      actions.addDeal({
        ...f, name: f.name.trim() || f.account.trim(), value, probability: f.probability.trim(), accountId: id,
        contactIds: account ? f.contactIds : [],
      });
    }
    onClose();
    onDone?.(editing ? deal.id : null);
  };
  const makeClient = () => {
    if (checked() === null) return;
    setConfirm('client');
  };
  if (gone) return null;
  const stage = f.stage;
  return (
    <>
      <Modal open onClose={onClose} title={editing ? 'Edit deal' : 'New deal'} width={520}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          {crm ? (
            <>
              <input className="field" placeholder="Account" aria-label="Account" list="deal-accounts" value={f.account}
                onChange={(e) => { setErr(''); setF((x) => ({ ...x, account: e.target.value, contactIds: [] })); }} autoFocus />
              <datalist id="deal-accounts">{(state.accounts || []).map((a) => <option key={a.id} value={a.name} />)}</datalist>
              {f.account.trim() && !account && <div className="-mt-1.5 text-[12px] dimmer">A new account</div>}
              <input className="field" placeholder={f.account.trim() ? `Deal name (${f.account.trim()})` : 'Deal name'} aria-label="Deal name" value={f.name} onChange={set('name')} />
            </>
          ) : (
            <input className="field" placeholder="Organisation" aria-label="Organisation" value={f.name} onChange={(e) => { setErr(''); set('name')(e); }} autoFocus />
          )}
          {people.length > 0 && (
            <fieldset className="flex flex-wrap gap-1.5">
              <legend className="mb-1.5 text-[12.5px] dimmer">Contacts on this deal</legend>
              {people.map((p) => (
                <button key={p.id} type="button" aria-pressed={f.contactIds.includes(p.id)} onClick={() => togglePerson(p.id)}
                  className={cn('rounded-full px-3 h-8 text-[12.5px]', f.contactIds.includes(p.id) ? 'chip-on font-semibold' : 'chip')}>
                  {p.name || p.email}{p.role ? <span className="opacity-70"> · {CONTACT_ROLES[p.role]}</span> : null}
                </button>
              ))}
            </fieldset>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex gap-2">
              <input className="field min-w-0 flex-1" placeholder="Value / yr" aria-label="Value per year" aria-invalid={/amount/.test(err)} inputMode="numeric"
                value={f.value} onChange={(e) => { setErr(''); set('value')(e); }} />
              <select className="field !w-[84px] !px-2" aria-label="Currency" value={f.currency} onChange={set('currency')}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <input className="field" type="date" aria-label="Expected close" title="Expected close" value={f.closeOn} onChange={set('closeOn')} />
            <div className="field flex items-center gap-2 !py-1"><span className="dimmer">Owner</span>
              <PersonPicker value={f.contact} onChange={(v) => setF((x) => ({ ...x, contact: v }))} size={26} />
            </div>
            <select className="field" aria-label="Priority" value={f.priority} onChange={set('priority')}>
              {DEAL_PRIORITIES.map((p) => <option key={p}>{p}</option>)}
            </select>
            <select className="field" aria-label="Stage" value={stage} onChange={set('stage')}>
              {(editing ? ALL_DEAL_STAGES : DEAL_STAGES).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input className="field" placeholder={`Probability (${STAGE_PROBABILITY[stage]}%)`} aria-label="Probability %" inputMode="numeric"
              value={f.probability} onChange={(e) => { setErr(''); set('probability')(e); }} />
            <select className="field" aria-label="Waiting on" value={f.waitingOn} onChange={set('waitingOn')}>
              <option value="">Waiting on</option>
              {Object.entries(WAITING_ON).map(([k, l]) => <option key={k} value={k}>Waiting on {l.toLowerCase()}</option>)}
            </select>
            <input className="field" placeholder="Sector" aria-label="Sector" value={f.sector} onChange={set('sector')} />
          </div>
          {stage === LOST && (
            <select className="field" aria-label="Lost reason" value={f.lostReason} onChange={set('lostReason')}>
              <option value="">Lost reason</option>
              {[...new Set([...LOST_REASONS, ...(f.lostReason ? [f.lostReason] : [])])].map((r) => <option key={r}>{r}</option>)}
            </select>
          )}
          {err && <div role="alert" className="text-[12.5px] text-rose-200">{err}</div>}
          <input className="field" placeholder="Next step" aria-label="Next step" value={f.next} onChange={set('next')} />
          <button type="submit" className="btn-primary rounded-full h-11 font-semibold">{editing ? 'Save' : 'Add deal'}</button>
          {editing && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" onClick={() => setConfirm('delete')} className="rounded-full px-3 h-9 font-semibold text-rose-200 hover:bg-white/10">Delete deal</button>
              {canConvert && stage !== LOST && (
                <button type="button" onClick={makeClient}
                  className="inline-flex items-center gap-1 rounded-full chip-on px-3 h-9 font-semibold">Won: make client<ArrowRight className="h-4 w-4" /></button>
              )}
            </div>
          )}
        </form>
      </Modal>
      {editing && (
        <>
          <ConfirmModal open={confirm === 'delete'} onClose={() => setConfirm(null)} title={`Delete ${deal.name}?`}
            onConfirm={() => { actions.removeDeal(deal.id); onClose(); onDone?.(null); }} />
          {/* Your edits first (a corrected name is the client's name), then the client. */}
          <ConfirmMakeClient name={f.account.trim() || f.name.trim() || deal.name} open={confirm === 'client'} onClose={() => setConfirm(null)}
            onConfirm={() => { const value = parseValue(f.value); if (value !== null) save(value); actions.convertDeal(deal.id); onClose(); onDone?.(null); }} />
        </>
      )}
    </>
  );
}
