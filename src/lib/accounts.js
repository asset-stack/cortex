// The CRM (docs/PHASE2.md §22, 0014): accounts (organisations), the people at them (state.crmContacts) and the deals on
// them. Accounts and contacts follow the Pipeline access level, as deals do. Pure, with relative imports, so
// scripts/test-sync.mjs runs it in Node.
import { LOST, STALE_DAYS, daysInStage, dealStage } from '../data/boards.js';
import { safeUrl } from './format.js';

export const ACCOUNT_KINDS = { prospect: 'Prospect', customer: 'Customer', partner: 'Partner', supplier: 'Supplier' };
// Where an organisation is overall. The first six are the way forward; the rest are set aside, by hand.
export const LIFECYCLES = {
  new: 'New lead', contacted: 'Contacted', engaged: 'Engaged', meeting: 'Meeting booked', opportunity: 'Opportunity',
  customer: 'Customer', nurture: 'Nurture', rfp: 'Watching for RFP', not_now: 'Not now', suppressed: 'Suppressed',
};
export const FORWARD = ['new', 'contacted', 'engaged', 'meeting', 'opportunity', 'customer'];
export const CONTACT_ROLES = {
  decision_maker: 'Decision maker', champion: 'Champion', influencer: 'Influencer', gatekeeper: 'Gatekeeper',
  assistant: 'Assistant / PA', user: 'User', other: 'Other',
};
export const PERSON_STATUSES = { active: 'Active', left: 'Left', do_not_contact: 'Do not contact' };
// The time zones the team sells into, for the pickers (any IANA zone is kept).
export const TIMEZONES = [
  'Australia/Sydney', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Perth', 'Australia/Hobart',
  'Pacific/Auckland', 'Europe/London', 'Europe/Dublin', 'Europe/Amsterdam', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Riyadh',
  'Asia/Singapore', 'Asia/Manila', 'Asia/Tbilisi', 'America/Vancouver', 'America/Los_Angeles', 'America/Denver',
  'America/Chicago', 'America/New_York', 'America/Toronto',
];

// Longest text each field keeps (0014's checks).
const MAX = {
  name: 200, lifecycleNote: 500, sector: 100, country: 100, region: 100, timezone: 64, domain: 253, website: 2000, size: 100,
  guardrails: 5000, prepUrl: 2000, title: 200, email: 254, phone: 50, linkedin: 2000,
};
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : '');
const link = (v, max) => { const s = String(v ?? '').trim(); const u = s ? safeUrl(s) || '' : ''; return u.length <= max ? u : ''; };
/** A domain from an address, a website or a typed domain: "https://www.brisbane.qld.gov.au/x" → "brisbane.qld.gov.au". */
export function domainOf(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  const host = s.includes('@') ? s.split('@').pop() : s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
  const d = host.replace(/^www\./, '').replace(/:\d+$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d.slice(0, MAX.domain) : '';
}

/** An account's fields as saved: text trimmed to 0014's limits, a known kind and lifecycle, links as http(s), a domain
 *  from what was typed, an owner among `userIds` and a referrer among `accountIds` (never itself). Only the fields given;
 *  invalid ones are left out. */
export function cleanAccount(patch = {}, { userIds = null, accountIds = null, self = '' } = {}) {
  const out = {};
  ['name', 'lifecycleNote', 'sector', 'country', 'region', 'timezone', 'size', 'guardrails'].forEach((k) => {
    if (k in patch) out[k] = text(patch[k], MAX[k]);
  });
  if ('name' in out && !out.name) delete out.name; // an account always has a name
  if ('kind' in patch && patch.kind in ACCOUNT_KINDS) out.kind = patch.kind;
  if ('lifecycle' in patch && patch.lifecycle in LIFECYCLES) out.lifecycle = patch.lifecycle;
  if ('revisitOn' in patch) out.revisitOn = ymd(patch.revisitOn);
  if ('domain' in patch) out.domain = domainOf(patch.domain);
  if ('website' in patch) out.website = link(patch.website, MAX.website);
  if ('prepUrl' in patch) out.prepUrl = link(patch.prepUrl, MAX.prepUrl);
  if ('owner' in patch) out.owner = !patch.owner || !userIds || userIds.includes(patch.owner) ? patch.owner || '' : '';
  if ('referredBy' in patch) {
    out.referredBy = patch.referredBy && patch.referredBy !== self && (!accountIds || accountIds.includes(patch.referredBy)) ? patch.referredBy : '';
  }
  return out;
}

/** A contact's fields as saved: as cleanAccount, the email lower case, a known role and status, an account among
 *  `accountIds`. */
export function cleanPerson(patch = {}, { userIds = null, accountIds = null } = {}) {
  const out = {};
  ['name', 'title', 'phone', 'timezone'].forEach((k) => { if (k in patch) out[k] = text(patch[k], MAX[k]); });
  if ('email' in patch) out.email = text(patch.email, MAX.email).toLowerCase();
  if ('linkedin' in patch) out.linkedin = link(patch.linkedin, MAX.linkedin);
  if ('role' in patch && (patch.role === '' || patch.role in CONTACT_ROLES)) out.role = patch.role;
  if ('status' in patch && patch.status in PERSON_STATUSES) out.status = patch.status;
  if ('owner' in patch) out.owner = !patch.owner || !userIds || userIds.includes(patch.owner) ? patch.owner || '' : '';
  if ('accountId' in patch && patch.accountId && (!accountIds || accountIds.includes(patch.accountId))) out.accountId = patch.accountId;
  return out;
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
export const accountById = (state, id) => (id ? (state?.accounts || []).find((a) => a.id === id) || null : null);
/** The account with this name (any case), else null. */
export const accountNamed = (state, name) => (norm(name) ? (state?.accounts || []).find((a) => norm(a.name) === norm(name)) || null : null);
/** A deal's account. */
export const accountOf = (state, deal) => accountById(state, deal?.accountId);
/** The people at an account, in their order. */
export const peopleOf = (state, accountId) => (accountId ? (state?.crmContacts || []).filter((c) => c.accountId === accountId) : []);
/** A deal's contacts that still exist. */
export const dealPeople = (state, deal) => (deal?.contactIds || []).map((id) => (state?.crmContacts || []).find((c) => c.id === id)).filter(Boolean);
/** Open deals: not made a client, not lost. */
export const isOpenDeal = (deal) => !deal?.clientId && dealStage(deal) !== LOST;
/** An account's deals; `open` only the open ones. */
export const dealsOfAccount = (state, accountId, { open = false } = {}) => (accountId
  ? (state?.deals || []).filter((d) => d.accountId === accountId && (!open || isOpenDeal(d))) : []);
/** The deals a contact is on. */
export const dealsOfPerson = (state, personId) => (personId ? (state?.deals || []).filter((d) => (d.contactIds || []).includes(personId)) : []);

/** Lifecycle as the outreach automation moves it (0014's contact_pipeline): a reply makes new or contacted engaged; a
 *  booking makes new, contacted or engaged a meeting. Never back, never over a lifecycle set aside. */
export function lifecycleAfter(current, event) {
  const to = event === 'booked' ? 'meeting' : event === 'replied' ? 'engaged' : '';
  const from = current || 'new';
  if (!to || !FORWARD.includes(from)) return from;
  return FORWARD.indexOf(from) < FORWARD.indexOf(to) ? to : from;
}

/** Search text for an account: name, sector, country, region, domain. */
export const accountText = (a) => [a.name, a.sector, a.country, a.region, a.domain].join(' ').toLowerCase();
/** Search text for a contact: name, title, email, phone and the account's name. */
export const personText = (state, c) => [c.name, c.title, c.email, c.phone, accountById(state, c.accountId)?.name].join(' ').toLowerCase();

const REASON_ORDER = ['Overdue', 'Waiting on you', 'Stalled', 'No next step'];
/** What needs someone in the Pipeline today (Dashboard → My deals; Opportunities → Needs me): their open deals that are
 *  past their expected close, waiting on us, stalled (STALE_DAYS or more in their stage) or have no next step, most
 *  pressing first; and their accounts set aside (nurture, an RFP, not now) whose revisit date has come.
 *  → { deals: [{ deal, reasons }], revisits: [account] } */
export function needsYou(state, userId, { today, now = Date.now() } = {}) {
  const deals = (state?.deals || []).filter((d) => isOpenDeal(d) && d.contact === userId).map((deal) => {
    const reasons = [];
    if (deal.closeOn && today && deal.closeOn < today) reasons.push('Overdue');
    if (deal.waitingOn === 'us') reasons.push('Waiting on you');
    if ((daysInStage(deal, now) ?? 0) >= STALE_DAYS) reasons.push('Stalled');
    if (!String(deal.next || '').trim()) reasons.push('No next step');
    return { deal, reasons };
  }).filter((r) => r.reasons.length)
    .sort((a, b) => REASON_ORDER.indexOf(a.reasons[0]) - REASON_ORDER.indexOf(b.reasons[0]) || b.reasons.length - a.reasons.length
      || String(a.deal.name).localeCompare(String(b.deal.name)));
  const revisits = (state?.accounts || [])
    .filter((a) => a.owner === userId && ['nurture', 'rfp', 'not_now'].includes(a.lifecycle) && a.revisitOn && today && a.revisitOn <= today)
    .sort((a, b) => a.revisitOn.localeCompare(b.revisitOn));
  return { deals, revisits };
}

// A name as duplicates are found by: lower case, no punctuation or a leading "the", without a company suffix.
const SUFFIX = /\s+(pty\.?\s*ltd|pty|ltd|limited|inc|llc|plc|co|corp|corporation|group|gmbh)$/;
export const nameKey = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the\s+/, '').replace(SUFFIX, '').trim();

/** Accounts that look like the same organisation as `fields` (same name, as nameKey() reads it, or the same domain, from
 *  its domain or website), other than `self`. */
export function similarAccounts(state, fields = {}, self = '') {
  const key = nameKey(fields.name);
  const domain = domainOf(fields.domain) || domainOf(fields.website);
  if (!key && !domain) return [];
  return (state?.accounts || []).filter((a) => a.id !== self
    && ((key && nameKey(a.name) === key) || (domain && (a.domain === domain || domainOf(a.website) === domain))));
}

/** Contacts that look like the same person as `fields` (the same email anywhere, or the same name at the same account),
 *  other than `self`. */
export function similarPeople(state, fields = {}, self = '') {
  const email = String(fields.email ?? '').trim().toLowerCase();
  const name = String(fields.name ?? '').trim().toLowerCase();
  return (state?.crmContacts || []).filter((c) => c.id !== self
    && ((email && String(c.email || '').toLowerCase() === email)
      || (!email && name && fields.accountId && c.accountId === fields.accountId && String(c.name || '').trim().toLowerCase() === name)));
}
