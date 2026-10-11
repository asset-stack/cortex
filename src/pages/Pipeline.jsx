import { useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useStore } from '@/data/store';
import { DEAL_STAGES } from '@/data/boards';
import { Avatar, KpiRow, Modal, PageHeader, PersonPicker } from '@/components/ui';
import { compactMoney } from '@/lib/format';
import { go } from '@/lib/router';
import { cn } from '@/lib/cn';

const PRIORITY_BG = { P1: 'bg-rose-500', P2: 'bg-amber-500', P3: 'bg-sky-500' };

// '250,000' | '$250k' | '85 000' | '1.2m' -> number; '' -> 0; anything else -> null.
function parseValue(s) {
  const t = s.replace(/[$,\s]/g, '').toLowerCase();
  if (!t) return 0;
  const m = t.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1));
}

function NewDeal({ open, onClose }) {
  const { state, actions } = useStore();
  const blank = () => ({ name: '', sector: '', value: '', priority: 'P2', contact: state.me, next: '' }); // contact = owner's user id
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal open={open} onClose={onClose} title="New deal">
      <form className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault();
        if (!f.name.trim()) return;
        const value = parseValue(f.value);
        if (value === null) { setErr('Enter an amount, e.g. 250000, 250,000 or 250k'); return; }
        actions.addDeal({ ...f, name: f.name.trim(), value });
        setF(blank()); setErr('');
        onClose();
      }}>
        <input className="field" placeholder="Organisation" aria-label="Organisation" value={f.name} onChange={set('name')} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <input className="field" placeholder="Sector" aria-label="Sector" value={f.sector} onChange={set('sector')} />
          <input className={cn('field', err && '!border-rose-400')} placeholder="Value (AUD / yr)" aria-label="Value" aria-invalid={!!err} inputMode="numeric" value={f.value}
            onChange={(e) => { setErr(''); set('value')(e); }} />
          <div className="field flex items-center gap-2 !py-1"><span className="dimmer">Owner</span>
            <PersonPicker value={f.contact} onChange={(v) => setF((x) => ({ ...x, contact: v }))} size={26} />
          </div>
          <select className="field" aria-label="Priority" value={f.priority} onChange={set('priority')}>
            <option>P1</option><option>P2</option><option>P3</option>
          </select>
        </div>
        {err && <div role="alert" className="text-[12.5px] text-rose-200">{err}</div>}
        <input className="field" placeholder="Next step" aria-label="Next step" value={f.next} onChange={set('next')} />
        <button type="submit" className="btn-primary rounded-full h-11 font-semibold">Add to Opportunities</button>
      </form>
    </Modal>
  );
}

export default function Pipeline() {
  const { state, actions } = useStore();
  const [over, setOver] = useState(null);
  const [adding, setAdding] = useState(false);
  const deals = state.deals;
  const open = deals.filter((d) => d.stage !== 'Won');
  const value = open.reduce((t, d) => t + (d.value || 0), 0);

  return (
    <div>
      <PageHeader title="Pipeline" action="New deal" onAction={() => setAdding(true)} />
      <KpiRow items={[
        { value: open.length, label: 'Open deals', tint: '#334155' },
        { value: compactMoney(value), label: 'Pipeline value', tint: '#7c3aed' },
        { value: deals.filter((d) => d.stage === 'Demos').length, label: 'Demos', tint: '#0f9f8f' },
        { value: deals.filter((d) => d.stage === 'Won').length, label: 'Won', tint: '#f59e0b' },
      ]} />
      <div className="mt-7 overflow-x-auto scroll-thin pb-2">
        <div className="grid grid-cols-4 gap-4 min-w-[900px]">
          {DEAL_STAGES.map((stage) => {
            const items = deals.filter((d) => d.stage === stage);
            return (
              <div key={stage}
                className={cn('rounded-[24px] glass p-3', over === stage && 'drag-over')}
                onDragOver={(e) => { e.preventDefault(); setOver(stage); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); }}
                onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/plain'); if (id) actions.moveDeal(id, stage); }}>
                <div className="mb-3 flex items-center justify-between px-2 pt-1 font-bold">
                  {stage}<span className="rounded-full chip px-2 text-[12px] tnum">{items.length}</span>
                </div>
                <div className="flex flex-col gap-2 min-h-[90px]">
                  {items.map((d) => (
                    <div key={d.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', d.id)}
                      className="float cursor-grab rounded-[18px] chip p-3.5 active:cursor-grabbing">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-bold">{d.name}</div>
                        <span className={cn('rounded-full px-2 text-[11px] font-bold', PRIORITY_BG[d.priority])}>{d.priority}</span>
                      </div>
                      {d.next && <div className="mt-1 text-[12.5px] dim">{d.next}</div>}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-extrabold tnum text-[16px]">{compactMoney(d.value)}</span>
                          {d.contact && <Avatar userId={d.contact} size={22} />}
                        </div>
                        {stage === 'Won' && (d.clientId ? (
                          <button type="button" onClick={() => go('clients')} className="inline-flex items-center gap-1 rounded-full chip px-2.5 py-1 text-[12px] font-semibold">
                            <Check className="h-3.5 w-3.5" />Client
                          </button>
                        ) : (
                          <button type="button" onClick={() => actions.convertDeal(d.id)} className="inline-flex items-center gap-1 rounded-full chip-on px-2.5 py-1 text-[12px] font-semibold">
                            Make client<ArrowRight className="h-3.5 w-3.5" />
                          </button>
                        ))}
                      </div>
                      {/* Keyboard path for moving a deal; drag and drop stays as the mouse shortcut. */}
                      <select className="field mt-2 !rounded-full !py-1 !px-2.5 text-[12px]" aria-label={`Stage for ${d.name}`} value={d.stage}
                        draggable={false} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => actions.moveDeal(d.id, e.target.value)}>
                        {DEAL_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <NewDeal open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
