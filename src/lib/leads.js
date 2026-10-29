// Leads (docs/PHASE2.md §23, 0016): lists of prospects pulled from a CSV export (Apollo, LinkedIn, HubSpot …), the leads on
// them, and the suppress list. All on the Outreach access level. A lead is checked against the suppress list and the CRM
// before it goes to the outreach agent; Convert to CRM makes it an account and a contact (Pipeline edit too). Pure, with
// relative imports, so scripts/test-sync.mjs runs it in Node.
import { domainOf, nameKey, similarAccounts, similarPeople } from './accounts.js';
import { safeUrl } from './format.js';

export const LEAD_STATUSES = {
  new: 'New', queued: 'Sent to agent', contacted: 'Contacted', replied: 'Replied', meeting: 'Meeting booked',
  not_interested: 'Not interested', bounced: 'Bounced', converted: 'In CRM',
};
export const LEAD_SOURCES = { csv: 'CSV', apollo: 'Apollo', manual: 'By hand' };
export const SUPPRESSION_KINDS = { email: 'Email', domain: 'Domain' };
// Personal mailboxes: a lead at one of these says nothing about its organisation (never matched or suppressed by domain).
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
  'me.com', 'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'proton.me', 'protonmail.com', 'aol.com']);

// Longest text each field keeps (0016's checks).
const MAX = {
  name: 200, title: 200, email: 254, phone: 50, linkedin: 2000, company: 200, domain: 253, sector: 100, country: 100, region: 100,
  timezone: 64, size: 100, note: 2000, notes: 2000, reason: 200,
};
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const emailOf = (v) => { const s = String(v ?? '').trim().toLowerCase(); return EMAIL.test(s) && s.length <= MAX.email ? s : ''; };
/** The organisation's domain for a lead: its own, else its email's (not a personal mailbox's). */
export const leadDomain = (lead) => {
  const d = domainOf(lead?.domain) || domainOf(lead?.email);
  return d && !FREE_MAIL.has(d) ? d : '';
};

/** A lead's fields as saved: text trimmed to 0016's limits, an email that looks like one (lower case), a LinkedIn link as
 *  http(s), a domain from what was given (else its email's), a known status and an owner among `userIds`. Only the
 *  fields given; invalid ones are left out. */
export function cleanLead(patch = {}, { userIds = null } = {}) {
  const out = {};
  ['name', 'title', 'phone', 'company', 'sector', 'country', 'region', 'timezone', 'size', 'note'].forEach((k) => {
    if (k in patch) out[k] = text(patch[k], MAX[k]);
  });
  if ('email' in patch) out.email = emailOf(patch.email);
  if ('linkedin' in patch) { const u = String(patch.linkedin ?? '').trim(); out.linkedin = u ? (safeUrl(u) || '').slice(0, MAX.linkedin) : ''; }
  if ('domain' in patch || 'email' in patch) {
    const d = domainOf(patch.domain) || (out.email ? domainOf(out.email) : '');
    if ('domain' in patch || !FREE_MAIL.has(d)) out.domain = FREE_MAIL.has(d) ? '' : d;
  }
  if ('status' in patch && patch.status in LEAD_STATUSES) out.status = patch.status;
  if ('owner' in patch) out.owner = !patch.owner || !userIds || userIds.includes(patch.owner) ? patch.owner || '' : '';
  return out;
}

export function cleanLeadList(patch = {}) {
  const out = {};
  if ('name' in patch) out.name = text(patch.name, 200);
  if ('notes' in patch) out.notes = text(patch.notes, MAX.notes);
  if ('source' in patch && patch.source in LEAD_SOURCES) out.source = patch.source;
  return out;
}

/** A suppression as saved: an email address, or a domain (from an address, a website or a typed domain), lower case.
 *  null when the value isn't one. */
export function cleanSuppression({ kind, value, reason } = {}) {
  const raw = String(value ?? '').trim();
  const k = kind === 'domain' || (kind !== 'email' && !raw.includes('@')) ? 'domain' : 'email';
  const v = k === 'email' ? emailOf(raw) : domainOf(raw);
  return v ? { kind: k, value: v, reason: text(reason, MAX.reason) } : null;
}

/** Why a lead must not be contacted, or '': its email or domain on the suppress list, its organisation's account set to
 *  Suppressed, or the person in the CRM as Do not contact. */
export function suppressedBy(state, lead) {
  const email = emailOf(lead?.email);
  const domain = leadDomain(lead);
  const list = state?.suppressions || [];
  const hit = list.find((x) => (x.kind === 'email' && email && x.value === email) || (x.kind === 'domain' && domain && x.value === domain));
  if (hit) return hit.kind === 'email' ? `Email on the suppress list${hit.reason ? `: ${hit.reason}` : ''}` : `Domain on the suppress list${hit.reason ? `: ${hit.reason}` : ''}`;
  const { account, person } = crmMatch(state, lead);
  if (person?.status === 'do_not_contact') return 'Do not contact in the CRM';
  // Any account it could be (two can share a name), not only the first.
  const accounts = [account, ...similarAccounts(state, { name: lead?.company, domain: leadDomain(lead) })];
  if (accounts.some((a) => a?.lifecycle === 'suppressed')) return 'Account suppressed in the CRM';
  return '';
}

/** The CRM account and contact a lead already is: the ones it was converted into, else the contact with its email (and
 *  that person's account), else the account with its company's name or its domain. */
export function crmMatch(state, lead) {
  const accounts = state?.accounts || [];
  const people = state?.crmContacts || [];
  let person = lead?.personId ? people.find((c) => c.id === lead.personId) || null : null;
  let account = lead?.accountId ? accounts.find((a) => a.id === lead.accountId) || null : null;
  const email = emailOf(lead?.email);
  if (!person && email) person = similarPeople(state, { email })[0] || null;
  if (!account && person) account = accounts.find((a) => a.id === person.accountId) || null;
  if (!account) account = similarAccounts(state, { name: lead?.company, domain: leadDomain(lead) })[0] || null;
  return { account, person };
}

/** The key two leads are the same person by: their email, else their name at their company. */
export const leadKey = (lead) => emailOf(lead?.email) || (String(lead?.name ?? '').trim()
  ? `${String(lead.name).trim().toLowerCase()}|${nameKey(lead.company)}` : '');

/** Leads that are the same person as `lead` on any list (other than itself). */
export function duplicatesOf(state, lead) {
  const key = leadKey(lead);
  return key ? (state?.leads || []).filter((l) => l.id !== lead.id && leadKey(l) === key) : [];
}

/** Each lead with what the table shows: suppressed (why), its CRM match, and whether it's on a list already (an earlier
 *  lead, by leadKey()). One pass over the leads. */
export function leadFlags(state, leads) {
  const first = new Map();
  (state?.leads || []).forEach((l) => { const k = leadKey(l); if (k && !first.has(k)) first.set(k, l.id); });
  return (leads || []).map((lead) => {
    const key = leadKey(lead);
    const { account, person } = crmMatch(state, lead);
    return { lead, suppressed: suppressedBy(state, lead), account, person, duplicate: Boolean(key && first.get(key) !== lead.id) };
  });
}

/** May go to the outreach agent: has an email, isn't suppressed, isn't a repeat, and hasn't been contacted or converted. */
export const sendable = (f) => Boolean(emailOf(f.lead.email)) && !f.suppressed && !f.duplicate && !f.person
  && ['new', 'queued'].includes(f.lead.status || 'new');

/** Leads by sector or country (`by`): how many, contacted (any status past Sent to agent), replied (replied, meeting or
 *  converted) and meetings, biggest first. */
export function scoreboard(leads, by = 'sector') {
  const rows = new Map();
  const CONTACTED = ['contacted', 'replied', 'meeting', 'not_interested', 'bounced', 'converted'];
  (leads || []).forEach((l) => {
    const k = String(l[by] ?? '').trim() || 'Not set';
    const r = rows.get(k) || rows.set(k, { key: k, leads: 0, contacted: 0, replied: 0, meetings: 0 }).get(k);
    r.leads += 1;
    if (CONTACTED.includes(l.status)) r.contacted += 1;
    if (['replied', 'meeting', 'converted'].includes(l.status)) r.replied += 1;
    if (l.status === 'meeting') r.meetings += 1;
  });
  return [...rows.values()].sort((a, b) => b.leads - a.leads || (a.key === 'Not set') - (b.key === 'Not set') || a.key.localeCompare(b.key));
}

// The columns the outreach agent's CSV gets, in its order.
export const AGENT_COLUMNS = [
  ['First Name', (l) => String(l.name || '').trim().split(/\s+/)[0] || ''],
  ['Last Name', (l) => String(l.name || '').trim().split(/\s+/).slice(1).join(' ')],
  ['Title', (l) => l.title], ['Email', (l) => l.email], ['Phone', (l) => l.phone], ['Company', (l) => l.company],
  ['Domain', (l) => l.domain], ['Sector', (l) => l.sector], ['Country', (l) => l.country], ['Region', (l) => l.region],
  ['Time zone', (l) => l.timezone], ['LinkedIn', (l) => l.linkedin], ['Note', (l) => l.note],
];
const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never a formula in a spreadsheet
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** The CSV the outreach agent takes: a header row, then one row per lead. */
export const agentCsv = (leads) => [AGENT_COLUMNS.map(([h]) => h), ...(leads || []).map((l) => AGENT_COLUMNS.map(([, f]) => f(l)))]
  .map((row) => row.map(cell).join(',')).join('\r\n');
