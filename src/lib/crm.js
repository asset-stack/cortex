// The CRM profile of a deal or client (docs/PHASE2.md §19), and since 0014 of an account or a contact (§22): its
// timeline (notes and meetings), links and next steps, and who may add to it. Entries are crm_entries (0012); a client's timeline also reads its older notes (client_notes) and the
// entries of the deal it came from. Next steps are board tasks (items.values.deal / client, src/lib/work.js). Pure, with
// relative imports, so scripts/test-sync.mjs runs it in Node; the access rules are 0012's, mirrored.
import { canEdit, canView, isAdmin } from './access.js';
import { localYmd, safeUrl } from './format.js';

export const ENTRY_KINDS = ['note', 'meeting', 'link'];
export const LINK_LABELS = ['Meeting notes', 'Demo', 'Deck', 'Proposal', 'Recording', 'Other'];
// Longest text each field keeps (the database's checks).
const MAX = { title: 300, body: 20000, url: 2000, label: 60, attendees: 1000 };
/** Longest link an entry keeps, as saved (https:// added, spaces and accents encoded). */
export const URL_MAX = MAX.url;

const isActive = (state, userId) => (state?.users || []).some((u) => u.id === userId && u.active !== false);
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : '');

/** Who reads an entry (0014 crm_select): an active teammate with Clients view for a client's, Pipeline view for a
 *  deal's, an account's or a contact's. */
export const canReadEntry = (state, e, userId = state?.me) => Boolean(e) && isActive(state, userId)
  && ((Boolean(e.clientId) && canView(state, 'clients', userId))
    || (Boolean(e.dealId || e.accountId || e.contactId) && canView(state, 'pipeline', userId)));
/** Who adds one (crm_insert): a client's with Clients edit; any other (a deal not a client yet, an account, a contact)
 *  with Pipeline edit. */
export const canAddEntry = (state, { clientId = '', dealId = '', accountId = '', contactId = '' } = {}, userId = state?.me) => isActive(state, userId)
  && Boolean(clientId || dealId || accountId || contactId) && (clientId ? canEdit(state, 'clients', userId) : canEdit(state, 'pipeline', userId));
/** Who changes or removes one (crm_update / crm_delete): as adding, and its author or an admin. */
export const canChangeEntry = (state, e, userId = state?.me) => Boolean(e) && canAddEntry(state, e, userId)
  && (e.user === userId || isAdmin(state, userId));

/** A link as an entry keeps it: http(s) (https:// added when missing) and no longer than URL_MAX once saved, else ''. */
export function entryUrl(v) {
  const url = String(v ?? '').trim() ? safeUrl(String(v).trim()) || '' : '';
  return url.length <= URL_MAX ? url : '';
}

/**
 * A new or edited entry's fields, cleaned: a known kind; text trimmed to the database's limits; a link as `entryUrl()`
 * (anything else dropped); a meeting's date as YYYY-MM-DD; a link's label one of LINK_LABELS (else Other). → the fields,
 * or null when there's nothing to keep (a note with no text, a link with no usable URL, a meeting with no title, summary
 * or notes link).
 */
export function cleanEntry(fields = {}) {
  const kind = ENTRY_KINDS.includes(fields.kind) ? fields.kind : 'note';
  const url = entryUrl(fields.url);
  const out = {
    kind,
    title: text(fields.title, MAX.title),
    body: text(fields.body, MAX.body),
    url,
    label: kind === 'link' ? (LINK_LABELS.includes(fields.label) ? fields.label : 'Other') : '',
    happenedOn: kind === 'meeting' ? ymd(fields.happenedOn) : '',
    attendees: kind === 'meeting' ? text(fields.attendees, MAX.attendees) : '',
  };
  if (kind === 'note' && !out.body) return null;
  if (kind === 'link' && !out.url) return null;
  if (kind === 'meeting' && !out.title && !out.body && !out.url) return null;
  return out;
}

/** The deals a client came from (Make client; a second deal for the same organisation joins the same client). */
export const dealsOfClient = (state, clientId) => (clientId ? (state?.deals || []).filter((d) => d.clientId === clientId) : []);

// The entries on a deal, or on a client (its own and its deals': those reach it in the database at Make client, and
// may not have come back yet), or on a contact, or on an account (its own, its contacts', its deals' and its client's),
// each once.
function entriesOf(state, { dealId = '', clientId = '', accountId = '', contactId = '' }) {
  const all = state?.crmEntries || [];
  if (dealId) return all.filter((e) => e.dealId === dealId);
  if (contactId) return all.filter((e) => e.contactId === contactId);
  if (accountId) {
    const account = (state?.accounts || []).find((a) => a.id === accountId);
    const people = new Set((state?.crmContacts || []).filter((c) => c.accountId === accountId).map((c) => c.id));
    const deals = new Set((state?.deals || []).filter((d) => d.accountId === accountId).map((d) => d.id));
    const client = account?.clientId || '';
    return all.filter((e) => e.accountId === accountId || people.has(e.contactId) || deals.has(e.dealId) || (client && e.clientId === client));
  }
  if (!clientId) return [];
  const deals = new Set(dealsOfClient(state, clientId).map((d) => d.id));
  return all.filter((e) => e.clientId === clientId || deals.has(e.dealId));
}
// The client whose own notes and links a profile shows: the client's, or an account's client (0014).
function profileClient(state, { dealId = '', clientId = '', accountId = '', contactId = '' }) {
  const id = clientId || (accountId && !dealId && !contactId ? (state?.accounts || []).find((a) => a.id === accountId)?.clientId || '' : '');
  return (id && (state?.clients || []).find((c) => c.id === id)) || null;
}
// Newest first: a meeting by the day it happened, anything else by the day (here) it was added; then the latest added.
const when = (e) => (e.kind === 'meeting' && e.happenedOn) || (e.createdAt ? localYmd(new Date(e.createdAt)) : '');
const newestFirst = (a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

/**
 * A deal's or client's timeline: its notes and meetings, newest first. A client's includes its older notes (client_notes,
 * as notes marked `legacy`, which can't be changed here) and its deal's entries.
 */
export function timelineOf(state, { dealId = '', clientId = '', accountId = '', contactId = '' } = {}) {
  const entries = entriesOf(state, { dealId, clientId, accountId, contactId }).filter((e) => e.kind !== 'link');
  const client = profileClient(state, { dealId, clientId, accountId, contactId }); // its older notes too
  const legacy = client ? (client.notes || []).map((n) => ({
    id: `note:${n.id}`, kind: 'note', body: n.text, user: n.user, createdAt: n.ts, dealId: '', clientId: client.id, title: '', url: '',
    label: '', happenedOn: '', attendees: '', legacy: true,
  })) : [];
  return [...entries, ...legacy].sort(newestFirst);
}

/** A deal's or client's links, newest first; a client's also lists its Demo and Platform fields (marked `fixed`, edited
 *  on the client itself). Only http(s) links. */
export function linksOf(state, { dealId = '', clientId = '', accountId = '', contactId = '' } = {}) {
  const links = entriesOf(state, { dealId, clientId, accountId, contactId }).filter((e) => e.kind === 'link' && safeUrl(e.url))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const client = profileClient(state, { dealId, clientId, accountId, contactId });
  const fixed = client ? [['Demo', client.demoUrl], ['Platform', client.platformUrl]]
    .filter(([, url]) => safeUrl(url)).map(([label, url]) => ({ id: `fixed:${label}`, kind: 'link', label, title: label, url, fixed: true })) : [];
  return [...fixed, ...links];
}

/** Demo mode's Make client (0012's crm_carry_to_client): a deal's entries that aren't a client's yet become this one's. */
export function carryDealEntriesLocal(state, dealId, clientId) {
  if (!dealId || !clientId) return;
  (state.crmEntries || []).forEach((e) => { if (e.dealId === dealId && !e.clientId) e.clientId = clientId; });
}

/** Demo mode's deleting a deal (0012's crm_drop_deal_entries, then on delete set null): its entries that never reached a
 *  client go; the others stay with their client, off the deal. */
export function dropDealEntriesLocal(state, dealId) {
  if (!dealId || !state.crmEntries) return;
  state.crmEntries = state.crmEntries.filter((e) => !(e.dealId === dealId && !e.clientId));
  state.crmEntries.forEach((e) => { if (e.dealId === dealId) e.dealId = ''; });
}
