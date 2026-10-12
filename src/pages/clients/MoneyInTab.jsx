// Money in (admins only): the weekly bank screenshots, invoices still to be paid with Mark paid, and payments received.
import { useState } from 'react';
import { Banknote, HandCoins, Images, Receipt } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { Avatar, KpiRow, Modal } from '@/components/ui';
import { mondayOf } from '@/lib/automations';
import { compactMoney, fullDate, invoiceTotals, localYmd, money2, owingOn, parseAmount, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { FILE_INPUT, FileLink, Labelled, MODAL_FORM, OPEN, Panel, StatusPill, invoicesOf, owedTotals } from './shared';

const byWeek = (a, b) => b.weekStart.localeCompare(a.weekStart) || String(b.createdAt).localeCompare(String(a.createdAt));

function UploadForm({ onDone }) {
  const { actions } = useStore();
  const [week, setWeek] = useState(() => mondayOf(localYmd()));
  const [file, setFile] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError('');
    const id = await actions.addBankStatement({ weekStart: mondayOf(week || localYmd()), file, note: note.trim() }).catch(() => false);
    setBusy(false);
    if (id === false) setError('Upload failed');
    else onDone();
  };
  return (
    <form onSubmit={submit} className={MODAL_FORM}>
      <Labelled label="Week of"><input type="date" className="field tnum" required value={week} onChange={(e) => setWeek(e.target.value)} /></Labelled>
      <Labelled label="Screenshot"><input type="file" accept="image/*,application/pdf" required className={FILE_INPUT} onChange={(e) => setFile(e.target.files?.[0] || null)} /></Labelled>
      <input className="field" placeholder="Note" aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <div role="alert" className="text-[12.5px] text-rose-200">{error}</div>}
      <button type="submit" disabled={!file || busy} className="btn-primary h-11 rounded-full font-semibold">{busy ? 'Uploading…' : 'Upload'}</button>
    </form>
  );
}

function MarkPaidForm({ c, inv, onDone }) {
  const { state, actions } = useStore();
  const owing = owingOn(inv, state.payments);
  const statements = [...(state.bankStatements || [])].sort(byWeek);
  const today = localYmd();
  const [f, setF] = useState(() => ({
    amount: owing.toFixed(2), receivedOn: today, reference: inv.number,
    statementId: statements.find((b) => b.weekStart === mondayOf(today))?.id || '',
  }));
  const amount = parseAmount(f.amount);
  const valid = f.amount.trim() !== '' && Number.isFinite(amount) && amount > 0;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    const id = actions.recordPayment({
      invoiceId: inv.id, clientId: c.id, amount, receivedOn: f.receivedOn || today, reference: f.reference.trim(), statementId: f.statementId,
    });
    if (id !== false) onDone();
  };
  return (
    <form onSubmit={submit} className={MODAL_FORM}>
      <div className="flex items-baseline justify-between gap-3 rounded-2xl chip px-4 py-3">
        <span className="min-w-0 truncate dim">{c.name}</span><span className="font-extrabold tnum">{money2(owing)}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Labelled label="Amount (inc GST)">
          <input className={cn('field tnum', !valid && f.amount.trim() !== '' && '!border-rose-400')} inputMode="decimal" value={f.amount} onChange={set('amount')} autoFocus />
        </Labelled>
        <Labelled label="Received"><input type="date" className="field tnum" value={f.receivedOn} onChange={set('receivedOn')} /></Labelled>
      </div>
      <Labelled label="Reference"><input className="field" value={f.reference} onChange={set('reference')} /></Labelled>
      <Labelled label="Bank screenshot">
        <select className="field" value={f.statementId} onChange={set('statementId')}>
          <option value="">None</option>
          {statements.map((b) => <option key={b.id} value={b.id}>Week of {fullDate(b.weekStart)}</option>)}
        </select>
      </Labelled>
      <button type="submit" disabled={!valid} className="btn-primary h-11 rounded-full font-semibold">
        {valid && Math.round(amount * 100) < Math.round(owing * 100) ? 'Record part payment' : 'Mark paid'}
      </button>
    </form>
  );
}

function UnpaidRow({ c, inv, today, onPay }) {
  const { state } = useStore();
  const total = invoiceTotals(inv).total;
  const owing = owingOn(inv, state.payments);
  const late = inv.status === 'Overdue' || (inv.due && inv.due < today);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t rowline px-5 py-3">
      <div className="min-w-0 flex-1 basis-[180px]">
        <div className="truncate font-semibold">{c.name}</div>
        <div className="text-[12px] dimmer tnum">{inv.number} · <span className={cn(late && 'text-rose-200')}>Due {shortDate(inv.due)}</span></div>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        <div className="text-right tnum">
          <div className="font-bold">{money2(owing)}</div>
          {owing !== total && <div className="text-[11.5px] dimmer">of {money2(total)}</div>}
        </div>
        <StatusPill status={inv.status} />
        <button type="button" onClick={onPay} aria-label={`Mark ${inv.number} paid`}
          className="inline-flex items-center gap-1.5 rounded-full chip px-3 py-1.5 text-[12.5px] font-semibold">
          <HandCoins className="h-3.5 w-3.5" aria-hidden="true" />Mark paid
        </button>
      </div>
    </li>
  );
}

/** `adding` / `onCloseAdd`: the page header's Upload screenshot. */
export default function MoneyInTab({ adding, onCloseAdd }) {
  const { state } = useStore();
  const users = useUsers();
  const [paying, setPaying] = useState(null); // { clientId, invId }
  const today = localYmd();
  const payments = state.payments || [];
  const statements = [...(state.bankStatements || [])].sort(byWeek);
  const totals = owedTotals(state.clients, payments);
  const unpaid = invoicesOf(state.clients).filter(({ inv }) => OPEN.includes(inv.status))
    .sort((a, b) => String(a.inv.due).localeCompare(String(b.inv.due)) || a.inv.number.localeCompare(b.inv.number));
  const received = payments.filter((p) => p.receivedOn.slice(0, 7) === today.slice(0, 7)).reduce((t, p) => t + (Number(p.amount) || 0), 0);
  const weekDone = statements.some((b) => b.weekStart === mondayOf(today));
  const recent = [...payments].sort((a, b) => b.receivedOn.localeCompare(a.receivedOn)).slice(0, 10);
  const invoiceOf = (p) => state.clients.find((c) => c.id === p.clientId)?.invoices.find((i) => i.id === p.invoiceId);
  const target = paying && state.clients.find((c) => c.id === paying.clientId);
  const targetInv = target?.invoices.find((i) => i.id === paying.invId);

  return (
    <div>
      <KpiRow items={[
        { value: compactMoney(totals.outstanding), label: 'Unpaid', tint: '#579bfc' },
        { value: compactMoney(totals.overdue), label: 'Overdue', tint: '#e2445c' },
        { value: compactMoney(received), label: 'Received this month', tint: '#0f9f6f' },
        { value: weekDone ? 'Done' : 'Due', label: 'This week’s screenshot', tint: weekDone ? '#475569' : '#b45309' },
      ]} />

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Unpaid invoices" icon={Receipt} count={unpaid.length} rim>
            {unpaid.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">All paid.</p> : (
              <ul>
                {unpaid.map(({ c, inv }) => (
                  <UnpaidRow key={inv.id} c={c} inv={inv} today={today} onPay={() => setPaying({ clientId: c.id, invId: inv.id })} />
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Payments" icon={Banknote} count={payments.length}>
            {recent.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">No payments yet.</p> : (
              <ul>
                {recent.map((p) => {
                  const c = state.clients.find((x) => x.id === p.clientId);
                  const inv = invoiceOf(p);
                  return (
                    <li key={p.id} className="flex items-center gap-3 border-t rowline px-5 py-3">
                      <span className="w-[64px] shrink-0 text-[12.5px] dim tnum">{shortDate(p.receivedOn)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">{c?.name || '—'}</div>
                        <div className="truncate text-[12px] dimmer">{[inv?.number, p.reference !== inv?.number && p.reference].filter(Boolean).join(' · ') || '—'}</div>
                      </div>
                      <span className="shrink-0 font-bold text-emerald-200 tnum">{money2(p.amount)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <Panel title="Bank screenshots" icon={Images} count={statements.length} className="self-start">
          {statements.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">None uploaded.</p> : (
            <ul>
              {statements.map((b) => {
                const linked = payments.filter((p) => p.statementId === b.id);
                const sum = linked.reduce((t, p) => t + (Number(p.amount) || 0), 0);
                return (
                  <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t rowline px-5 py-3">
                    <div className="min-w-0 flex-1 basis-[160px]">
                      <div className="font-semibold">Week of {fullDate(b.weekStart)}</div>
                      {b.note && <div className="text-[12.5px] dim break-words">{b.note}</div>}
                      {linked.length > 0 && (
                        <div className="text-[12px] dimmer tnum">{linked.length} {linked.length === 1 ? 'payment' : 'payments'} · {money2(sum)}</div>
                      )}
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      {users[b.uploadedBy] && <Avatar userId={b.uploadedBy} size={24} />}
                      <FileLink path={b.filePath} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Modal open={adding} onClose={onCloseAdd} title="Upload screenshot">
        <UploadForm onDone={onCloseAdd} />
      </Modal>
      <Modal open={!!targetInv} onClose={() => setPaying(null)} title={targetInv ? `Mark ${targetInv.number} paid` : ''}>
        {targetInv && <MarkPaidForm key={targetInv.id} c={target} inv={targetInv} onDone={() => setPaying(null)} />}
      </Modal>
    </div>
  );
}
