// Invoices tab: every client's invoices, Awaiting approval first, with a status filter. Admins approve, send (from
// their own Gmail) or mark as sent, print, and generate the invoices billing plans have due (automatically once per
// session too).
import { useEffect, useState } from 'react';
import { CalendarClock, Hourglass, Receipt } from 'lucide-react';
import { useStore } from '@/data/store';
import { INVOICE_STATUS } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { Drawer, KpiRow } from '@/components/ui';
import { compactMoney, invoiceTotals, money, owingOn, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { InvoiceActions, InvoiceEditor, PrintButton, PrintSheet } from './invoice';
import { OPEN, Panel, StatusPill, invoicesOf, owedTotals } from './shared';
import SendInvoice from './SendInvoice';

// Plans' due invoices are generated once per signed-in admin per session (page load).
const generated = new Set();

/** Admins: generate due invoices when Clients opens, once per session. */
export function useAutoGenerate() {
  const { state, actions } = useStore();
  const { isAdmin } = useAccess();
  useEffect(() => {
    const me = state.me;
    if (!isAdmin || !me || generated.has(me)) return;
    generated.add(me);
    actions.generateDueInvoices().then((n) => { if (n === false) generated.delete(me); }).catch(() => generated.delete(me));
  }, [isAdmin, state.me, actions]);
}

function GenerateButton() {
  const { actions } = useStore();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const run = async () => {
    setBusy(true);
    setNote('');
    try {
      const n = await actions.generateDueInvoices();
      setNote(n === false ? 'Couldn’t generate' : n ? `${n} new` : 'Nothing due');
    } catch {
      setNote('Couldn’t generate');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <span role="status" className="text-[12.5px] dim">{note}</span>
      <button type="button" onClick={run} disabled={busy}
        className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full chip px-4 font-semibold disabled:opacity-60">
        <CalendarClock className="h-4 w-4" aria-hidden="true" />Generate due invoices
      </button>
    </div>
  );
}

function InvoiceRow({ c, inv, onOpen, onPrint, onSend }) {
  const { state } = useStore();
  const { isAdmin } = useAccess();
  const total = invoiceTotals(inv).total;
  const owing = isAdmin && OPEN.includes(inv.status) ? owingOn(inv, state.payments) : total;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t rowline px-5 py-3">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 basis-[200px] text-left">
        <div className="truncate font-semibold hover:underline">{c.name}</div>
        <div className="text-[12px] dimmer tnum">
          {inv.number} · {inv.status === 'Paid' && inv.paidOn ? `Paid ${shortDate(inv.paidOn)}` : `Due ${shortDate(inv.due)}`}
        </div>
      </button>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        <div className="text-right tnum">
          <div className="font-bold">{money(owing)}</div>
          {owing !== total && <div className="text-[11.5px] dimmer">of {money(total)}</div>}
        </div>
        <StatusPill status={inv.status} />
        {isAdmin && <InvoiceActions c={c} inv={inv} onSend={onSend} />}
        {isAdmin && <PrintButton inv={inv} iconOnly onPrint={onPrint} />}
      </div>
    </li>
  );
}

export default function InvoicesTab() {
  const { state } = useStore();
  const { isAdmin } = useAccess();
  const [filter, setFilter] = useState('All');
  const [open, setOpen] = useState(null); // { clientId, invId }
  const [printing, setPrinting] = useState(null); // { clientId, invId }
  // The email dialog for a row lives here: once approved, the row moves to another panel (or out of the filter).
  const [sending, setSending] = useState(null); // { clientId, invId }

  const all = invoicesOf(state.clients);
  const totals = owedTotals(state.clients, isAdmin ? state.payments : []); // staff never see money in, as in the rows
  const counts = all.reduce((m, { inv }) => ({ ...m, [inv.status]: (m[inv.status] || 0) + 1 }), {});
  const statuses = Object.keys(INVOICE_STATUS).filter((s) => counts[s] || s === filter);
  const shown = filter === 'All' ? all : all.filter(({ inv }) => inv.status === filter);
  // Under All, the ones awaiting approval get their own panel on top.
  const awaiting = filter === 'All' ? shown.filter(({ inv }) => inv.status === 'Awaiting approval') : [];
  const rest = filter === 'All' ? shown.filter(({ inv }) => inv.status !== 'Awaiting approval') : shown;

  const find = (ref) => {
    const c = ref && state.clients.find((x) => x.id === ref.clientId);
    const inv = c?.invoices.find((i) => i.id === ref.invId);
    return inv ? { c, inv } : null;
  };
  const current = find(open);
  const toPrint = find(printing);
  const toSend = find(sending);

  const rows = (list) => (
    <ul>
      {list.map(({ c, inv }) => (
        <InvoiceRow key={inv.id} c={c} inv={inv}
          onOpen={() => setOpen({ clientId: c.id, invId: inv.id })}
          onPrint={() => setPrinting({ clientId: c.id, invId: inv.id })}
          onSend={() => setSending({ clientId: c.id, invId: inv.id })} />
      ))}
    </ul>
  );

  return (
    <div>
      <KpiRow items={[
        { value: totals.awaiting, label: 'Awaiting approval', tint: '#b45309' },
        { value: compactMoney(totals.outstanding), label: 'Owed', tint: '#579bfc' },
        { value: compactMoney(totals.overdue), label: 'Overdue', tint: '#e2445c' },
        { value: compactMoney(totals.paid), label: 'Paid', tint: '#0f9f6f' },
      ]} />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Status" className="flex flex-wrap gap-1.5">
          {['All', ...statuses].map((s) => (
            <button key={s} type="button" aria-pressed={filter === s} onClick={() => setFilter(s)}
              className={cn('inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px]', filter === s ? 'chip-on font-semibold' : 'chip dim')}>
              {s}<span className={cn('text-[11.5px] tnum', filter === s ? 'opacity-70' : 'dimmer')}>{s === 'All' ? all.length : counts[s] || 0}</span>
            </button>
          ))}
        </div>
        {isAdmin && <GenerateButton />}
      </div>

      <div className="mt-6 flex flex-col gap-6">
        {awaiting.length > 0 && (
          <Panel title="Awaiting approval" icon={Hourglass} count={awaiting.length} rim>{rows(awaiting)}</Panel>
        )}
        <Panel title={filter === 'All' ? 'Invoices' : filter} icon={Receipt} count={rest.length} rim={!awaiting.length}>
          {rest.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">No invoices.</p> : rows(rest)}
        </Panel>
      </div>

      <Drawer open={!!current} onClose={() => setOpen(null)} title={current?.inv.number || ''} width={560}>
        {current && <InvoiceEditor c={current.c} inv={current.inv} />}
      </Drawer>
      {isAdmin && toSend && <SendInvoice key={toSend.inv.id} c={toSend.c} inv={toSend.inv} onClose={() => setSending(null)} />}
      {isAdmin && toPrint && <PrintSheet key={toPrint.inv.id} c={toPrint.c} inv={toPrint.inv} onDone={() => setPrinting(null)} />}
    </div>
  );
}
