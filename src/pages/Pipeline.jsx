import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Link2, Pencil } from 'lucide-react';
import { useStore } from '@/data/store';
import { DEAL_PRIORITIES, DEAL_STAGES, dealStage } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { Avatar, ConfirmModal, KpiRow, Modal, PageHeader, PersonPicker } from '@/components/ui';
import { compactMoney } from '@/lib/format';
import { teamBoards } from '@/lib/boards';
import Board from '@/components/board/Board';
import DealProfile from '@/components/crm/DealProfile';
import { cn } from '@/lib/cn';

const PRIORITY_BG = { P1: 'bg-rose-500', P2: 'bg-amber-500', P3: 'bg-sky-500' };
const LAST_STAGE = DEAL_STAGES[DEAL_STAGES.length - 1]; // Demos: where Make client is

// '250,000' | '$250k' | '85 000' | '1.2m' -> number; '' -> 0; anything else -> null.
function parseValue(s) {
  const t = s.replace(/[$,\s]/g, '').toLowerCase();
  if (!t) return 0;
  const m = t.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1));
}

const FIELDS = ['name', 'sector', 'priority', 'contact', 'next', 'stage'];
const formOf = (deal) => ({
  name: deal.name, sector: deal.sector || '', value: deal.value ? String(deal.value) : '', priority: deal.priority || 'P2',
  contact: deal.contact || '', next: deal.next || '', stage: dealStage(deal),
});

// After a dialog closes, keyboard focus goes back to the deal's Edit button (its card may have moved column), else to
// New deal (it was deleted or made a client), else (Pipeline view: no New deal) to the page's title.
function refocus(dealId) {
  window.setTimeout(() => {
    const edit = dealId && document.querySelector(`[data-deal="${CSS.escape(dealId)}"] button[data-edit]`);
    const fallback = [...document.querySelectorAll('main button')].find((x) => x.textContent.trim() === 'New deal');
    (edit || fallback || document.querySelector('main h1'))?.focus({ preventScroll: true });
  }, 0);
}

/** Make <name> a client? Converting can't be undone: the deal leaves the board for Clients. */
function ConfirmMakeClient({ name, open, onClose, onConfirm }) {
  return (
    <ConfirmModal open={open} onClose={onClose} onConfirm={onConfirm} action="Make client" title={`Make ${name} a client?`}>
      It moves to Clients and leaves the Pipeline.
    </ConfirmModal>
  );
}

/**
 * New deal (no `deal`) or Edit deal: organisation, sector, value, owner, priority, next step and, when editing, the
 * stage, Delete and (on Demos) Make client. Editing saves only the fields you changed, so a change someone else (or the
 * booking automation) made while it was open stays; it closes if the deal is deleted or made a client meanwhile.
 */
function DealForm({ deal: opened, onClose, canConvert }) {
  const { state, actions } = useStore();
  const editing = Boolean(opened);
  const deal = editing ? state.deals.find((x) => x.id === opened.id) : null;
  const start = useRef(editing ? formOf(opened) : { name: '', sector: '', value: '', priority: 'P2', contact: state.me, next: '' }); // contact = owner's user id
  const [f, setF] = useState(start.current);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(null); // 'delete' | 'client': asks on top of the form
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const gone = editing && (!deal || Boolean(deal.clientId));
  useEffect(() => { if (gone) { onClose(); refocus(null); } }, [gone, onClose]);

  // The form's value, or null (and a hint) when it isn't one; a blank organisation is null with no hint.
  const checked = () => {
    if (!f.name.trim()) return null;
    const value = parseValue(f.value);
    if (value === null) setErr('Enter an amount, e.g. 250000, 250,000 or 250k');
    return value;
  };
  // Only what changed since the form opened.
  const changes = (value) => {
    const out = {};
    FIELDS.forEach((k) => { if (k in f && f[k] !== start.current[k]) out[k] = f[k]; });
    if (value !== parseValue(start.current.value)) out.value = value;
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
    else actions.addDeal({ ...f, name: f.name.trim(), value });
    onClose();
    if (editing) refocus(deal.id);
  };
  const makeClient = () => {
    const value = checked();
    if (value === null) return;
    setConfirm('client');
  };
  if (gone) return null;
  return (
    <>
      <Modal open onClose={onClose} title={editing ? 'Edit deal' : 'New deal'}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <input className="field" placeholder="Organisation" aria-label="Organisation" value={f.name} onChange={set('name')} autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <input className="field" placeholder="Sector" aria-label="Sector" value={f.sector} onChange={set('sector')} />
            <input className={cn('field', err && '!border-rose-400')} placeholder="Value (AUD / yr)" aria-label="Value" aria-invalid={!!err} inputMode="numeric" value={f.value}
              onChange={(e) => { setErr(''); set('value')(e); }} />
            <div className="field flex items-center gap-2 !py-1"><span className="dimmer">Owner</span>
              <PersonPicker value={f.contact} onChange={(v) => setF((x) => ({ ...x, contact: v }))} size={26} />
            </div>
            <select className="field" aria-label="Priority" value={f.priority} onChange={set('priority')}>
              {DEAL_PRIORITIES.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
          {err && <div role="alert" className="text-[12.5px] text-rose-200">{err}</div>}
          <input className="field" placeholder="Next step" aria-label="Next step" value={f.next} onChange={set('next')} />
          {editing && (
            <select className="field" aria-label="Stage" value={f.stage} onChange={set('stage')}>
              {DEAL_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <button type="submit" className="btn-primary rounded-full h-11 font-semibold">{editing ? 'Save' : 'Add to Opportunities'}</button>
          {editing && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" onClick={() => setConfirm('delete')} className="rounded-full px-3 h-9 font-semibold text-rose-200 hover:bg-white/10">Delete deal</button>
              {canConvert && f.stage === LAST_STAGE && (
                <button type="button" onClick={makeClient}
                  className="inline-flex items-center gap-1 rounded-full chip-on px-3 h-9 font-semibold">Make client<ArrowRight className="h-4 w-4" /></button>
              )}
            </div>
          )}
        </form>
      </Modal>
      {editing && (
        <>
          <ConfirmModal open={confirm === 'delete'} onClose={() => setConfirm(null)} title={`Delete ${deal.name}?`}
            onConfirm={() => { actions.removeDeal(deal.id); onClose(); refocus(null); }} />
          {/* Your edits first (a corrected name is the client's name), then the client. */}
          <ConfirmMakeClient name={f.name.trim() || deal.name} open={confirm === 'client'} onClose={() => setConfirm(null)}
            onConfirm={() => { const value = parseValue(f.value); if (value !== null) save(value); actions.convertDeal(deal.id); onClose(); refocus(null); }} />
        </>
      )}
    </>
  );
}

// Small link icon on a deal that came from an outreach contact (named when the viewer can see contacts).
function FromContact({ contactId }) {
  const { state } = useStore();
  const canSee = useAccess().canView('outreach'); // demo state holds every contact; live RLS hides them at none
  const c = canSee ? state.contacts.find((x) => x.id === contactId) : null;
  const label = c ? `From contact ${c.name}` : 'From an outreach contact';
  return <span role="img" aria-label={label} title={label} className="dimmer"><Link2 className="h-3.5 w-3.5" /></span>;
}

export default function Pipeline() {
  const { state, actions } = useStore();
  const access = useAccess();
  const editable = access.canEdit('pipeline'); // view: no drag, stage select, Edit, New deal or Make client
  const canConvert = editable && access.canEdit('clients'); // convertDeal needs both
  const [over, setOver] = useState(null);
  const [form, setForm] = useState(null); // null | 'new' | the deal being edited
  const [making, setMaking] = useState(null); // id of the deal Make client asks about
  const [profile, setProfile] = useState(null); // id of the deal whose profile is open
  // A deal moved by its stage select lands in another column: keep focus on its select there.
  const refocusStage = (dealId) => window.setTimeout(() => {
    document.querySelector(`[data-deal="${CSS.escape(dealId)}"] select`)?.focus({ preventScroll: true });
  }, 0);
  // Work in Progress (and any other Pipeline board) under the deals, for whoever can see Pipeline.
  const lists = teamBoards(state, 'pipeline').filter(access.canViewBoard);
  // A deal made a client has left the board (it lives in Clients); the rest show in their stage's column.
  const closeForm = useCallback(() => setForm(null), []);
  const deals = state.deals.filter((d) => !d.clientId);
  // The confirm closes if the deal is deleted or made a client meanwhile.
  const makingDeal = making ? deals.find((d) => d.id === making) : null;
  useEffect(() => { if (making && !makingDeal) { setMaking(null); refocus(null); } }, [making, makingDeal]);
  // So does the open profile.
  const profileGone = Boolean(profile) && !deals.some((d) => d.id === profile);
  useEffect(() => { if (profileGone) { setProfile(null); refocus(null); } }, [profileGone]);
  const value = deals.reduce((t, d) => t + (d.value || 0), 0);
  const drop = (stage) => (editable ? {
    onDragOver: (e) => { e.preventDefault(); setOver(stage); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); },
    onDrop: (e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/plain'); if (id) actions.moveDeal(id, stage); },
  } : {});

  return (
    <div>
      <PageHeader title="Pipeline" action={editable ? 'New deal' : undefined} onAction={() => setForm('new')} />
      <KpiRow items={[
        { value: deals.length, label: 'Open deals', tint: '#334155' },
        { value: compactMoney(value), label: 'Pipeline value', tint: '#7c3aed' },
        { value: deals.filter((d) => dealStage(d) === 'Demos').length, label: 'Demos', tint: '#0f9f8f' },
        { value: state.deals.filter((d) => d.clientId).length, label: 'Made clients', tint: '#f59e0b' },
      ]} />
      <div className="mt-7 overflow-x-auto scroll-thin pb-2">
        <div className="grid gap-4 min-w-[900px]" style={{ gridTemplateColumns: `repeat(${DEAL_STAGES.length}, minmax(0, 1fr))` }}>
          {DEAL_STAGES.map((stage) => {
            const items = deals.filter((d) => dealStage(d) === stage);
            return (
              <div key={stage} className={cn('rounded-[24px] glass p-3', over === stage && 'drag-over')} {...drop(stage)}>
                <div className="mb-3 flex items-center justify-between px-2 pt-1 font-bold">
                  {stage}<span className="rounded-full chip px-2 text-[12px] tnum">{items.length}</span>
                </div>
                <div className="flex flex-col gap-2 min-h-[90px]">
                  {items.map((d) => (
                    <div key={d.id} data-deal={d.id} draggable={editable} onDragStart={editable ? (e) => e.dataTransfer.setData('text/plain', d.id) : undefined}
                      className={cn('float rounded-[18px] chip p-3.5', editable && 'cursor-grab active:cursor-grabbing')}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5 font-bold">
                          <button type="button" onClick={() => setProfile(d.id)} draggable={false} onMouseDown={(e) => e.stopPropagation()}
                            className="min-w-0 text-left hover:underline" aria-label={`Open ${d.name}`}>{d.name}</button>
                          {d.contactId && <FromContact contactId={d.contactId} />}
                        </div>
                        <span className="flex shrink-0 items-center gap-1">
                          {editable && (
                            <button type="button" data-edit onClick={() => setForm(d)} aria-label={`Edit ${d.name}`} title="Edit"
                              draggable={false} onMouseDown={(e) => e.stopPropagation()}
                              className="grid h-7 w-7 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><Pencil className="h-3.5 w-3.5" /></button>
                          )}
                          <span className={cn('rounded-full px-2 text-[11px] font-bold', PRIORITY_BG[d.priority])}>{d.priority}</span>
                        </span>
                      </div>
                      {d.next && <div className="mt-1 text-[12.5px] dim">{d.next}</div>}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-extrabold tnum text-[16px]">{compactMoney(d.value)}</span>
                          {d.contact && <Avatar userId={d.contact} size={22} />}
                        </div>
                        {stage === LAST_STAGE && canConvert && (
                          <button type="button" onClick={() => setMaking(d.id)} className="inline-flex items-center gap-1 rounded-full chip-on px-2.5 py-1 text-[12px] font-semibold">
                            Make client<ArrowRight className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {/* Keyboard path for moving a deal; drag and drop stays as the mouse shortcut. */}
                      {editable && (
                        <select className="field mt-2 !rounded-full !py-1 !px-2.5 text-[12px]" aria-label={`Stage for ${d.name}`} value={stage}
                          draggable={false} onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) => { if (actions.moveDeal(d.id, e.target.value)) refocusStage(d.id); }}>
                          {DEAL_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {lists.map((b) => (
        <section key={b.id} className="mt-12">
          <Board board={b} embedded />
        </section>
      ))}
      {editable && form && (
        <DealForm key={form === 'new' ? 'new' : form.id} deal={form === 'new' ? null : form} canConvert={canConvert} onClose={closeForm} />
      )}
      <DealProfile dealId={profile} onClose={() => setProfile(null)} onEdit={(deal) => setForm(deal)} />
      {makingDeal && (
        <ConfirmMakeClient name={makingDeal.name} open onClose={() => setMaking(null)}
          onConfirm={() => { actions.convertDeal(makingDeal.id); refocus(null); }} />
      )}
    </div>
  );
}
