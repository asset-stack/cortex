// Expenses (admins only): amounts include GST, which defaults to one eleventh; each can carry a receipt.
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { EXPENSE_CATEGORIES } from '@/data/boards';
import { KpiRow, Modal } from '@/components/ui';
import { compactMoney, gstIncluded, localYmd, money2, monthLabel, parseAmount, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { FILE_INPUT, FileLink, Labelled, MODAL_FORM } from './shared';

const sum = (list, k) => Math.round(list.reduce((t, x) => t + (Number(x[k]) || 0) * 100, 0)) / 100;

function ExpenseForm({ onDone }) {
  const { state, actions } = useStore();
  const [f, setF] = useState({ date: localYmd(), vendor: '', category: EXPENSE_CATEGORIES[0], amount: '', gst: '', clientId: '', notes: '' });
  const [gstTyped, setGstTyped] = useState(false); // GST follows the amount until it is typed over
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const amount = parseAmount(f.amount);
  const gst = parseAmount(f.gst);
  const amountOk = f.amount.trim() !== '' && Number.isFinite(amount) && amount > 0;
  const gstOk = f.gst.trim() === '' || Number.isFinite(gst);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const onAmount = (e) => {
    const v = e.target.value;
    const n = parseAmount(v);
    setF({ ...f, amount: v, gst: gstTyped ? f.gst : v.trim() && Number.isFinite(n) ? gstIncluded(n).toFixed(2) : '' });
  };
  const onGst = (e) => {
    setGstTyped(e.target.value.trim() !== '');
    setF({ ...f, gst: e.target.value });
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!f.vendor.trim() || !amountOk || !gstOk || busy) return;
    setBusy(true);
    setError('');
    const id = await actions.addExpense({
      date: f.date || localYmd(), vendor: f.vendor.trim(), category: f.category, amount, gst: f.gst.trim() === '' ? '' : gst,
      clientId: f.clientId, notes: f.notes.trim(),
    }, file || undefined).catch(() => false);
    setBusy(false);
    if (id === false) setError('Couldn’t save the expense');
    else onDone();
  };
  return (
    <form onSubmit={submit} className={MODAL_FORM}>
      <div className="grid grid-cols-2 gap-3">
        <Labelled label="Date"><input type="date" className="field tnum" value={f.date} onChange={set('date')} /></Labelled>
        <Labelled label="Category">
          <select className="field" value={f.category} onChange={set('category')}>{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </Labelled>
      </div>
      <Labelled label="Vendor"><input className="field" value={f.vendor} onChange={set('vendor')} autoFocus /></Labelled>
      <div className="grid grid-cols-2 gap-3">
        <Labelled label="Amount (inc GST)">
          <input className={cn('field tnum', f.amount.trim() && !amountOk && '!border-rose-400')} inputMode="decimal" value={f.amount} onChange={onAmount} />
        </Labelled>
        <Labelled label="GST">
          <input className={cn('field tnum', !gstOk && '!border-rose-400')} inputMode="decimal" value={f.gst} onChange={onGst} />
        </Labelled>
      </div>
      <Labelled label="Client">
        <select className="field" value={f.clientId} onChange={set('clientId')}>
          <option value="">None</option>
          {state.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Labelled>
      <Labelled label="Receipt"><input type="file" accept="image/*,application/pdf" className={FILE_INPUT} onChange={(e) => setFile(e.target.files?.[0] || null)} /></Labelled>
      <input className="field" placeholder="Notes" aria-label="Notes" value={f.notes} onChange={set('notes')} />
      {error && <div role="alert" className="text-[12.5px] text-rose-200">{error}</div>}
      <button type="submit" disabled={!f.vendor.trim() || !amountOk || !gstOk || busy} className="btn-primary h-11 rounded-full font-semibold">
        {busy ? 'Saving…' : 'Add expense'}
      </button>
    </form>
  );
}

/** `adding` / `onCloseAdd`: the page header's Add expense. */
export default function ExpensesTab({ adding, onCloseAdd }) {
  const { state, actions } = useStore();
  const [month, setMonth] = useState(''); // '' = all months
  const expenses = [...(state.expenses || [])].sort((a, b) => b.date.localeCompare(a.date));
  const today = localYmd();
  const thisMonth = expenses.filter((x) => x.date.slice(0, 7) === today.slice(0, 7));
  // Calendar quarters, as the BAS uses (Jul–Sep, Oct–Dec, …).
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const thisQuarter = expenses.filter((x) => x.date.slice(0, 4) === today.slice(0, 4) && Math.floor((Number(x.date.slice(5, 7)) - 1) / 3) === q);
  const months = [...new Set(expenses.map((x) => x.date.slice(0, 7)).filter(Boolean))];
  const shown = month ? expenses.filter((x) => x.date.slice(0, 7) === month) : expenses;
  const clientName = (id) => state.clients.find((c) => c.id === id)?.name || '';
  const remove = (x) => {
    if (window.confirm(`Delete the ${x.vendor || 'expense'} expense of ${money2(x.amount)}?`)) actions.deleteExpense(x.id);
  };

  return (
    <div>
      <KpiRow items={[
        { value: compactMoney(sum(thisMonth, 'amount')), label: 'This month', tint: '#475569' },
        { value: compactMoney(sum(thisMonth, 'gst')), label: 'GST this month', tint: '#7c3aed' },
        { value: compactMoney(sum(thisQuarter, 'gst')), label: 'GST this quarter', tint: '#0f9f8f' },
        { value: expenses.filter((x) => !x.receiptPath).length, label: 'No receipt', tint: '#b45309' },
      ]} />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <select className="field !w-auto !rounded-full !py-2" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">All months</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      </div>

      <div className="mt-4 overflow-x-auto scroll-thin rounded-[24px] glass glass-rim">
        <table className="w-full min-w-[780px] text-[13.5px]">
          <thead>
            <tr className="text-left text-[12px] dimmer">
              <th className="p-3 font-medium">Date</th><th className="p-3 font-medium">Vendor</th><th className="p-3 font-medium">Category</th>
              <th className="p-3 font-medium">Client</th><th className="p-3 text-right font-medium">Amount</th><th className="p-3 text-right font-medium">GST</th>
              <th className="p-3 font-medium">Receipt</th><th className="p-3"><span className="sr-only">Delete</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr className="border-t rowline"><td colSpan={8} className="p-3 dimmer">No expenses.</td></tr>}
            {shown.map((x) => (
              <tr key={x.id} className="border-t rowline align-top">
                <td className="whitespace-nowrap p-3 dim tnum">{shortDate(x.date)}</td>
                <td className="p-3"><div className="font-semibold">{x.vendor || '—'}</div>{x.notes && <div className="text-[12px] dimmer">{x.notes}</div>}</td>
                <td className="p-3 dim">{x.category}</td>
                <td className="p-3 dim">{clientName(x.clientId) || '—'}</td>
                <td className="whitespace-nowrap p-3 text-right font-semibold tnum">{money2(x.amount)}</td>
                <td className="whitespace-nowrap p-3 text-right dim tnum">{money2(x.gst)}</td>
                <td className="p-3"><FileLink path={x.receiptPath} /></td>
                <td className="p-2 text-right">
                  <button type="button" onClick={() => remove(x)} aria-label={`Delete ${x.vendor || 'expense'}`} title="Delete"
                    className="grid h-8 w-8 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><Trash2 className="h-4 w-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
          {shown.length > 0 && (
            <tfoot>
              <tr className="border-t rowline font-bold">
                <td className="p-3" colSpan={4}>Total</td>
                <td className="whitespace-nowrap p-3 text-right tnum">{money2(sum(shown, 'amount'))}</td>
                <td className="whitespace-nowrap p-3 text-right tnum">{money2(sum(shown, 'gst'))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <Modal open={adding} onClose={onCloseAdd} title="Add expense" width={480}>
        <ExpenseForm onDone={onCloseAdd} />
      </Modal>
    </div>
  );
}
