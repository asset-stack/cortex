// One invoice as an Australian tax invoice: the printed copy (TaxInvoice in src/pages/clients/invoice.jsx), the PDF
// that is emailed (src/lib/invoicePdf.js) and the email around it all come from this model, so they never disagree.
// Pure (relative imports only), so the Node tests load it directly.
import { daysBetween, formatAbn, formatBsb, fullDate, invoiceTotals, money2, parseAmount, unitMoney } from './format.js';

const str = (v) => String(v ?? '').trim();
const UNISSUED = ['Draft', 'Awaiting approval'];
// Must be a plausible single address (no spaces, one @, a dot after it).
export const isEmail = (v) => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(str(v));

/** The client's people who get invoices: those marked billing (with an email), else the first with an email. */
export function billingContacts(client) {
  const people = (client?.contacts || []).filter((x) => isEmail(x.email));
  const billing = people.filter((x) => x.billing);
  return billing.length ? billing : people.slice(0, 1);
}

/** Everything the tax invoice shows, as display strings. */
export function taxInvoiceModel({ client, invoice, org = {} }) {
  const c = client || {};
  const inv = { lines: [], ...invoice };
  const t = invoiceTotals(inv);
  const abn = str(org.abn);
  const kind = abn ? 'Tax invoice' : 'Invoice'; // without the supplier's ABN it isn't a valid tax invoice
  // Terms come from the invoice's own dates, so the copy can't contradict itself if Settings change later.
  const orgDays = parseInt(org.paymentTermsDays, 10);
  const days = daysBetween(inv.issued, inv.due) ?? (orgDays >= 0 ? orgDays : 30);
  const attn = billingContacts(c).map((x) => str(x.name)).filter(Boolean).join(', ');
  const number = str(inv.number);
  return {
    title: UNISSUED.includes(inv.status) ? `Draft ${kind.toLowerCase()}` : kind,
    supplier: {
      name: str(org.businessName) || 'AssetStack',
      abn: abn ? `ABN ${formatAbn(abn)}` : '',
      address: str(org.address),
      contact: [str(org.email), str(org.phone)].filter(Boolean).join(' · '),
    },
    billTo: {
      name: str(c.name),
      abn: str(c.abn) ? `ABN ${formatAbn(c.abn)}` : '',
      address: str(c.billingAddress),
      attn: attn ? `Attn: ${attn}` : '',
    },
    meta: [
      ['Invoice number', number],
      ['Issue date', fullDate(inv.issued)],
      ['Due date', fullDate(inv.due)],
      ...(['Paid', 'Overdue', 'Void'].includes(inv.status) ? [['Status', inv.status]] : []),
    ],
    lines: (inv.lines || []).map((l, i) => ({
      desc: String(l.desc ?? ''), qty: str(l.qty), unit: unitMoney(parseAmount(l.rate) || 0), gst: money2(t.lines[i].gst), inc: money2(t.lines[i].inc),
    })),
    totals: [['Subtotal (ex GST)', money2(t.subtotal)], ['GST 10%', money2(t.gst)], ['Total (inc GST)', money2(t.total)]],
    gstNote: `Total includes GST of ${money2(t.gst)}`,
    payment: [
      ...[['Account name', str(org.bankAccountName)], ['BSB', formatBsb(org.bsb)], ['Account number', str(org.accountNumber)]].filter(([, v]) => v),
      ['Reference', number],
      ['Terms', days === 0 ? 'Due on receipt' : `Due in ${days} ${days === 1 ? 'day' : 'days'}`],
    ],
    total: money2(t.total),
    // "INV-1002 Māori Trust.pdf" → "INV-1002 Maori Trust.pdf": accents dropped, other symbols become spaces.
    filename: `${`${number} ${str(c.name)}`.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.\- ]+/g, ' ')
      .replace(/\s+/g, ' ').trim() || 'invoice'}.pdf`,
  };
}

/** The email an invoice goes out with: to the billing contacts, from `sender` (the approving admin). Editable before sending. */
export function invoiceEmail({ client, invoice, org = {}, sender = {} }) {
  const m = taxInvoiceModel({ client, invoice, org });
  const people = billingContacts(client);
  const first = str(people[0]?.name).split(/\s+/)[0];
  const business = m.supplier.name;
  const lines = [
    `Hi ${first || 'there'},`,
    '',
    `Please find attached ${m.title.toLowerCase()} ${str(invoice?.number)} for ${m.total}, due ${fullDate(invoice?.due)}.`,
    'Payment details are on the invoice.',
    '',
    'Thank you,',
    str(sender.name) || business,
    ...(str(sender.name) ? [business] : []),
  ];
  return {
    to: people.map((x) => str(x.email).toLowerCase()),
    subject: `${m.title} ${str(invoice?.number)} from ${business}`,
    text: lines.join('\n'),
  };
}
