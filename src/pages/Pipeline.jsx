import { useState } from 'react';
import { ArrowRight, Link2, Pencil } from 'lucide-react';
import { useStore } from '@/data/store';
import { DEAL_PRIORITIES, DEAL_STAGES, dealStage } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { Avatar, ConfirmModal, KpiRow, Modal, PageHeader, PersonPicker } from '@/components/ui';
import { compactMoney } from '@/lib/format';
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

/** New deal (no `deal`) or Edit deal: organisation, sector, value, owner, priority, next step and, when editing, the
 *  stage, Delete and (on Demos) Make client. */
function DealForm({ deal, onClose, canConvert }) {
  const { state, actions } = useStore();
  const editing = Boolean(deal);
  const [f, setF] = useState(() => (deal
    ? { name: deal.name, sector: deal.sector || '', value: deal.value ? String(deal.value) : '', priority: deal.priority || 'P2', contact: deal.contact || '', next: deal.next || '', stage: dealStage(deal) }
    : { name: '', sector: '', value: '', priority: 'P2', contact: state.me, next: '' })); // contact = owner's user id
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = (e) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    const value = parseValue(f.value);
    if (value === null) { setErr('Enter an amount, e.g. 250000, 250,000 or 250k'); return; }
    if (editing) actions.updateDeal(deal.id, { ...f, value });
    else actions.addDeal({ ...f, name: f.name.trim(), value });
    onClose();
  };
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
              <button type="button" onClick={() => setConfirm(true)} className="rounded-full px-3 h-9 font-semibold text-rose-200 hover:bg-white/10">Delete deal</button>
              {canConvert && dealStage(deal) === LAST_STAGE && !deal.clientId && (
                <button type="button" onClick={() => { actions.convertDeal(deal.id); onClose(); }}
                  className="inline-flex items-center gap-1 rounded-full chip-on px-3 h-9 font-semibold">Make client<ArrowRight className="h-4 w-4" /></button>
              )}
            </div>
          )}
        </form>
      </Modal>
      {editing && (
        <ConfirmModal open={confirm} onClose={() => setConfirm(false)} title={`Delete ${deal.name}?`}
          onConfirm={() => { actions.removeDeal(deal.id); onClose(); }} />
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
  // A deal made a client has left the board (it lives in Clients); the rest show in their stage's column.
  const deals = state.deals.filter((d) => !d.clientId);
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
                    <div key={d.id} draggable={editable} onDragStart={editable ? (e) => e.dataTransfer.setData('text/plain', d.id) : undefined}
                      className={cn('float rounded-[18px] chip p-3.5', editable && 'cursor-grab active:cursor-grabbing')}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5 font-bold">
                          <span className="min-w-0">{d.name}</span>{d.contactId && <FromContact contactId={d.contactId} />}
                        </div>
                        <span className="flex shrink-0 items-center gap-1">
                          {editable && (
                            <button type="button" onClick={() => setForm(d)} aria-label={`Edit ${d.name}`} title="Edit"
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
                          <button type="button" onClick={() => actions.convertDeal(d.id)} className="inline-flex items-center gap-1 rounded-full chip-on px-2.5 py-1 text-[12px] font-semibold">
                            Make client<ArrowRight className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {/* Keyboard path for moving a deal; drag and drop stays as the mouse shortcut. */}
                      {editable && (
                        <select className="field mt-2 !rounded-full !py-1 !px-2.5 text-[12px]" aria-label={`Stage for ${d.name}`} value={stage}
                          draggable={false} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => actions.moveDeal(d.id, e.target.value)}>
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
      {editable && form && (
        <DealForm key={form === 'new' ? 'new' : form.id} deal={form === 'new' ? null : form} canConvert={canConvert} onClose={() => setForm(null)} />
      )}
    </div>
  );
}
