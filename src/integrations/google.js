// Google (Gmail, Drive, Docs) as the signed-in admin's OWN Google account, through the google Edge Function
// (supabase/functions/google). The function holds the OAuth client secret and reads the admin's refresh token from
// the database with the secret key; no Google secret or token ever reaches the browser.
// `invoke(path, body)` is the store's mode.invoke: → { ok: true, ...data } | { ok: false, error }.
import { contractName, contractReplacements } from '../lib/contract.js';
import { isEmail, taxInvoiceModel } from '../lib/taxInvoice.js';

const str = (v) => String(v ?? '').trim();
const MAX_RECIPIENTS = 10;

/** Start connecting: the Google consent page to send the browser to. It comes back to Settings → Business; with purpose
 *  'calendar' (anyone: read-only Google Calendar for the team Calendar) to the Calendar; with purpose 'mailbox' and
 *  `{ mailbox }` (admins: an outreach mailbox's Gmail, read only) to Settings → Outreach. */
export async function googleConnectUrl(invoke, origin, purpose, extra = {}) {
  const res = await invoke('google/connect', purpose ? { origin, purpose, ...extra } : { origin });
  return res.ok && res.url ? { ok: true, url: res.url } : { ok: false, error: res.error || 'Could not start connecting Google.' };
}

/** 1–10 distinct, valid addresses, lower case. */
export function cleanRecipients(to) {
  const list = (Array.isArray(to) ? to : String(to ?? '').split(/[,;\s]+/)).map((x) => str(x).toLowerCase()).filter(Boolean);
  return [...new Set(list)].filter(isEmail).slice(0, MAX_RECIPIENTS);
}

// Bytes → base64, in chunks (String.fromCharCode on a whole PDF overflows the call stack).
export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A plain email from your own Gmail (Send test). → { ok } | { ok: false, error } */
export async function sendGoogleEmail(invoke, { to, subject, text }) {
  const recipients = cleanRecipients(to);
  if (!recipients.length) return { ok: false, error: 'Add at least one email address.' };
  return invoke('google/send', { to: recipients, subject: str(subject), text: String(text ?? '') });
}

// pdf-lib is in its own chunk, loaded only when a PDF is made. A tab opened before a deploy asks for a chunk name the new
// deployment no longer has (Pages answers with index.html), so a failed load means "reload", not a bad invoice.
export const RELOAD_ERROR = 'Cortex was updated. Reload the page, then try again.';
const loadInvoicePdf = () => import('../lib/invoicePdf.js');

/** The invoice PDF's bytes (also for Download PDF). → { ok: true, bytes } | { ok: false, error } */
export async function makeInvoicePdf({ client, invoice, org = {} }, load = loadInvoicePdf) {
  let invoicePdf;
  try {
    ({ invoicePdf } = await load());
  } catch {
    return { ok: false, error: RELOAD_ERROR };
  }
  try {
    return { ok: true, bytes: await invoicePdf({ client, invoice, org }) };
  } catch {
    return { ok: false, error: 'Could not make the PDF.' };
  }
}

/** An approved invoice and its PDF, from your own Gmail. Refused without your ABN (it wouldn't be a valid tax invoice)
 *  or without a recipient. → { ok } | { ok: false, error } */
export async function sendInvoiceEmail(invoke, { client, invoice, org = {}, to, subject, text }, load = loadInvoicePdf) {
  if (!str(org.abn)) return { ok: false, error: 'Add your ABN in Settings → Business first: without it this isn’t a valid tax invoice.' };
  const recipients = cleanRecipients(to);
  if (!recipients.length) return { ok: false, error: 'Add a billing contact with an email address.' };
  const pdf = await makeInvoicePdf({ client, invoice, org }, load);
  if (!pdf.ok) return pdf;
  const content = toBase64(pdf.bytes);
  const { filename } = taxInvoiceModel({ client, invoice, org });
  return invoke('google/send', {
    to: recipients, subject: str(subject), text: String(text ?? ''), attachment: { filename, content, type: 'application/pdf' },
  });
}

/** Copy the contract template into the contracts folder, filled in. → { ok: true, id, url, name } | { ok: false, error } */
export async function createContractDoc(invoke, { client, org = {}, contract }) {
  if (!str(org.contractTemplate) || !str(org.contractFolder)) {
    return { ok: false, error: 'Add the contract template and the contracts folder in Settings → Business.' };
  }
  const res = await invoke('google/contract', {
    template: str(org.contractTemplate), folder: str(org.contractFolder), name: contractName(client, contract),
    replacements: contractReplacements({ client, contract }),
  });
  return res.ok ? { ok: true, id: res.id, url: res.url, name: res.name } : res;
}
