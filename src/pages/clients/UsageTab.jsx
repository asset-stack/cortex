// Usage: each client's platform usage for a month (everyone who can see Clients; editable with edit access, which also
// imports a client's platform export), and for admins our own software subscriptions with their monthly total (annual
// plans ÷ 12).
import { useState } from 'react';
import { CreditCard, Plus, Trash2, Upload } from 'lucide-react';
import { useStore } from '@/data/store';
import { EXPENSE_CATEGORIES, SUBSCRIPTION_CYCLES } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { KpiRow, Modal } from '@/components/ui';
import { addMonths } from '@/lib/automations';
import { count, localYmd, money2, monthLabel, monthStart, monthlyCost, parseAmount } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Labelled, MODAL_FORM, MonthNav, NumField, Panel, Switch, moneyField } from './shared';
import ImportUsage from './ImportUsage';

// [key, label, decimal]: credits come from the platform's export and can be fractional.
const FIELDS = [['credits', 'Credits', true], ['assets', 'Assets'], ['sites', 'Sites'], ['seats', 'Seats']];
const rowFor = (c, month) => (c.usage || []).find((u) => u.month === month);

// Up or down on the month before (only when both months were recorded).
function Change({ now, before }) {
  if (now === undefined || before === undefined) return null;
  const d = (Number(now) || 0) - (Number(before) || 0);
  if (!d) return null;
  return <div className={cn('text-[11.5px] tnum', d > 0 ? 'text-emerald-200' : 'text-rose-200')}>{d > 0 ? '+' : '−'}{count(Math.abs(d))}</div>;
}

function ClientUsage() {
  const { state, actions } = useStore();
  const editable = useAccess().canEdit('clients');
  // Opens on the latest month anyone has recorded, else this month.
  const [month, setMonth] = useState(() => state.clients.flatMap((c) => (c.usage || []).map((u) => u.month)).sort().pop() || monthStart(localYmd()));
  const [importing, setImporting] = useState(false);
  const prev = addMonths(month, -1);
  const rows = state.clients.map((c) => ({ c, u: rowFor(c, month), before: rowFor(c, prev) }));
  const reported = rows.filter((r) => r.u);
  const total = (k) => reported.reduce((t, r) => t + (Number(r.u[k]) || 0), 0);

  return (
    <div>
      {/* Five tiles: Credits takes two columns so the rows come out even (2 / 2 / 2 on phones, 2 + 1 / 3 on desktop). */}
      <div className="lg:[&>div]:grid-cols-3 [&>div>:first-child]:col-span-2">
        <KpiRow items={[
          { value: count(total('credits')), label: 'Credits', tint: '#f59e0b' },
          { value: `${reported.length}/${state.clients.length}`, label: 'Clients reporting', tint: '#475569' },
          { value: count(total('assets')), label: 'Assets', tint: '#579bfc' },
          { value: count(total('sites')), label: 'Sites', tint: '#0f9f8f' },
          { value: count(total('seats')), label: 'Seats', tint: '#7c3aed' },
        ]} />
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <MonthNav month={month} onChange={setMonth} />
        {editable && (
          <button type="button" onClick={() => setImporting(true)} className="chip inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 font-semibold">
            <Upload className="h-4 w-4" aria-hidden="true" />Import usage
          </button>
        )}
      </div>
      {editable && <ImportUsage open={importing} onClose={() => setImporting(false)} onImported={(months) => setMonth(months[0].month)} />}
      <div className="mt-4 overflow-x-auto scroll-thin rounded-[24px] glass glass-rim">
        <table className="w-full min-w-[760px] text-[13.5px]">
          <thead>
            <tr className="text-left text-[12px] dimmer">
              <th className="p-3 font-medium">Client</th>
              {FIELDS.map(([k, l]) => <th key={k} className="w-[110px] p-3 text-right font-medium">{l}</th>)}
              <th className="p-3 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr className="border-t rowline"><td colSpan={FIELDS.length + 2} className="p-3 dimmer">No clients.</td></tr>}
            {rows.map(({ c, u, before }) => (
              <tr key={c.id} className="border-t rowline align-top">
                <td className="p-3 font-semibold">{c.name}</td>
                {FIELDS.map(([k, l, decimal]) => (
                  <td key={k} className="p-2 text-right">
                    {editable ? (
                      <NumField decimal={decimal} format={count} className="!py-1.5 !px-2.5 text-right" aria-label={`${l}, ${c.name}`} value={u ? u[k] : ''}
                        onCommit={(n) => actions.upsertUsage(c.id, month, { [k]: n })} />
                    ) : <div className="px-1 py-1.5 font-semibold tnum">{u ? count(u[k]) : '—'}</div>}
                    <Change now={u?.[k]} before={before?.[k]} />
                  </td>
                ))}
                <td className="p-2">
                  {editable ? (
                    <input className="field !py-1.5" aria-label={`Notes, ${c.name}`} value={u?.notes || ''}
                      onChange={(e) => actions.upsertUsage(c.id, month, { notes: e.target.value })} />
                  ) : <div className="px-1 py-1.5 dim">{u?.notes || ''}</div>}
                </td>
              </tr>
            ))}
          </tbody>
          {reported.length > 0 && (
            <tfoot>
              <tr className="border-t rowline font-bold">
                <td className="p-3">Total</td>
                {FIELDS.map(([k]) => <td key={k} className="p-3 text-right tnum">{count(total(k))}</td>)}
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function SubscriptionForm({ onDone }) {
  const { actions } = useStore();
  const [f, setF] = useState({ name: '', vendor: '', category: 'Software', amount: '', cycle: 'monthly', renewsOn: '', notes: '' });
  const amount = parseAmount(f.amount);
  const amountOk = f.amount.trim() !== '' && Number.isFinite(amount) && amount >= 0;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    if (!f.name.trim() || !amountOk) return;
    const id = actions.addSubscription({ ...f, name: f.name.trim(), vendor: f.vendor.trim(), notes: f.notes.trim(), amount });
    if (id !== false) onDone();
  };
  return (
    <form onSubmit={submit} className={MODAL_FORM}>
      <div className="grid grid-cols-2 gap-3">
        <Labelled label="Name"><input className="field" value={f.name} onChange={set('name')} autoFocus /></Labelled>
        <Labelled label="Vendor"><input className="field" value={f.vendor} onChange={set('vendor')} /></Labelled>
        <Labelled label="Amount">
          <input className={cn('field tnum', f.amount.trim() && !amountOk && '!border-rose-400')} inputMode="decimal" value={f.amount} onChange={set('amount')} />
        </Labelled>
        <Labelled label="Billed">
          <select className="field" value={f.cycle} onChange={set('cycle')}>
            {Object.entries(SUBSCRIPTION_CYCLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Labelled>
        <Labelled label="Category">
          <select className="field" value={f.category} onChange={set('category')}>{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </Labelled>
        <Labelled label="Renews"><input type="date" className="field tnum" value={f.renewsOn} onChange={set('renewsOn')} /></Labelled>
      </div>
      <input className="field" placeholder="Notes" aria-label="Notes" value={f.notes} onChange={set('notes')} />
      <button type="submit" disabled={!f.name.trim() || !amountOk} className="btn-primary h-11 rounded-full font-semibold">Add subscription</button>
    </form>
  );
}

// Admins only (the shell doesn't render it for anyone else, and the store refuses the edits).
function SoftwareCosts() {
  const { state, actions } = useStore();
  const [adding, setAdding] = useState(false);
  const subs = state.subscriptions || [];
  const perMonth = subs.filter((s) => s.active).reduce((t, s) => t + monthlyCost(s), 0);
  const set = (s) => (patch) => actions.updateSubscription(s.id, patch);
  const remove = (s) => { if (window.confirm(`Delete ${s.name || 'this subscription'}?`)) actions.deleteSubscription(s.id); };
  return (
    <Panel title="Software costs" icon={CreditCard} count={subs.length} rim className="mt-8"
      action={(
        <div className="flex items-center gap-3">
          <span className="font-extrabold tnum">{money2(perMonth)}<span className="text-[12px] font-semibold dimmer"> / month</span></span>
          <button type="button" onClick={() => setAdding(true)} aria-label="Add subscription" title="Add subscription"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full chip"><Plus className="h-4 w-4" /></button>
        </div>
      )}>
      <div className="relative overflow-x-auto scroll-thin">
        <table className="w-full min-w-[1040px] text-[13.5px]">
          <thead>
            <tr className="text-left text-[12px] dimmer">
              <th className="px-3 pb-2 font-medium">Name</th><th className="px-3 pb-2 font-medium">Vendor</th><th className="w-[140px] px-3 pb-2 font-medium">Category</th>
              <th className="w-[112px] px-3 pb-2 text-right font-medium">Amount</th><th className="w-[132px] px-3 pb-2 font-medium">Billed</th>
              <th className="w-[100px] px-3 pb-2 text-right font-medium">Per month</th><th className="w-[164px] px-3 pb-2 font-medium">Renews</th>
              <th className="w-[72px] px-3 pb-2 font-medium">Active</th><th className="w-[48px] px-3 pb-2"><span className="sr-only">Delete</span></th>
            </tr>
          </thead>
          <tbody>
            {subs.length === 0 && <tr className="border-t rowline"><td colSpan={9} className="p-3 dimmer">No subscriptions.</td></tr>}
            {subs.map((s) => (
              <tr key={s.id} className={cn('border-t rowline', !s.active && 'opacity-60')}>
                <td className="p-2"><input className="field !py-1.5 font-semibold" aria-label="Name" value={s.name} onChange={(e) => set(s)({ name: e.target.value })} /></td>
                <td className="p-2"><input className="field !py-1.5" aria-label={`Vendor, ${s.name}`} value={s.vendor} onChange={(e) => set(s)({ vendor: e.target.value })} /></td>
                <td className="p-2">
                  <select className="field !py-1.5" aria-label={`Category, ${s.name}`} value={s.category} onChange={(e) => set(s)({ category: e.target.value })}>
                    {[...new Set([...EXPENSE_CATEGORIES, s.category])].map((c) => <option key={c}>{c}</option>)}
                  </select>
                </td>
                <td className="p-2"><NumField decimal format={moneyField} className="!py-1.5 !px-2.5 text-right" aria-label={`Amount, ${s.name}`} value={s.amount} onCommit={(amount) => set(s)({ amount })} /></td>
                <td className="p-2">
                  <select className="field !py-1.5" aria-label={`Billed, ${s.name}`} value={s.cycle} onChange={(e) => set(s)({ cycle: e.target.value })}>
                    {Object.entries(SUBSCRIPTION_CYCLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </td>
                <td className="whitespace-nowrap p-3 text-right font-semibold tnum">{money2(monthlyCost(s))}</td>
                <td className="p-2"><input type="date" className="field !py-1.5 !px-3 tnum" aria-label={`Renews, ${s.name}`} value={s.renewsOn} onChange={(e) => set(s)({ renewsOn: e.target.value })} /></td>
                <td className="p-2"><Switch checked={s.active} label={`${s.name} active`} onChange={(active) => set(s)({ active })} /></td>
                <td className="p-2 text-right">
                  <button type="button" onClick={() => remove(s)} aria-label={`Delete ${s.name}`} title="Delete"
                    className="grid h-8 w-8 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><Trash2 className="h-4 w-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
          {subs.length > 0 && (
            <tfoot>
              <tr className="border-t rowline font-bold">
                <td className="p-3" colSpan={5}>Total</td>
                <td className="whitespace-nowrap p-3 text-right tnum">{money2(perMonth)}</td>
                <td className="whitespace-nowrap p-3 dim tnum" colSpan={3}>{money2(perMonth * 12)} / year</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add subscription" width={480}>
        <SubscriptionForm onDone={() => setAdding(false)} />
      </Modal>
    </Panel>
  );
}

export default function UsageTab() {
  const { isAdmin } = useAccess();
  return (
    <div>
      <ClientUsage />
      {isAdmin && <SoftwareCosts />}
    </div>
  );
}
