// One invoice: the editor card (a client's drawer, the Invoices tab's drawer), the printed tax invoice, and the
// admin actions (Approve, Mark as sent, Print / PDF).
import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BadgeCheck, Plus, Printer, Send, Trash2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { INVOICE_STATUS } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { LabelPicker } from '@/components/ui';
import { daysBetween, formatAbn, formatBsb, fullDate, invoiceTotals, isBadAmount, money2, paidTowards, parseAmount, unitMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ADMIN_STATUSES, UNISSUED, hasBadAmounts } from './shared';

const str = (v) => String(v ?? '').trim();

// Staff never move an invoice to (or away from) the statuses only admins set.
const STAFF_STATUS = Object.fromEntries(Object.entries(INVOICE_STATUS).filter(([s]) => !ADMIN_STATUSES.includes(s)));

// The printed copy (Print / PDF): an Australian tax invoice. Hidden on screen and in an ordinary browser print;
// shown only for its own Print / PDF (html.printing-invoice in index.css, which also styles .tax-invoice).
export function TaxInvoice({ c, inv, org, t }) {
  const abn = str(org.abn);
  const kind = abn ? 'Tax invoice' : 'Invoice'; // without the supplier's ABN it isn't a valid tax invoice
  // Terms come from the invoice's own dates, so the printed copy can't contradict itself if Settings change later.
  const orgDays = parseInt(org.paymentTermsDays, 10);
  const days = daysBetween(inv.issued, inv.due) ?? (orgDays >= 0 ? orgDays : 30);
  const contact = [str(org.email), str(org.phone)].filter(Boolean).join(' · ');
  const bank = [['Account name', str(org.bankAccountName)], ['BSB', formatBsb(org.bsb)], ['Account number', str(org.accountNumber)]].filter(([, v]) => v);
  return (
    <div className="tax-invoice hidden">
      <header className="ti-row">
        <h1>{UNISSUED.includes(inv.status) ? `Draft ${kind.toLowerCase()}` : kind}</h1>
        <div className="ti-supplier">
          <div className="ti-name">{str(org.businessName) || 'AssetStack'}</div>
          {abn && <div>ABN {formatAbn(abn)}</div>}
          {str(org.address) && <div className="ti-pre">{str(org.address)}</div>}
          {contact && <div>{contact}</div>}
        </div>
      </header>
      <section className="ti-row ti-parties">
        <div>
          <h2>Bill to</h2>
          <div className="ti-name">{c.name}</div>
          {str(c.abn) && <div>ABN {formatAbn(c.abn)}</div>}
          {str(c.billingAddress) && <div className="ti-pre">{str(c.billingAddress)}</div>}
        </div>
        <dl className="ti-meta">
          <dt>Invoice number</dt><dd>{inv.number}</dd>
          <dt>Issue date</dt><dd>{fullDate(inv.issued)}</dd>
          <dt>Due date</dt><dd>{fullDate(inv.due)}</dd>
          {['Paid', 'Overdue', 'Void'].includes(inv.status) && <><dt>Status</dt><dd>{inv.status}</dd></>}
        </dl>
      </section>
      <table className="ti-lines">
        <thead>
          <tr><th>Description</th><th className="num">Qty</th><th className="num">Unit price (ex GST)</th><th className="num">GST</th><th className="num">Amount (inc GST)</th></tr>
        </thead>
        <tbody>
          {inv.lines.map((l, i) => (
            <tr key={l.id}>
              <td className="ti-pre">{l.desc}</td><td className="num">{str(l.qty)}</td><td className="num">{unitMoney(parseAmount(l.rate) || 0)}</td>
              <td className="num">{money2(t.lines[i].gst)}</td><td className="num">{money2(t.lines[i].inc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="ti-totals">
        <tbody>
          <tr><th>Subtotal (ex GST)</th><td className="num">{money2(t.subtotal)}</td></tr>
          <tr><th>GST 10%</th><td className="num">{money2(t.gst)}</td></tr>
          <tr className="ti-total"><th>Total (inc GST)</th><td className="num">{money2(t.total)}</td></tr>
        </tbody>
      </table>
      <p className="ti-gst-note">Total includes GST of {money2(t.gst)}</p>
      <section className="ti-pay">
        <h2>Payment</h2>
        <dl className="ti-meta">
          {bank.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
          <dt>Reference</dt><dd>{inv.number}</dd>
          <dt>Terms</dt><dd>{days === 0 ? 'Due on receipt' : `Due in ${days} ${days === 1 ? 'day' : 'days'}`}</dd>
        </dl>
      </section>
    </div>
  );
}

// Print just this invoice card: flag it and the page for the print CSS, and clear the flags afterwards.
// (A data attribute, so React's className updates can't drop it mid-print.)
export function printCard(el, onDone) {
  if (!el) { onDone?.(); return; }
  el.setAttribute('data-print-target', '');
  document.documentElement.classList.add('printing-invoice');
  window.addEventListener('afterprint', () => {
    el.removeAttribute('data-print-target');
    document.documentElement.classList.remove('printing-invoice');
    onDone?.();
  }, { once: true });
  window.print();
}

/** Prints one invoice from the page itself (the Invoices tab), where there's no drawer card to print: its tax invoice
 *  goes into a sheet beside #root (.print-sheet in index.css), prints, and `onDone` removes it. */
export function PrintSheet({ c, inv, onDone }) {
  const { state } = useStore();
  const ref = useRef(null);
  const started = useRef(false); // StrictMode runs effects twice
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    printCard(ref.current, onDone);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div ref={ref} className="invoice-card print-sheet" aria-hidden="true">
      <TaxInvoice c={c} inv={inv} org={state.org || {}} t={invoiceTotals(inv)} />
    </div>,
    document.body,
  );
}

const ACTION = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50';

/** Admins: Approve (Draft / Awaiting approval) or Mark as sent (Approved). Nothing for anyone else. */
export function InvoiceActions({ c, inv }) {
  const { actions } = useStore();
  const { isAdmin } = useAccess();
  const [busy, setBusy] = useState(false);
  if (!isAdmin) return null;
  if (UNISSUED.includes(inv.status)) {
    const bad = hasBadAmounts(inv);
    const approve = async () => {
      setBusy(true);
      try { await actions.approveInvoice(c.id, inv.id); } finally { setBusy(false); }
    };
    return (
      <button type="button" onClick={approve} disabled={busy || bad} title={bad ? 'Fix the highlighted amounts first' : undefined}
        aria-label={`Approve ${inv.number}`} className={cn(ACTION, 'btn-primary')}>
        <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />Approve
      </button>
    );
  }
  if (inv.status === 'Approved') {
    return (
      <button type="button" onClick={() => actions.markInvoiceSent(c.id, inv.id)} aria-label={`Mark ${inv.number} as sent`} className={cn(ACTION, 'chip')}>
        <Send className="h-3.5 w-3.5" aria-hidden="true" />Mark as sent
      </button>
    );
  }
  return null;
}

export function PrintButton({ inv, onPrint, iconOnly = false }) {
  const bad = hasBadAmounts(inv);
  return (
    <button type="button" onClick={onPrint} disabled={bad} title={bad ? 'Fix the highlighted amounts first' : iconOnly ? 'Print / PDF' : undefined}
      aria-label={iconOnly ? `Print / PDF ${inv.number}` : undefined}
      className={cn(iconOnly ? 'grid h-8 w-8 shrink-0 place-items-center rounded-full chip disabled:cursor-not-allowed disabled:opacity-50' : cn(ACTION, 'chip'))}>
      <Printer className="h-3.5 w-3.5" aria-hidden="true" />{!iconOnly && 'Print / PDF'}
    </button>
  );
}

/** The invoice card: status, lines, totals and actions, with its printable tax invoice. Read-only at view access;
 *  staff can't approve, send, void or mark paid, and only admins print (the PDF is what goes to the client). */
export function InvoiceEditor({ c, inv }) {
  const { state, actions } = useStore();
  const access = useAccess();
  const editable = access.canEdit('clients');
  const { isAdmin } = access;
  const ref = useRef(null);
  const org = state.org || {};
  const t = invoiceTotals(inv);
  const badAmounts = hasBadAmounts(inv);
  const paid = isAdmin ? paidTowards(state.payments, inv.id) : 0;
  const statusLocked = !editable || (!isAdmin && ADMIN_STATUSES.includes(inv.status));
  const printThis = () => { if (!badAmounts) printCard(ref.current); };
  const line = (l, k) => (e) => actions.updateInvoiceLine(c.id, inv.id, l.id, { [k]: e.target.value });
  return (
    <div ref={ref} className="invoice-card rounded-2xl chip p-4">
      <div className="no-print">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="font-extrabold">{inv.number}</div>
            <div className="text-[12px] dimmer">
              {c.name} · Issued {fullDate(inv.issued)} · Due {fullDate(inv.due)}{inv.status === 'Paid' && inv.paidOn ? ` · Paid ${fullDate(inv.paidOn)}` : ''}
            </div>
          </div>
          <div className="w-[156px]">
            <LabelPicker label={`${inv.number} status`} value={inv.status} options={statusLocked || isAdmin ? INVOICE_STATUS : STAFF_STATUS}
              allowEmpty={false} readOnly={statusLocked} onChange={(v) => actions.updateInvoice(c.id, inv.id, { status: v })} />
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {inv.lines.map((l) => (
            <div key={l.id} className={cn('grid items-center gap-2', editable ? 'grid-cols-[1fr_56px_96px_28px]' : 'grid-cols-[1fr_56px_96px]')}>
              <input className="field !py-1.5" placeholder="Description" aria-label="Description" value={l.desc} readOnly={!editable} onChange={line(l, 'desc')} />
              <input className={cn('field !py-1.5 !px-2 text-right tnum', isBadAmount(l.qty) && '!border-rose-400')} aria-label="Quantity"
                aria-invalid={isBadAmount(l.qty) || undefined} inputMode="decimal" value={l.qty} readOnly={!editable} onChange={line(l, 'qty')} />
              <input className={cn('field !py-1.5 !px-2 text-right tnum', isBadAmount(l.rate) && '!border-rose-400')} aria-label="Rate (ex GST)"
                aria-invalid={isBadAmount(l.rate) || undefined} inputMode="decimal" value={l.rate} readOnly={!editable} onChange={line(l, 'rate')} />
              {editable && (
                <button type="button" aria-label="Remove line" onClick={() => actions.removeInvoiceLine(c.id, inv.id, l.id)} className="dimmer hover:text-white"><Trash2 className="h-4 w-4" /></button>
              )}
            </div>
          ))}
          {editable && (
            <button type="button" onClick={() => actions.addInvoiceLine(c.id, inv.id)} className="self-start inline-flex items-center gap-1.5 rounded-full chip px-3 py-1 text-[12.5px]"><Plus className="h-3.5 w-3.5" />Line</button>
          )}
        </div>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 text-[13px] tnum">
          <dt className="dimmer">Subtotal</dt><dd className="text-right">{money2(t.subtotal)}</dd>
          <dt className="dimmer">GST 10%</dt><dd className="text-right">{money2(t.gst)}</dd>
          <dt className="font-bold">Total</dt><dd className="text-right font-extrabold">{money2(t.total)}</dd>
          {paid > 0 && inv.status !== 'Paid' && (
            <>
              <dt className="dimmer">Paid</dt><dd className="text-right text-emerald-200">{money2(paid)}</dd>
              <dt className="font-bold">Balance</dt><dd className="text-right font-extrabold">{money2(Math.max(0, t.total - paid))}</dd>
            </>
          )}
        </dl>
        {isAdmin && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <InvoiceActions c={c} inv={inv} />
            <PrintButton inv={inv} onPrint={printThis} />
            {!str(org.abn) && (
              <a href="#/settings?tab=business" className="text-[12px] text-amber-200 underline underline-offset-2 hover:text-white">Add your ABN in Settings to issue tax invoices</a>
            )}
          </div>
        )}
      </div>
      <TaxInvoice c={c} inv={inv} org={org} t={t} />
    </div>
  );
}
