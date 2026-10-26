// The CRM profile of a deal or client (docs/PHASE2.md §19): its timeline (notes and meetings), links and next steps, and
// who may add to it. Entries are crm_entries (0012); a client's timeline also reads its older notes (client_notes) and the
// entries of the deal it came from. Next steps are board tasks (items.values.deal / client, src/lib/work.js). Pure, with
// relative imports, so scripts/test-sync.mjs runs it in Node; the access rules are 0012's, mirrored.
import { canEdit, canView, isAdmin } from './access.js';
import { safeUrl } from './format.js';

export const ENTRY_KINDS = ['note', 'meeting', 'link'];
export const LINK_LABELS = ['Meeting notes', 'Demo', 'Deck', 'Proposal', 'Recording', 'Other'];
// Longest text each field keeps (the database's checks).
const MAX = { title: 300, body: 20000, url: 2000, label: 60, attendees: 1000 };

const isActive = (state, userId) => (state?.users || []).some((u) => u.id === userId && u.active !== false);
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : '');

/** Who reads an entry (0012 crm_select): an active teammate with Clients view for a client's, Pipeline view for a
 *  deal's. */
export const canReadEntry = (state, e, userId = state?.me) => Boolean(e) && isActive(state, userId)
  && ((Boolean(e.clientId) && canView(state, 'clients', userId)) || (Boolean(e.dealId) && canView(state, 'pipeline', userId)));
/** Who adds one (crm_insert): a client's with Clients edit; a deal's (not a client yet) with Pipeline edit. */
export const canAddEntry = (state, { clientId = '', dealId = '' } = {}, userId = state?.me) => isActive(state, userId)
  && Boolean(clientId || dealId) && (clientId ? canEdit(state, 'clients', userId) : canEdit(state, 'pipeline', userId));
/** Who changes or removes one (crm_update / crm_delete): as adding, and its author or an admin. */
export const canChangeEntry = (state, e, userId = state?.me) => Boolean(e) && canAddEntry(state, e, userId)
  && (e.user === userId || isAdmin(state, userId));

/**
 * A new or edited entry's fields, cleaned: a known kind; text trimmed to the database's limits; a link that is http(s)
 * (https:// added when missing; anything else dropped); a meeting's date as YYYY-MM-DD; a link's label one of
 * LINK_LABELS (else Other). → the fields, or null when there's nothing to keep (a note with no text, a link with no
 * usable URL, a meeting with no title, summary or notes link).
 */
export function cleanEntry(fields = {}) {
  const kind = ENTRY_KINDS.includes(fields.kind) ? fields.kind : 'note';
  const url = fields.url ? safeUrl(text(fields.url, MAX.url)) || '' : '';
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

/** The deal a client came from (Make client), or null. */
export const dealOfClient = (state, clientId) => (clientId && (state?.deals || []).find((d) => d.clientId === clientId)) || null;

// The entries on a deal, or on a client (its own and its deal's: those reach it in the database at Make client, and
// may not have come back yet), each once.
function entriesOf(state, { dealId = '', clientId = '' }) {
  const all = state?.crmEntries || [];
  if (dealId) return all.filter((e) => e.dealId === dealId);
  if (!clientId) return [];
  const deal = dealOfClient(state, clientId);
  return all.filter((e) => e.clientId === clientId || (deal && e.dealId === deal.id));
}
// Newest first: a meeting by the day it happened, anything else by when it was added; then the latest added.
const when = (e) => (e.kind === 'meeting' && e.happenedOn) || String(e.createdAt || '').slice(0, 10);
const newestFirst = (a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

/**
 * A deal's or client's timeline: its notes and meetings, newest first. A client's includes its older notes (client_notes,
 * as notes marked `legacy`, which can't be changed here) and its deal's entries.
 */
export function timelineOf(state, { dealId = '', clientId = '' } = {}) {
  const entries = entriesOf(state, { dealId, clientId }).filter((e) => e.kind !== 'link');
  const client = clientId && (state?.clients || []).find((c) => c.id === clientId);
  const legacy = client ? (client.notes || []).map((n) => ({
    id: `note:${n.id}`, kind: 'note', body: n.text, user: n.user, createdAt: n.ts, dealId: '', clientId, title: '', url: '',
    label: '', happenedOn: '', attendees: '', legacy: true,
  })) : [];
  return [...entries, ...legacy].sort(newestFirst);
}

/** A deal's or client's links, newest first; a client's also lists its Demo and Platform fields (marked `fixed`, edited
 *  on the client itself). Only http(s) links. */
export function linksOf(state, { dealId = '', clientId = '' } = {}) {
  const links = entriesOf(state, { dealId, clientId }).filter((e) => e.kind === 'link' && safeUrl(e.url))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const client = clientId && (state?.clients || []).find((c) => c.id === clientId);
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
