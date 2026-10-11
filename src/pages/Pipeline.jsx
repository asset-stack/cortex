import { useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useStore } from '@/data/store';
import { DEAL_STAGES } from '@/data/boards';
import { KpiRow, Modal, PageHeader } from '@/components/ui';
import { compactMoney } from '@/lib/format';
import { go } from '@/lib/router';
import { cn } from '@/lib/cn';

const PRIORITY_BG = { P1: 'bg-rose-500', P2: 'bg-amber-500', P3: 'bg-sky-500' };

function NewDeal({ open, onClose }) {
  const { actions } = useStore();
  const [f, setF] = useState({ name: '', sector: '', value: '', priority: 'P2', contact: '', next: '' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal open={open} onClose={onClose} title="New deal">
      <form className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault();
        if (!f.name.trim()) return;
        actions.addDeal({ ...f, name: f.name.trim(), value: Number(f.value) || 0 });
        setF({ name: '', sector: '', value: '', priority: 'P2', contact: '', next: '' });
        onClose();
      }}>
        <input className="field" placeholder="Organisation" aria-label="Organisation" value={f.name} onChange={set('name')} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <input className="field" placeholder="Sector" aria-label="Sector" value={f.sector} onChange={set('sector')} />
          <input className="field" placeholder="Value (AUD / yr)" aria-label="Value" inputMode="numeric" value={f.value} onChange={set('value')} />
          <input className="field" placeholder="Owner" aria-label="Owner" value={f.contact} onChange={set('contact')} />
          <select className="field" aria-label="Priority" value={f.priority} onChange={set('priority')}>
            <option>P1</option><option>P2</option><option>P3</option>
          </select>
        </div>
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
                onDragLeave={() => setOver(null)}
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
                        <span className="font-extrabold tnum text-[16px]">{compactMoney(d.value)}</span>
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
