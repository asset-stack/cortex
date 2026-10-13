// Checks the shared invoice, contract and Google helpers without a network: node scripts/test-invoice.mjs
// (a) taxInvoiceModel / billingContacts / invoiceEmail (src/lib/taxInvoice.js), (b) the contract Key Details and
// placeholders (src/lib/contract.js), (c) the browser side of the google Edge Function (src/integrations/google.js) against
// a fake invoke(), (d) the invoice PDF (src/lib/invoicePdf.js) and its WinAnsi sanitiser.
// Exits non-zero when any check fails.
import assert from 'node:assert/strict';
import { PDFArray, PDFDocument, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { fullDate, invoiceTotals, money2 } from '../src/lib/format.js';
import { billingContacts, invoiceEmail, isEmail, taxInvoiceModel } from '../src/lib/taxInvoice.js';
import { CONTRACT_DEFAULTS, contractName, contractReplacements, newContractDetails, termEnd } from '../src/lib/contract.js';
import { cleanRecipients, createContractDoc, googleConnectUrl, sendGoogleEmail, sendInvoiceEmail, toBase64 } from '../src/integrations/google.js';
import { invoicePdf, winAnsi } from '../src/lib/invoicePdf.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n  ${String(e?.stack || e).split('\n').slice(0, 12).join('\n  ')}`);
  }
}

// Fixtures. All names, emails and bank details are placeholders.
const ORG = {
  businessName: 'Example Pty Ltd', abn: '12345678901', address: '1 Example St\nSydney NSW 2000', email: 'accounts@example.com',
  phone: '02 0000 0000', bankAccountName: 'Example Pty Ltd', bsb: '062000', accountNumber: '12345678', paymentTermsDays: 14,
  contractTemplate: 'https://docs.google.com/document/d/template-id/edit', contractFolder: 'https://drive.google.com/drive/folders/folder-id',
};
const client = (over = {}) => ({
  id: 'c-1', name: 'Client One', abn: '98765432109', billingAddress: '2 Example Rd\nParramatta NSW 2150',
  contacts: [
    { id: 'pc-1', name: 'Pat Doe', role: 'Asset manager', email: 'pat@example.com', phone: '', billing: false },
    { id: 'pc-2', name: 'Sam Roe', role: 'Finance', email: 'Accounts@Example.com', phone: '', billing: true },
  ],
  plans: [],
  ...over,
});
const invoice = (over = {}) => ({
  id: 'i-1', number: 'EX-1001', issued: '2026-10-01', due: '2026-10-15', status: 'Approved',
  lines: [
    { id: 'l-1', desc: 'Capture', qty: '2', rate: '1,000' },
    { id: 'l-2', desc: 'Travel', qty: 1, rate: 250.5 },
    { id: 'l-3', desc: 'Licence\nNov 2026 – Oct 2027', qty: 1, rate: 0.125 },
  ],
  ...over,
});
const model = (inv = {}, c = {}, org = {}) => taxInvoiceModel({ client: client(c), invoice: invoice(inv), org: { ...ORG, ...org } });

// ── (a) Tax invoice model and email ───────────────────────────────────────────

await check('taxInvoiceModel: totals, line amounts and GST note are money2 of invoiceTotals', () => {
  const inv = invoice();
  const t = invoiceTotals(inv);
  const m = model();
  assert.deepEqual(m.totals, [['Subtotal (ex GST)', money2(t.subtotal)], ['GST 10%', money2(t.gst)], ['Total (inc GST)', money2(t.total)]]);
  assert.deepEqual(m.totals.map(([, v]) => v), ['$2,250.63', '$225.06', '$2,475.69']);
  assert.equal(m.total, money2(t.total));
  assert.equal(m.gstNote, `Total includes GST of ${money2(t.gst)}`);
  assert.deepEqual(m.lines.map((l) => [l.qty, l.unit, l.gst, l.inc]), [
    ['2', '$1,000.00', '$200.00', '$2,200.00'], ['1', '$250.50', '$25.05', '$275.55'], ['1', '$0.125', '$0.01', '$0.14'],
  ]);
  assert.deepEqual(m.lines.map((l) => l.gst), t.lines.map((l) => money2(l.gst)));
  assert.equal(m.lines[2].desc, 'Licence\nNov 2026 – Oct 2027', 'descriptions keep their line breaks');
});

await check('taxInvoiceModel: Tax invoice, Invoice without an ABN, Draft before approval', () => {
  assert.equal(model().title, 'Tax invoice');
  assert.equal(model({}, {}, { abn: '' }).title, 'Invoice');
  assert.equal(model({}, {}, { abn: '  ' }).title, 'Invoice');
  assert.equal(model({ status: 'Draft' }).title, 'Draft tax invoice');
  assert.equal(model({ status: 'Awaiting approval' }).title, 'Draft tax invoice');
  assert.equal(model({ status: 'Draft' }, {}, { abn: '' }).title, 'Draft invoice');
  ['Approved', 'Sent', 'Paid', 'Overdue', 'Void'].forEach((status) => assert.equal(model({ status }).title, 'Tax invoice', status));
});

await check('taxInvoiceModel: supplier and bill-to blocks', () => {
  const m = model();
  assert.deepEqual(m.supplier, {
    name: 'Example Pty Ltd', abn: 'ABN 12 345 678 901', address: '1 Example St\nSydney NSW 2000', contact: 'accounts@example.com · 02 0000 0000',
  });
  assert.deepEqual(m.billTo, { name: 'Client One', abn: 'ABN 98 765 432 109', address: '2 Example Rd\nParramatta NSW 2150', attn: 'Attn: Sam Roe' });
  assert.equal(model({}, {}, { businessName: '', abn: '', phone: '' }).supplier.name, 'AssetStack');
  assert.equal(model({}, {}, { phone: '' }).supplier.contact, 'accounts@example.com');
  assert.equal(model({}, { abn: '' }).billTo.abn, '');
  const two = client().contacts.map((x) => ({ ...x, billing: true }));
  assert.equal(model({}, { contacts: two }).billTo.attn, 'Attn: Pat Doe, Sam Roe');
  assert.equal(model({}, { contacts: [] }).billTo.attn, '');
  assert.equal(model({}, { contacts: [{ id: 'x', name: '', email: 'x@example.com', billing: true }] }).billTo.attn, '', 'no name, no Attn');
});

await check('billingContacts: billing ones with a valid email, else the first with an email', () => {
  const ids = (contacts) => billingContacts({ contacts }).map((x) => x.id);
  const [pat, sam] = client().contacts;
  assert.deepEqual(ids([pat, sam]), ['pc-2']);
  assert.deepEqual(ids([pat, { ...sam, billing: false }]), ['pc-1'], 'no billing contact: the first with an email');
  assert.deepEqual(ids([{ ...pat, email: '' }, { ...sam, billing: false }]), ['pc-2'], 'skips one without an email');
  assert.deepEqual(ids([pat, { ...sam, email: 'not-an-email' }]), ['pc-1'], 'a billing contact with an invalid email is ignored');
  assert.deepEqual(ids([{ ...pat, email: 'pat@example' }, { ...sam, email: 'a b@example.com', billing: false }]), []);
  assert.deepEqual(billingContacts({}), []);
  assert.deepEqual(billingContacts(null), []);
  assert.ok(isEmail(' pat@example.com ') && !isEmail('pat@@example.com') && !isEmail('pat@example.com, sam@example.com') && !isEmail(null));
});

await check('taxInvoiceModel: Status shows only for Paid, Overdue and Void', () => {
  const keys = (status) => model({ status }).meta.map(([k]) => k);
  ['Draft', 'Awaiting approval', 'Approved', 'Sent'].forEach((s) => assert.deepEqual(keys(s), ['Invoice number', 'Issue date', 'Due date'], s));
  ['Paid', 'Overdue', 'Void'].forEach((s) => assert.deepEqual(model({ status: s }).meta.at(-1), ['Status', s], s));
  assert.deepEqual(model().meta, [['Invoice number', 'EX-1001'], ['Issue date', '1 Oct 2026'], ['Due date', '15 Oct 2026']]);
  assert.equal(model({ due: '' }).meta[2][1], '—');
});

await check('taxInvoiceModel: terms from the invoice dates, else Settings, else 30 days', () => {
  const terms = (inv, org) => model(inv, {}, org).payment.at(-1);
  assert.deepEqual(terms(), ['Terms', 'Due in 14 days']);
  assert.deepEqual(terms({ due: '2026-10-02' }), ['Terms', 'Due in 1 day']);
  assert.deepEqual(terms({ due: '2026-10-01' }), ['Terms', 'Due on receipt']);
  assert.deepEqual(terms({ issued: '2026-10-01', due: '2026-10-31' }, { paymentTermsDays: 7 }), ['Terms', 'Due in 30 days'], 'the dates win over Settings');
  assert.deepEqual(terms({ due: '' }, { paymentTermsDays: 7 }), ['Terms', 'Due in 7 days']);
  assert.deepEqual(terms({ due: '' }, { paymentTermsDays: '0' }), ['Terms', 'Due on receipt']);
  assert.deepEqual(terms({ due: '' }, { paymentTermsDays: '' }), ['Terms', 'Due in 30 days']);
});

await check('taxInvoiceModel: payment rows skip blank bank details; filename is sanitised', () => {
  assert.deepEqual(model().payment, [
    ['Account name', 'Example Pty Ltd'], ['BSB', '062-000'], ['Account number', '12345678'], ['Reference', 'EX-1001'], ['Terms', 'Due in 14 days'],
  ]);
  assert.deepEqual(model({}, {}, { bankAccountName: '', bsb: '', accountNumber: '' }).payment.map(([k]) => k), ['Reference', 'Terms']);
  assert.equal(model().filename, 'EX-1001 Client One.pdf');
  assert.equal(model({ number: 'EX/1001' }, { name: 'Acme: Water & "Waste" <Ops>' }).filename, 'EX 1001 Acme Water Waste Ops.pdf');
  assert.equal(model({ number: '../../etc' }, { name: '' }).filename, '.. .. etc.pdf', 'no path separators');
  assert.equal(model({ number: '' }, { name: '' }).filename, 'invoice.pdf');
  assert.equal(model({ number: ' EX-1 ' }, { name: 'A   B\tC' }).filename, 'EX-1 A B C.pdf', 'other characters become one space');
  assert.equal(model({}, { name: 'Māori Trust · Tāmaki' }).filename, 'EX-1001 Maori Trust Tamaki.pdf', 'accents dropped, letters kept');
});

await check('taxInvoiceModel: no client, invoice or lines still gives a model', () => {
  assert.deepEqual(taxInvoiceModel({ client: null, invoice: { number: 'EX-9', status: 'Draft' }, org: {} }).lines, [], 'an invoice without lines');
  const m = taxInvoiceModel({ client: null, invoice: null, org: {} });
  assert.equal(m.title, 'Invoice');
  assert.deepEqual(m.lines, []);
  assert.equal(m.total, '$0.00');
  assert.equal(m.filename, 'invoice.pdf');
});

await check('invoiceEmail: to the billing emails in lower case, subject, greeting and sign-off', () => {
  const e = invoiceEmail({ client: client(), invoice: invoice(), org: ORG, sender: { name: 'Ana Admin' } });
  assert.deepEqual(e.to, ['accounts@example.com']);
  assert.equal(e.subject, 'Tax invoice EX-1001 from Example Pty Ltd');
  const lines = e.text.split('\n');
  assert.equal(lines[0], 'Hi Sam,');
  assert.ok(e.text.includes('tax invoice EX-1001 for $2,475.69, due 15 Oct 2026.'), e.text);
  assert.deepEqual(lines.slice(-3), ['Thank you,', 'Ana Admin', 'Example Pty Ltd']);
  const both = client({ contacts: client().contacts.map((x) => ({ ...x, billing: true })) });
  assert.deepEqual(invoiceEmail({ client: both, invoice: invoice(), org: ORG }).to, ['pat@example.com', 'accounts@example.com']);
  const anon = invoiceEmail({ client: client({ contacts: [] }), invoice: invoice({ status: 'Draft' }), org: { ...ORG, abn: '' } });
  assert.deepEqual(anon.to, []);
  assert.equal(anon.subject, 'Draft invoice EX-1001 from Example Pty Ltd');
  assert.equal(anon.text.split('\n')[0], 'Hi there,');
  assert.deepEqual(anon.text.split('\n').slice(-2), ['Thank you,', 'Example Pty Ltd'], 'no sender: signed by the business only');
});

// ── (b) Contracts ─────────────────────────────────────────────────────────────

await check('termEnd: the day before the same date a term later, across leap years and month ends', () => {
  assert.equal(termEnd('2026-11-01'), '2027-10-31');
  assert.equal(termEnd('2026-01-15'), '2027-01-14');
  assert.equal(termEnd('2027-03-01'), '2028-02-29', 'ends on 29 Feb in a leap year');
  assert.equal(termEnd('2026-03-01'), '2027-02-28');
  assert.equal(termEnd('2028-02-01', 1), '2028-02-29');
  assert.equal(termEnd('2027-02-01', 1), '2027-02-28');
  assert.equal(termEnd('2026-12-01', 1), '2026-12-31', 'across the year end');
  assert.equal(termEnd('2026-11-01', 24), '2028-10-31');
  assert.equal(termEnd('2024-02-29', 1), '2024-03-28');
  assert.equal(termEnd('2026-01-31', 1), '2026-02-28', 'no 31 Feb: the last day of February');
  assert.equal(termEnd('2024-02-29'), '2025-02-28', 'no 29 Feb next year: 28 Feb');
  assert.equal(termEnd('2026-03-31', 1), '2026-04-30');
  assert.equal(termEnd('2026-08-31', 6), '2027-02-28');
  ['', null, undefined, '2026-11', '1 Nov 2026'].forEach((v) => assert.equal(termEnd(v), '', String(v)));
});

await check('newContractDetails: annual fee from active plans, starting on the 1st of next month for a year', () => {
  const plans = [
    { amount: 2400, frequency: 'monthly', active: true },
    { amount: 1000, frequency: 'quarterly' }, // active unless switched off
    { amount: 500.5, frequency: 'annually', active: true },
    { amount: 999, frequency: 'monthly', active: false },
    { amount: 10, frequency: 'weekly', active: true }, // not a plan frequency: ignored
  ];
  const d = newContractDetails(client({ plans }), '2026-10-13');
  assert.deepEqual(d, { ...CONTRACT_DEFAULTS, startDate: '2026-11-01', endDate: '2027-10-31', annualFee: 33300.5 });
  const dec = newContractDetails(client(), '2026-12-31');
  assert.deepEqual([dec.startDate, dec.endDate, dec.annualFee], ['2027-01-01', '2027-12-31', 0]);
  assert.equal(newContractDetails(client({ plans: [{ amount: 33.33, frequency: 'monthly' }] }), '2026-10-01').annualFee, 399.96);
  assert.equal(newContractDetails(null, '2027-01-31').startDate, '2027-02-01');
});

await check('contractName: client, title and start date', () => {
  assert.equal(contractName(client(), { title: 'Software Subscription Agreement', startDate: '2026-11-01' }),
    'Client One - Software Subscription Agreement - 1 Nov 2026');
  assert.equal(contractName(client(), { startDate: '2026-11-01' }), 'Client One - Software Subscription Agreement - 1 Nov 2026', 'default title');
  assert.equal(contractName(client(), { title: 'Renewal' }), 'Client One - Renewal');
  assert.equal(contractName({}, {}), 'Software Subscription Agreement');
});

await check('contractReplacements: every placeholder, formatted', () => {
  const contract = {
    platform: 'AssetStack - Property Management', startDate: '2026-11-01', endDate: '2027-10-31', annualFee: 4500,
    paymentTerms: 'Invoiced annually in advance', userLimit: '1 master user', customisations: 'Ten per 12-month period',
    mobileApp: 'Included', governingLaw: 'New South Wales',
  };
  const r = contractReplacements({ client: client(), contract, today: '2026-10-13' });
  assert.deepEqual(r, {
    Customer: 'Client One', 'Customer ABN': '98 765 432 109', 'Customer address': '2 Example Rd\nParramatta NSW 2150',
    'Contact name': 'Sam Roe', 'Contact email': 'Accounts@Example.com', Platform: 'AssetStack - Property Management',
    'Start date': '1 Nov 2026', 'End date': '31 Oct 2027', 'Annual fee': '$4,500', 'Payment terms': 'Invoiced annually in advance',
    'User limit': '1 master user', Customisations: 'Ten per 12-month period', 'Mobile app': 'Included', 'Governing law': 'New South Wales',
    Date: '13 Oct 2026',
  });
  const fee = (annualFee) => contractReplacements({ client: client(), contract: { annualFee }, today: '2026-10-13' })['Annual fee'];
  assert.equal(fee(4500.5), '$4,500.50');
  assert.equal(fee(1234567), '$1,234,567');
  assert.equal(fee(0), '');
  assert.equal(fee('abc'), '');
  const blank = contractReplacements({ client: {}, contract: null, today: '2026-10-13' });
  assert.deepEqual(Object.keys(blank), Object.keys(r));
  assert.ok(Object.entries(blank).every(([k, v]) => (k === 'Date' ? v === '13 Oct 2026' : v === '')), JSON.stringify(blank));
  const both = client({ contacts: client().contacts.map((x) => ({ ...x, billing: true })) });
  const people = contractReplacements({ client: both, contract, today: '2026-10-13' });
  assert.deepEqual([people['Contact name'], people['Contact email']], ['Pat Doe, Sam Roe', 'pat@example.com, Accounts@Example.com']);
});

// ── (c) Google helpers against a fake invoke() ────────────────────────────────

// Records each call; replies with `reply` (or reply(path, body)).
function fakeInvoke(reply = { ok: true }) {
  const fn = async (path, body) => {
    fn.calls.push({ path, body });
    return typeof reply === 'function' ? reply(path, body) : reply;
  };
  fn.calls = [];
  return fn;
}

await check('cleanRecipients: trims, lower-cases, dedupes, drops invalid, caps at 10', () => {
  assert.deepEqual(cleanRecipients(['A@Example.com', ' a@example.com ', 'b@example.com', 'not-an-email', '', null, 'c@example']),
    ['a@example.com', 'b@example.com']);
  assert.deepEqual(cleanRecipients('a@example.com; B@example.com, c@example.com d@example.com\ne@example.com'),
    ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com']);
  const many = Array.from({ length: 15 }, (_, i) => `p${i}@example.com`);
  assert.deepEqual(cleanRecipients(many), many.slice(0, 10));
  assert.deepEqual(cleanRecipients(['x@example.com', ...many]).length, 10, 'duplicates removed before the cap');
  assert.deepEqual(cleanRecipients(undefined), []);
  assert.deepEqual(cleanRecipients(''), []);
});

await check('toBase64: round-trips a large Uint8Array', () => {
  const bytes = new Uint8Array(300_000);
  let x = 7;
  for (let i = 0; i < bytes.length; i++) bytes[i] = (x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16;
  const b64 = toBase64(bytes);
  assert.equal(b64, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(new Uint8Array(Buffer.from(b64, 'base64')), bytes);
  assert.equal(toBase64(new Uint8Array(0)), '');
  assert.equal(toBase64(new Uint8Array([0, 255, 128])), 'AP+A');
});

await check('googleConnectUrl and sendGoogleEmail pass through invoke()', async () => {
  const connect = fakeInvoke({ ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
  assert.deepEqual(await googleConnectUrl(connect, 'https://cortex.example.com'), { ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
  assert.deepEqual(connect.calls, [{ path: 'google/connect', body: { origin: 'https://cortex.example.com' } }]);
  assert.deepEqual(await googleConnectUrl(fakeInvoke({ ok: false, error: 'Not an admin.' }), ''), { ok: false, error: 'Not an admin.' });
  assert.equal((await googleConnectUrl(fakeInvoke({ ok: true }), '')).ok, false, 'no url is a failure');
  const send = fakeInvoke();
  assert.equal((await sendGoogleEmail(send, { to: 'bad', subject: 'x', text: 'y' })).ok, false);
  assert.equal(send.calls.length, 0);
  assert.deepEqual(await sendGoogleEmail(send, { to: ['Me@Example.com'], subject: ' Test ', text: 'Hello' }), { ok: true });
  assert.deepEqual(send.calls, [{ path: 'google/send', body: { to: ['me@example.com'], subject: 'Test', text: 'Hello' } }]);
});

await check('sendInvoiceEmail: refuses without an ABN or a recipient', async () => {
  const invoke = fakeInvoke();
  const noAbn = await sendInvoiceEmail(invoke, { client: client(), invoice: invoice(), org: { ...ORG, abn: '' }, to: ['pat@example.com'], subject: 's', text: 't' });
  assert.equal(noAbn.ok, false);
  assert.match(noAbn.error, /ABN/);
  const noOrg = await sendInvoiceEmail(invoke, { client: client(), invoice: invoice(), to: ['pat@example.com'] });
  assert.equal(noOrg.ok, false);
  for (const to of [[], ['not-an-email'], '', undefined]) {
    const res = await sendInvoiceEmail(invoke, { client: client(), invoice: invoice(), org: ORG, to, subject: 's', text: 't' });
    assert.equal(res.ok, false, JSON.stringify(to));
    assert.ok(res.error);
  }
  assert.equal(invoke.calls.length, 0, 'nothing is sent');
});

await check('sendInvoiceEmail: sends the PDF through google/send with the model\'s filename', async () => {
  const invoke = fakeInvoke({ ok: true, id: 'msg-1' });
  const res = await sendInvoiceEmail(invoke, {
    client: client(), invoice: invoice(), org: ORG, to: [' Accounts@Example.com ', 'pat@example.com', 'accounts@example.com'],
    subject: ' Tax invoice EX-1001 from Example Pty Ltd ', text: 'Hi Sam,\n\nAttached.',
  });
  assert.deepEqual(res, { ok: true, id: 'msg-1' });
  assert.equal(invoke.calls.length, 1);
  const { path, body } = invoke.calls[0];
  assert.equal(path, 'google/send');
  assert.deepEqual(body.to, ['accounts@example.com', 'pat@example.com']);
  assert.equal(body.subject, 'Tax invoice EX-1001 from Example Pty Ltd');
  assert.equal(body.text, 'Hi Sam,\n\nAttached.');
  assert.deepEqual(Object.keys(body.attachment).sort(), ['content', 'filename', 'type']);
  assert.equal(body.attachment.type, 'application/pdf');
  assert.equal(body.attachment.filename, model().filename);
  const pdf = Buffer.from(body.attachment.content, 'base64');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal((await PDFDocument.load(pdf, { updateMetadata: false })).getTitle(), 'Tax invoice EX-1001');
  const failed = await sendInvoiceEmail(fakeInvoke({ ok: false, error: 'Reconnect Google.' }), { client: client(), invoice: invoice(), org: ORG, to: 'pat@example.com' });
  assert.deepEqual(failed, { ok: false, error: 'Reconnect Google.' }, 'the function\'s error comes back as is');
});

await check('createContractDoc: refuses without template or folder; sends the name and replacements', async () => {
  const contract = { title: 'Software Subscription Agreement', startDate: '2026-11-01', endDate: '2027-10-31', annualFee: 4500, platform: 'P' };
  const invoke = fakeInvoke({ ok: true, id: 'doc-9', url: 'https://docs.google.com/document/d/doc-9/edit', name: 'n', extra: 1 });
  for (const org of [{ ...ORG, contractTemplate: '' }, { ...ORG, contractFolder: ' ' }, {}, undefined]) {
    const res = await createContractDoc(invoke, { client: client(), org, contract });
    assert.equal(res.ok, false);
    assert.match(res.error, /Settings/);
  }
  assert.equal(invoke.calls.length, 0);
  const res = await createContractDoc(invoke, { client: client(), org: ORG, contract });
  assert.deepEqual(res, { ok: true, id: 'doc-9', url: 'https://docs.google.com/document/d/doc-9/edit', name: 'n' });
  assert.equal(invoke.calls[0].path, 'google/contract');
  const { body } = invoke.calls[0];
  assert.deepEqual(Object.keys(body).sort(), ['folder', 'name', 'replacements', 'template']);
  assert.equal(body.template, ORG.contractTemplate);
  assert.equal(body.folder, ORG.contractFolder);
  assert.equal(body.name, 'Client One - Software Subscription Agreement - 1 Nov 2026');
  assert.deepEqual(body.replacements, contractReplacements({ client: client(), contract }));
  assert.equal(body.replacements['Annual fee'], '$4,500');
  const failed = await createContractDoc(fakeInvoke({ ok: false, error: 'No access to the template.' }), { client: client(), org: ORG, contract });
  assert.deepEqual(failed, { ok: false, error: 'No access to the template.' });
});

// ── (d) The invoice PDF ───────────────────────────────────────────────────────

// The text drawn on each page, one entry per drawText (pdf-lib writes WinAnsi hex strings: <..> Tj).
const CP1252_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const fromWinAnsi = (hex) => [...Buffer.from(hex, 'hex')].map((b) => (b >= 0x80 && b < 0xa0 ? CP1252_80[b - 0x80] : String.fromCharCode(b))).join('');
async function pageTexts(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
    const ops = streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join('\n');
    return [...ops.matchAll(/<([0-9A-Fa-f]*)> Tj/g)].map((x) => fromWinAnsi(x[1]));
  });
}
const lines = (n, desc = (i) => `Item ${i + 1}`) => Array.from({ length: n }, (_, i) => ({ id: `l-${i}`, desc: desc(i), qty: 1, rate: 100 + i }));

await check('invoicePdf: a PDF pdf-lib can read, with title, author and producer', async () => {
  const bytes = await invoicePdf({ client: client(), invoice: invoice(), org: ORG });
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(doc.getPageCount(), 1);
  const { width, height } = doc.getPage(0).getSize();
  assert.deepEqual([Math.round(width), Math.round(height)], [595, 842], 'A4 portrait');
  assert.equal(doc.getTitle(), 'Tax invoice EX-1001');
  assert.equal(doc.getAuthor(), 'Example Pty Ltd');
  assert.equal(doc.getProducer(), 'Cortex');
  assert.equal(doc.getCreator(), 'Cortex');
});

await check('invoicePdf: shows everything in the model', async () => {
  const m = model();
  const [page] = await pageTexts(await invoicePdf({ client: client(), invoice: invoice(), org: ORG }));
  const drawn = new Set(page);
  const expected = [
    m.title, m.supplier.name, m.supplier.abn, ...m.supplier.address.split('\n'), m.supplier.contact,
    'BILL TO', m.billTo.name, m.billTo.abn, ...m.billTo.address.split('\n'), m.billTo.attn,
    ...m.meta.flat(), 'Description', 'Qty', 'Unit price', '(ex GST)', 'GST', 'Amount', '(inc GST)',
    ...m.lines.flatMap((l) => [...l.desc.split('\n'), l.qty, l.unit, l.gst, l.inc]),
    ...m.totals.flat(), m.gstNote, 'PAYMENT', ...m.payment.flat(),
  ];
  expected.forEach((t) => assert.ok(drawn.has(t), `missing ${JSON.stringify(t)}`));
  assert.ok(drawn.has('Nov 2026 – Oct 2027'), 'en dash kept');
  assert.ok(!page.some((t) => /^Page \d/.test(t)), 'no page numbers on a one-page invoice');
});

await check('invoicePdf: 60 lines run onto more pages with the header repeated; totals and payment stay together', async () => {
  const inv = invoice({ status: 'Overdue', lines: lines(60) });
  const pages = await pageTexts(await invoicePdf({ client: client(), invoice: inv, org: ORG }));
  assert.ok(pages.length > 1, `${pages.length} page(s)`);
  pages.forEach((p, i) => {
    ['Description', 'Unit price', '(inc GST)'].forEach((h) => assert.ok(p.includes(h), `page ${i + 1} repeats ${h}`));
    assert.ok(p.includes(`Page ${i + 1} of ${pages.length}`), `page ${i + 1} is numbered`);
    assert.ok(p.includes('Tax invoice EX-1001'), `page ${i + 1} footer`);
  });
  const items = pages.flat().filter((t) => /^Item \d+$/.test(t));
  assert.deepEqual(items, inv.lines.map((l) => l.desc), 'every line once, in order');
  const last = pages.at(-1);
  ['Total (inc GST)', model(inv).total, model(inv).gstNote, 'PAYMENT', 'Account number', 'Terms'].forEach((t) => assert.ok(last.includes(t), t));
  pages.slice(0, -1).forEach((p) => assert.ok(!p.includes('Total (inc GST)') && !p.includes('PAYMENT'), 'totals only on the last page'));
  assert.ok(pages[0].includes('BILL TO') && !pages[1].includes('BILL TO'), 'the header block is on the first page only');
});

await check('invoicePdf: the totals never start a page without a line above them', async () => {
  for (let n = 1; n <= 70; n++) {
    const pages = await pageTexts(await invoicePdf({ client: client(), invoice: invoice({ lines: lines(n) }), org: ORG }));
    const last = pages.at(-1);
    assert.ok(last.includes('Total (inc GST)') && last.includes('PAYMENT'), `${n} lines: totals and payment on the last page`);
    if (pages.length > 1) assert.ok(last.some((t) => /^Item \d+$/.test(t)), `${n} lines: last page has a line`);
    assert.equal(pages.flat().filter((t) => /^Item \d+$/.test(t)).length, n, `${n} lines all drawn`);
  }
});

await check('invoicePdf: a description taller than a page is split across pages, line breaks kept', async () => {
  const long = Array.from({ length: 150 }, (_, i) => `Row ${i + 1}`).join('\n');
  const inv = invoice({ lines: [{ id: 'a', desc: 'First', qty: 1, rate: 1 }, { id: 'b', desc: long, qty: 2, rate: 3 }, { id: 'c', desc: 'Last', qty: 1, rate: 1 }] });
  const pages = await pageTexts(await invoicePdf({ client: client(), invoice: inv, org: ORG }));
  assert.ok(pages.length >= 3, `${pages.length} pages`);
  const rows = pages.flat().filter((t) => /^Row \d+$/.test(t));
  assert.deepEqual(rows, long.split('\n'));
  assert.equal(pages.flat().filter((t) => t === '$6.60').length, 1, 'the amounts are drawn once, on the first part');
  const words = (await pageTexts(await invoicePdf({
    client: client(), invoice: invoice({ lines: [{ id: 'x', desc: `${'x'.repeat(400)} end`, qty: 1, rate: 1 }] }), org: ORG,
  })))[0];
  const pieces = words.filter((t) => t.startsWith('x'));
  assert.ok(pieces.length > 1, 'broken onto more lines');
  assert.equal(pieces.join(''), `${'x'.repeat(400)} end`, 'a word longer than the column is broken, not clipped');
});

await check('invoicePdf: text outside WinAnsi and odd input never throw', async () => {
  const odd = 'Ngā mihi → Ōtaki ← 東京 😀👍🏽 👨\u200d👩\u200d👧 \u22125 a\u202fb ✓ \u0000\u0007 \ud800 \u2028x';
  const bytes = await invoicePdf({
    client: { name: `Te Rūnanga ${odd}`, abn: '١٢٣', billingAddress: odd, contacts: [{ name: 'Mere Tūhoe 😀', email: 'mere@example.com', billing: true }] },
    invoice: { number: 'INV\u2011٤٢ 😀', issued: '2026-10-01', due: '2026-10-15', status: 'Paid', lines: [
      { id: 'a', desc: odd, qty: '½', rate: '1,000' }, { id: 'b', desc: '', qty: '', rate: '' }, { id: 'c', desc: null, qty: 'x', rate: 'abc' },
    ] },
    org: { ...ORG, businessName: `Kāinga ${odd}`, address: odd, bankAccountName: odd },
  });
  const pages = await pageTexts(bytes);
  ['Kainga Nga mihi -> Otaki <- ?? ?? ??? -5 a b ? ?? ?', 'Attn: Mere Tuhoe ?', 'INV-?? ?', 'ABN ???', 'Te Runanga Nga mihi -> Otaki <- ?? ?? ??? -5 a b ? ?? ?']
    .forEach((t) => assert.ok(pages[0].includes(t), `${t} in ${pages[0].join(' | ')}`));
  for (const args of [{}, undefined, { client: null, invoice: null, org: null }, { invoice: { lines: [] } }, { client: {}, invoice: invoice(), org: {} }]) {
    const out = await invoicePdf(args);
    assert.equal(Buffer.from(out.subarray(0, 5)).toString('latin1'), '%PDF-', JSON.stringify(args));
  }
});

await check('winAnsi: keeps WinAnsi, decomposes accents, maps look-alikes, ? for the rest', () => {
  assert.equal(winAnsi('Māori Ōtaki Whānau'), 'Maori Otaki Whanau');
  assert.equal(winAnsi('café ñ ß ü ½ © ° · ×'), 'café ñ ß ü ½ © ° · ×', 'Latin-1 kept');
  assert.equal(winAnsi('€ “q” ‘s’ ‚ „ – — • … ™ † ‡ ‰ ‹ › Œ œ Š š Ž ž Ÿ ƒ ˆ ˜'), '€ “q” ‘s’ ‚ „ – — • … ™ † ‡ ‰ ‹ › Œ œ Š š Ž ž Ÿ ƒ ˆ ˜', 'CP1252 extras kept');
  assert.equal(winAnsi('a → b ← c ↔ d ⇒ e ⇐ f'), 'a -> b <- c <-> d => e <= f');
  assert.equal(winAnsi('\u22125 \u2010 \u2011 \u2012 ≤ ≥ ≠'), '-5 - - - <= >= !=');
  assert.equal(winAnsi('a\u202fb\u2009c\u2002d\u3000e\tf\ng'), 'a b c d e f g', 'odd spaces and breaks become spaces');
  assert.equal(winAnsi('a\u00a0b'), 'a\u00a0b', 'a no-break space is Latin-1');
  assert.equal(winAnsi('e\u0301 a\u0304'), 'é a', 'combining accents: composed when Latin-1 has it, else dropped');
  assert.equal(winAnsi('ﬁ ① Ａｂ ℃ №'), 'fi 1 Ab °C No', 'compatibility forms');
  assert.equal(winAnsi('łódź Đ ı'), 'lódz D i');
  assert.equal(winAnsi('a\u200bb\u00adc\ufeffd\u200ee'), 'abcde', 'invisible characters dropped');
  assert.equal(winAnsi('東京 😀 👍🏽 ✓'), '?? ? ? ?');
  assert.equal(winAnsi('👨\u200d👩\u200d👧'), '???', 'joiners dropped');
  assert.equal(winAnsi('\ud800x\udc00'), '?x?', 'lone surrogates');
  assert.equal(winAnsi('\u0000\u0007'), '??');
  assert.equal(winAnsi(null), '');
  assert.equal(winAnsi(undefined), '');
  assert.equal(winAnsi(0), '0');
  assert.equal(winAnsi(12.5), '12.5');
  assert.equal(winAnsi({ toString() { throw new Error('no'); } }), '');
  assert.equal(typeof winAnsi(Symbol('s')), 'string');
  assert.equal(winAnsi(winAnsi('Ngā → 東京 “x”')), winAnsi('Ngā → 東京 “x”'), 'idempotent');
});

await check('winAnsi: every character it returns is drawable in Helvetica', async () => {
  const doc = await PDFDocument.create();
  const fonts = [await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold)];
  const sample = [];
  for (let cp = 0; cp < 0x10000; cp++) sample.push(cp);
  for (let cp = 0x10000; cp <= 0x10ffff; cp += 0x3f) sample.push(cp);
  let bad = [];
  for (const cp of sample) {
    const out = winAnsi(String.fromCodePoint(cp));
    try {
      fonts.forEach((f) => f.encodeText(out));
    } catch {
      bad.push(cp.toString(16));
      if (bad.length > 20) break;
    }
  }
  assert.deepEqual(bad, []);
  bad = [];
  ['Ngā mihi → 東京 😀', 'x\u0301\u0302\u0303', '\u{E0067}\u{E0062}', '🏴󠁧󠁢󠁳󠁣󠁴󠁿'].forEach((s) => {
    try { fonts[0].encodeText(winAnsi(s)); } catch { bad.push(s); }
  });
  assert.deepEqual(bad, []);
});

// Pages that draw the table's column headings with no row under them.
const emptyTables = (pages, isRow) => pages.map((p, i) => (p.includes('Description') && !p.some(isRow) ? i + 1 : 0)).filter(Boolean);

await check('invoicePdf: a first line taller than the room left on page 1 starts there, not under an empty table', async () => {
  const isRow = (t) => /^Scope item \d+$/.test(t);
  for (let n = 30; n <= 60; n++) {
    const desc = Array.from({ length: n }, (_, i) => `Scope item ${i + 1}`).join('\n');
    const pages = await pageTexts(await invoicePdf({ client: client(), invoice: invoice({ lines: [{ id: 'a', desc, qty: 1, rate: 5000 }] }), org: ORG }));
    assert.deepEqual(emptyTables(pages, isRow), [], `${n} description lines: pages with headings and no row`);
    assert.deepEqual(pages.flat().filter(isRow), desc.split('\n'), `${n} description lines: each drawn once, in order`);
    assert.equal(pages.flat().filter((t) => t === '$5,500.00').length, 2, `${n} description lines: the amount once (and the total)`);
    assert.ok(pages.at(-1).includes('Total (inc GST)') && pages.at(-1).includes('PAYMENT'), `${n} description lines: totals on the last page`);
    assert.ok(pages.length <= 2, `${n} description lines: ${pages.length} pages`);
  }
});

await check('invoicePdf: a long bill-to block never leaves page 1 with an empty table', async () => {
  const isRow = (t) => ['One', 'Two', 'Three', 'Four'].includes(t);
  for (let k = 28; k <= 42; k++) {
    for (const name of ['Client One', 'Client One\nTrading as Example']) {
      const billingAddress = Array.from({ length: k }, (_, i) => `Address line ${i + 1}`).join('\n');
      const inv = invoice({ lines: [{ id: 'a', desc: 'One\nTwo\nThree', qty: 1, rate: 5 }, { id: 'b', desc: 'Four', qty: 1, rate: 5 }] });
      const pages = await pageTexts(await invoicePdf({ client: client({ name, billingAddress }), invoice: inv, org: ORG }));
      const label = `${k} address lines, ${name.split('\n').length} name line(s)`;
      assert.deepEqual(emptyTables(pages, isRow), [], `${label}: pages with headings and no row`);
      assert.deepEqual(pages.flat().filter(isRow), ['One', 'Two', 'Three', 'Four'], `${label}: every line once, in order`);
      assert.ok(pages.at(-1).includes('Total (inc GST)') && pages.at(-1).includes('PAYMENT'), `${label}: totals on the last page`);
    }
  }
});

// A tab opened before a deploy can't load the PDF chunk (Pages has a new name for it): that says "reload", and only a
// real pdf-lib failure says "Could not make the PDF".
await check('makeInvoicePdf / sendInvoiceEmail: a chunk that will not load asks for a reload; nothing is sent', async () => {
  const { makeInvoicePdf, RELOAD_ERROR } = await import('../src/integrations/google.js');
  const stale = async () => { throw new TypeError('Failed to fetch dynamically imported module: /assets/invoicePdf-OLD.js'); };
  assert.deepEqual(await makeInvoicePdf({ client: client(), invoice: invoice(), org: ORG }, stale), { ok: false, error: RELOAD_ERROR });
  assert.match(RELOAD_ERROR, /reload/i);
  const invoke = fakeInvoke({ ok: true, id: 'msg-1' });
  const res = await sendInvoiceEmail(invoke, { client: client(), invoice: invoice(), org: ORG, to: 'pat@example.com', subject: 's', text: 't' }, stale);
  assert.deepEqual(res, { ok: false, error: RELOAD_ERROR });
  assert.equal(invoke.calls.length, 0, 'nothing is sent');
  const broken = async () => ({ invoicePdf: async () => { throw new Error('pdf-lib failed'); } });
  assert.deepEqual(await makeInvoicePdf({ client: client(), invoice: invoice(), org: ORG }, broken), { ok: false, error: 'Could not make the PDF.' });
  const ok = await makeInvoicePdf({ client: client(), invoice: invoice(), org: ORG });
  assert.equal(ok.ok, true);
  assert.equal(Buffer.from(ok.bytes).subarray(0, 5).toString('latin1'), '%PDF-');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
