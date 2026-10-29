// CSV import mapping (docs/BACKEND.md §4): which columns feed which fields, and one CSV row → one record in
// state shape for actions.importRecords(), which adds ids and skips names that already exist. Pure functions.
import {
  ALL_DEAL_STAGES, BOARD_SCHEMAS, CLIENT_STATUSES, CONTACT_STATUSES, CURRENCIES, DEAL_STAGES, LOST, OLD_DEAL_STAGES, PRIORITY, STATUS,
  dealStage as boardStage,
} from '@/data/boards';
import { LIFECYCLES } from '@/lib/accounts';
import { localYmd } from '@/lib/format';

// Field types drive parsing and the preview: text | user (one staff member) | users | date (YYYY-MM-DD) |
// ts (ISO timestamp) | money | note (becomes the record's first note / update). `column`: tasks only, kept
// when the chosen board has a column with that key. `person`: clients only, the property of the client's first
// contact (a billing one) the field fills. `bare`: a header the field takes only when no other column matched it,
// even from a field that also wants it. Aliases are header spellings, most likely first.
const field = (key, label, type, aliases, extra) => ({ key, label, type, aliases, ...extra });
const NAME = { required: true };
const CREATED = ['created', 'created date', 'created at', 'date created', 'date added'];
const NOTES = ['notes', 'note', 'comments', 'description', 'details'];

export const FIELDS = {
  clients: [
    field('name', 'Name', 'text', ['name', 'client name', 'client', 'organisation', 'organization', 'company', 'account', 'organisation name', 'company name'], NAME),
    field('status', 'Status', 'text', ['status', 'client status', 'stage']),
    field('priority', 'Priority', 'text', ['priority']),
    field('next', 'Next step', 'text', ['next step', 'next steps', 'next action', 'next']),
    field('sector', 'Sector', 'text', ['sector', 'industry', 'segment', 'vertical']),
    // A "Contact" column is the client's contact person, unless another column is ("Key contact", "Primary
    // contact", "Contact name"…): then it is the owner, as in the old export.
    field('contact', 'Owner', 'user', ['owner', 'account manager', 'assigned to', 'assignee', 'contact']),
    field('team', 'Team', 'users', ['team', 'team members', 'members']),
    field('keyContact', 'Key contact', 'text', ['key contact', 'primary contact', 'main contact', 'client contact', 'contact name', 'contact person', 'billing contact'], { person: 'name', bare: 'contact' }),
    field('email', 'Email', 'text', ['email', 'email address', 'contact email', 'key contact email', 'billing email'], { person: 'email' }),
    field('phone', 'Phone', 'text', ['phone', 'phone number', 'telephone', 'tel', 'mobile number', 'mobile phone', 'contact phone', 'contact number', 'key contact phone'], { person: 'phone' }),
    field('platformUrl', 'Platform', 'text', ['platform', 'platform url', 'platform link', 'platform address', 'site']),
    field('lastContact', 'Last contact', 'date', ['last contact', 'last contacted', 'last contact date', 'last touch', 'last activity']),
    field('demo', 'Demo', 'text', ['demo', 'demo status']),
    field('demoUrl', 'Demo link', 'text', ['demo url', 'demo link']),
    field('abn', 'ABN', 'text', ['abn', 'australian business number']),
    field('billingAddress', 'Billing address', 'text', ['billing address', 'address', 'postal address']),
    field('notes', 'Notes', 'note', NOTES),
    field('created', 'Created', 'ts', CREATED),
  ],
  contacts: [
    field('name', 'Name', 'text', ['name', 'full name', 'contact name', 'contact', 'person', 'key contact'], NAME),
    field('org', 'Organisation', 'text', ['organisation', 'organization', 'org', 'company', 'client name', 'client', 'account']),
    field('email', 'Email', 'text', ['email', 'email address', 'contact email']),
    field('stage', 'Stage', 'text', ['stage', 'lifecycle stage', 'pipeline stage']),
    field('status', 'Status', 'text', ['status', 'email status', 'outreach status']),
    field('last', 'Last contact', 'ts', ['last contact', 'last contacted', 'last activity', 'last touch', 'last email']),
    field('created', 'Created', 'ts', CREATED),
  ],
  deals: [
    field('name', 'Name', 'text', ['name', 'deal name', 'deal', 'organisation', 'organization', 'company', 'client name', 'client', 'account', 'opportunity', 'company name'], NAME),
    field('sector', 'Sector', 'text', ['sector', 'industry', 'segment', 'vertical']),
    field('value', 'Value', 'money', ['value', 'amount', 'deal value', 'annual value', 'contract value', 'acv', 'arr']),
    field('priority', 'Priority', 'text', ['priority']),
    field('stage', 'Stage', 'text', ['stage', 'status', 'deal stage', 'pipeline stage']),
    field('contact', 'Owner', 'user', ['owner', 'contact', 'deal owner', 'assigned to', 'assignee', 'account manager']),
    field('next', 'Next step', 'text', ['next step', 'next steps', 'next action', 'next']),
    // 0014: the deal's currency, expected close and account (else the account named like the deal).
    field('currency', 'Currency', 'text', ['currency', 'deal currency', 'currency code']),
    field('closeOn', 'Close date', 'date', ['close date', 'expected close', 'expected close date', 'closing date', 'close']),
    field('account', 'Account', 'text', ['account', 'account name', 'company', 'company name', 'organisation', 'organization'], { secondary: true }),
  ],
  // The CRM (0014): organisations, then the people at them (by their account's name).
  accounts: [
    field('name', 'Name', 'text', ['name', 'account', 'account name', 'company', 'company name', 'organisation', 'organization', 'organisation name'], NAME),
    field('kind', 'Type', 'text', ['type', 'account type', 'company type', 'kind', 'relationship']),
    field('lifecycle', 'Lifecycle', 'text', ['lifecycle', 'lifecycle stage', 'lead status', 'stage', 'status']),
    field('sector', 'Sector', 'text', ['sector', 'industry', 'segment', 'vertical']),
    field('country', 'Country', 'text', ['country', 'company country']),
    field('region', 'State / region', 'text', ['state', 'region', 'state region', 'province', 'county', 'company state']),
    field('timezone', 'Time zone', 'text', ['time zone', 'timezone']),
    field('website', 'Website', 'text', ['website', 'website url', 'company website', 'domain', 'company domain', 'web']),
    field('size', 'Size', 'text', ['size', 'employees', 'number of employees', 'company size', 'headcount']),
    field('contact', 'Owner', 'user', ['owner', 'account owner', 'company owner', 'assigned to', 'account manager']),
    field('guardrails', 'Guardrails', 'text', ['guardrails', 'do not say', 'dont say']),
    field('notes', 'Notes', 'note', NOTES),
  ],
  people: [
    field('name', 'Name', 'text', ['name', 'full name', 'contact name', 'contact', 'person'], NAME),
    field('account', 'Account', 'text', ['account', 'company', 'company name', 'organisation', 'organization', 'account name', 'employer']),
    field('title', 'Title', 'text', ['title', 'job title', 'position']),
    field('email', 'Email', 'text', ['email', 'email address', 'work email']),
    field('phone', 'Phone', 'text', ['phone', 'phone number', 'mobile', 'mobile phone', 'direct phone', 'work phone', 'telephone']),
    field('linkedin', 'LinkedIn', 'text', ['linkedin', 'linkedin url', 'person linkedin url', 'linkedin profile']),
    field('role', 'Role in the deal', 'text', ['role', 'buying role', 'persona']),
    field('timezone', 'Time zone', 'text', ['time zone', 'timezone']),
    field('contact', 'Owner', 'user', ['owner', 'contact owner', 'assigned to']),
  ],
  // Leads (0016): a prospect list from Apollo, LinkedIn or HubSpot (first and last name columns become Full name).
  leads: [
    field('name', 'Name', 'text', ['full name', 'name', 'contact name', 'contact', 'person'], NAME),
    field('title', 'Title', 'text', ['title', 'job title', 'position']),
    field('email', 'Email', 'text', ['email', 'email address', 'work email', 'business email']),
    field('company', 'Company', 'text', ['company', 'company name', 'organisation', 'organization', 'account', 'account name', 'employer']),
    field('phone', 'Phone', 'text', ['phone', 'phone number', 'work direct phone', 'mobile phone', 'mobile', 'first phone', 'direct phone', 'corporate phone', 'telephone']),
    field('linkedin', 'LinkedIn', 'text', ['person linkedin url', 'linkedin url', 'linkedin', 'linkedin profile', 'profile url']),
    field('domain', 'Website', 'text', ['website', 'company website', 'domain', 'company domain', 'website url', 'web']),
    field('sector', 'Sector', 'text', ['industry', 'sector', 'segment', 'vertical']),
    field('country', 'Country', 'text', ['country', 'company country']),
    field('region', 'State / region', 'text', ['state', 'region', 'company state', 'province', 'county']),
    field('timezone', 'Time zone', 'text', ['time zone', 'timezone']),
    field('size', 'Size', 'text', ['employees', 'number of employees', 'company size', 'size', 'headcount']),
    field('contact', 'Owner', 'user', ['owner', 'contact owner', 'lead owner', 'assigned to']),
    field('notes', 'Note', 'text', NOTES),
  ],
  tasks: [
    field('name', 'Name', 'text', ['name', 'task', 'title', 'task name', 'item'], NAME),
    field('people', 'People', 'users', ['people', 'owner', 'owners', 'assignee', 'assignees', 'assigned to', 'person', 'responsible', 'team', 'members', 'contact']),
    field('status', 'Status', 'text', ['status', 'state', 'progress']),
    field('priority', 'Priority', 'text', ['priority', 'importance'], { column: true }),
    field('type', 'Type', 'text', ['type', 'category'], { column: true }),
    field('channel', 'Channel', 'text', ['channel', 'platform'], { column: true }),
    field('approval', 'Approval', 'text', ['approval', 'approved', 'approval status'], { column: true }),
    field('due', 'Due', 'date', ['due', 'due date', 'deadline', 'due on', 'date'], { column: true }),
    field('details', 'Details', 'text', ['details', 'detail', 'summary'], { column: true }),
    field('notes', 'Notes', 'note', [...NOTES, 'update', 'updates']),
    field('created', 'Created', 'ts', CREATED),
  ],
};

/** The fields for a kind; for tasks, only the columns the chosen board has (`board`: its module, a BOARD_MODULES entry). */
export function fieldsFor(kind, board) {
  const cols = BOARD_SCHEMAS[board]?.columns;
  const fields = (FIELDS[kind] || []).filter((f) => !f.column || !cols || cols.some((c) => c.key === f.key));
  // A board that calls a row a Client (Work in Progress) also reads a Client or Organisation column as the name.
  const item = BOARD_SCHEMAS[board]?.item;
  return kind === 'tasks' && item === 'Client'
    ? fields.map((f) => (f.key === 'name' ? { ...f, aliases: [...f.aliases, 'client', 'client name', 'organisation', 'organization', 'company'] } : f))
    : fields;
}

// ── Header matching ──────────────────────────────────────────────────────────

// "Key_Contact", "keyContact" and "key contact" all read as "key contact".
const words = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// 100 for the same words, 95 for the same letters run together, 50–90 when the header contains every word of
// an alias (the closer the fit, the higher; not for the bare 'date', so "Updated date" never becomes Due).
// Earlier aliases win ties. Id columns never match.
function score(header, aliases) {
  const h = words(header);
  const ht = h.split(' ');
  if (!h || ht[ht.length - 1] === 'id') return 0;
  let best = 0;
  aliases.forEach((alias, i) => {
    const a = words(alias);
    const at = a.split(' ');
    let s = 0;
    if (h === a) s = 100;
    else if (h.replace(/ /g, '') === a.replace(/ /g, '')) s = 95;
    else if (a !== 'date' && at.every((t) => ht.includes(t))) s = 50 + (40 * at.length) / ht.length;
    if (s) best = Math.max(best, s - i * 0.01);
  });
  return best;
}

// Separate first and last name columns (HubSpot, Apollo and LinkedIn exports) → a "Full name" column in front,
// which the name field prefers to either half. A file that already has a name column is left as it is.
const FIRST_NAME = ['first name', 'firstname', 'given name'];
const LAST_NAME = ['last name', 'lastname', 'surname', 'family name'];
export function withFullName({ headers, rows }) {
  const hw = headers.map(words);
  const fi = hw.findIndex((h) => FIRST_NAME.includes(h));
  const li = hw.findIndex((h) => LAST_NAME.includes(h));
  if (fi < 0 || li < 0 || hw.some((h) => h === 'name' || h === 'full name')) return { headers, rows };
  return {
    headers: ['Full name', ...headers],
    rows: rows.map((r) => [`${r[fi] ?? ''} ${r[li] ?? ''}`.trim(), ...r]),
  };
}

/** Headers → { [fieldKey]: column index, or -1 }. Best matches are taken first; each column is used once. */
export function autoMap(headers, kind, board) {
  const fields = fieldsFor(kind, board);
  const pairs = [];
  fields.forEach((f, fi) => (headers || []).forEach((h, hi) => {
    const s = score(h, f.aliases);
    if (s > 0) pairs.push({ key: f.key, fi, hi, s });
  }));
  pairs.sort((a, b) => b.s - a.s || a.fi - b.fi || a.hi - b.hi);
  // A `secondary` field (a deal's Account) takes a column only once the others have picked theirs, so a lone Company
  // column is still the deal's name.
  const secondary = new Set(fields.filter((f) => f.secondary).map((f) => f.key));
  const pick = (preset) => {
    const mapping = { ...Object.fromEntries(fields.map((f) => [f.key, -1])), ...preset };
    const used = new Set(Object.values(preset));
    [false, true].forEach((late) => pairs.forEach(({ key, hi }) => {
      if (secondary.has(key) !== late || mapping[key] !== -1 || used.has(hi)) return;
      mapping[key] = hi;
      used.add(hi);
    }));
    return mapping;
  };
  const mapping = pick({});
  // A field still unmatched takes its bare header (clients' "Contact"), and the rest are matched again around it.
  const bare = fields.find((f) => f.bare && mapping[f.key] === -1);
  const hi = bare ? (headers || []).findIndex((h) => words(h) === bare.bare) : -1;
  return hi >= 0 ? pick({ [bare.key]: hi }) : mapping;
}

// ── Value parsing ────────────────────────────────────────────────────────────

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const EMAIL = /[^\s<>()[\],;:"']+@[^\s<>()[\],;:"']+\.[a-z]{2,}/i;
const emailOf = (v) => (String(v ?? '').match(EMAIL)?.[0] || '').toLowerCase();

// One cell can name several people: "Dale, Stu", "Dale & Stu", or a JSON list from an export.
const people = (v) => String(v ?? '').replace(/[[\]"]/g, ' ').split(/[,;|/\n]|\s&\s|\sand\s/i).map(norm).filter(Boolean);

/** A staff member by email, full name, or first name / email name when only one person fits. → id or '' */
export function matchUser(value, users = []) {
  const v = norm(value);
  if (!v) return '';
  const email = emailOf(v);
  const byEmail = email && users.find((u) => norm(u.email) === email);
  if (byEmail) return byEmail.id;
  const name = email ? email.split('@')[0].replace(/[._-]+/g, ' ') : v.replace(/<[^>]*>/g, '').trim();
  const exact = users.find((u) => norm(u.name) === name);
  if (exact) return exact.id;
  const first = name.split(' ')[0];
  const loose = users.filter((u) => norm(u.name).split(' ')[0] === first || norm(u.email).split('@')[0] === name.replace(/ /g, '.'));
  return loose.length === 1 ? loose[0].id : '';
}

const matchUsers = (v, users) => [...new Set(people(v).map((p) => matchUser(p, users)).filter(Boolean))];

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// 1–12 for a month name or its start ("Sep", "Sept"), else 0: "Mayor" and "Marketing" aren't months.
const monthOf = (w) => {
  const x = String(w).toLowerCase();
  return x.length >= 3 ? MONTHS.findIndex((name) => name.startsWith(x)) + 1 : 0;
};
// "19 May 2026", "Tue 19-May-26", "19th of May, 2026" | "May 19, 2026", "Tuesday May 19 2026" (a weekday or
// other word may come first).
const DAY_MONTH_YEAR = /^(?:[a-z]+\.?,?\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?[\s-]+([a-z]+)\.?,?[\s-]+(\d{4}|\d{2})(?!\d)/i;
const MONTH_DAY_YEAR = /^(?:[a-z]+\.?,?\s+)?([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/i;
function ymd(y, m, d) {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? `${y}-${pad(m)}-${pad(d)}` : '';
}

/** Any common date spelling → 'YYYY-MM-DD', or '' when it isn't a date. Slashed dates are day first (AU). */
export function toYmd(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/);
  if (m) {
    // A timestamp with a zone is a moment: use the local day. Anything else is the date as written.
    if (/^[T\s]\d.*(Z|[+-]\d{2}:?\d{2})$/i.test(m[4])) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return localYmd(d);
    }
    return ymd(+m[1], +m[2], +m[3]);
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/);
  if (m) {
    let [d, mo] = [+m[1], +m[2]];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // only a month-first (US) date has a second part over 12
    return ymd(+m[3], mo, d);
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) { // Excel serial day number
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  // A month name with a day and a year. Anything less ("TBC 2026", "Week 3", "13 Oct") isn't a date: Date()
  // would make up the missing parts.
  m = s.match(DAY_MONTH_YEAR);
  if (m && monthOf(m[2])) return ymd(+m[3], monthOf(m[2]), +m[1]);
  m = s.match(MONTH_DAY_YEAR);
  if (m && monthOf(m[1])) return ymd(+m[3], monthOf(m[1]), +m[2]);
  return '';
}

/** Date or date-time → ISO timestamp ('' when it isn't one). A plain date means local midnight. */
export function toIso(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}/.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const day = toYmd(s);
  return day ? new Date(`${day}T00:00:00`).toISOString() : '';
}

// '$250,000' | 'A$250,000' | 'AU$ 5,000' | '250k' | '1.2m' | 'AUD 85 000' → number; anything else → 0.
// '$250,000', 'AUD 250k', '£40,000', 'NZ$1.2m', 'USD 5000' → a number (any currency's symbol or code dropped); else 0.
export function parseMoney(v) {
  const t = String(v ?? '').toLowerCase().replace(/\b(aud|nzd|gbp|usd|eur|cad|aed|sar)\b|[a-z]{0,2}\$|[£€]|,|\s/g, '');
  const m = t.match(/^(\d+(?:\.\d+)?)([km])?$/);
  return m ? Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1)) : 0;
}

const exactly = (s, options) => options.find((k) => norm(k) === s);

// "Client onboarding" → Onboarding, "Proposal Sent" → Proposal sent; anything unrecognised is Active.
function clientStatus(v) {
  const s = norm(v);
  return exactly(s, Object.keys(CLIENT_STATUSES))
    || (/onboard/.test(s) && 'Onboarding')
    || (/proposal|quote/.test(s) && 'Proposal sent')
    || (/passive|inactive|not active|not current|dormant|paused|on hold|churn|lost|cold/.test(s) && 'Passive')
    || 'Active';
}

// "Not urgent", "Non-critical", "Unimportant": a negated priority is the middle one, not its opposite.
const NOT_PRIORITY = /^(not|non|no)\b|^un/;

// P1 for high / urgent / 1, P3 (deals only) for low / 3, otherwise P2.
function priority(v, allowP3) {
  if (NOT_PRIORITY.test(norm(v))) return 'P2';
  const s = norm(v).replace(/\s/g, '');
  if (/^p?1$|high|urgent|critical|hot/.test(s)) return 'P1';
  if (allowP3 && /^p?3$|low/.test(s)) return 'P3';
  return 'P2';
}

const [INTERESTED, BOOKED, INTRO, DEMO, PROPOSAL, CONTRACT] = DEAL_STAGES;
// Pipeline's stages (0014): the names as they are (or as they were before 0014); lost or dead is Lost; negated ("Won't
// proceed", "Not signed", "Uncontacted") is Interested; won, signed, closed, a contract, a client or onboarding is
// Contract sent, the last open stage (Make client is the deal's Won); then proposal or quote wording, demo, pilot or trial,
// an intro, and a meeting or call; anything else is Interested.
function dealStage(v) {
  const s = norm(v);
  const named = exactly(s, ALL_DEAL_STAGES) || exactly(s, Object.keys(OLD_DEAL_STAGES).filter((k) => k !== 'Won'));
  if (named) return boardStage({ stage: named });
  return (/\blost\b|\bdead\b|lost to|closed.?lost/.test(s) && LOST)
    || (/\bnot\b|\bnever\b|\bno\b|won['’]t|\bun ?-?(contacted|sent|emailed|reached|signed)/.test(s) && INTERESTED)
    || (/\bwon\b|closed|\bsigned\b|contract/.test(s) && CONTRACT)
    || (/proposal|quote|pricing|negotiat/.test(s) && PROPOSAL)
    || (/demo|pilot|trial/.test(s) && DEMO)
    || (/intro/.test(s) && INTRO)
    || (/meeting|call|discovery/.test(s) && BOOKED)
    || (/client|onboard/.test(s) && CONTRACT)
    || INTERESTED;
}

// An account's type from an export's wording ("Partner", "Reseller", "Customer", "Vendor"…); anything else a prospect.
function accountKind(v) {
  const s = norm(v);
  if (/partner|referr|resell|channel/.test(s)) return 'partner';
  if (/customer|client/.test(s)) return 'customer';
  if (/supplier|vendor/.test(s)) return 'supplier';
  return 'prospect';
}
// A lifecycle from its key, its label, or the usual CRM wording (HubSpot's lifecycle stages and lead statuses).
function lifecycleOf(v) {
  const s = norm(v);
  const named = Object.entries(LIFECYCLES).find(([k, l]) => s === k || s === norm(l) || s === k.replace('_', ' '));
  if (named) return named[0];
  return (/suppress|unsubscrib|do not contact|bounced/.test(s) && 'suppressed')
    || (/nurtur/.test(s) && 'nurture') || (/rfp|tender/.test(s) && 'rfp')
    || (/not now|not interested|declin|later|bad timing/.test(s) && 'not_now')
    || (/customer|client|\bwon\b/.test(s) && 'customer') || (/opportun|\bsql\b/.test(s) && 'opportunity')
    || (/meeting|booked/.test(s) && 'meeting') || (/engag|replied|interested|\bmql\b|connected/.test(s) && 'engaged')
    || (/contacted|emailed|attempt|in progress|open/.test(s) && 'contacted') || 'new';
}
// A buying role from an export's wording; '' when blank, Other when it's something else.
function roleOf(v) {
  const s = norm(v);
  if (!s) return '';
  return (/decision|economic|budget|sign/.test(s) && 'decision_maker') || (/champion|sponsor/.test(s) && 'champion')
    || (/influenc|technical|evaluat/.test(s) && 'influencer') || (/gatekeep|blocker/.test(s) && 'gatekeeper')
    || (/assistant|\bpa\b|\bea\b|secretary/.test(s) && 'assistant') || (/\buser/.test(s) && 'user') || 'other';
}
// An IANA time zone as written ("Australia/Brisbane"), else ''.
function zoneOf(v) {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z]+\/[A-Za-z_+\-/]+$/.test(s)) return '';
  try { new Intl.DateTimeFormat('en-AU', { timeZone: s }); return s; } catch { return ''; }
}

// Outreach stages are free text; the usual ones are tidied, others kept as written.
function contactStage(v) {
  const s = norm(v);
  if (!s || /opportun|lead|prospect|\bnew\b/.test(s)) return 'Opportunity';
  if (/won|client|customer|signed/.test(s)) return 'Won';
  if (/demo|proposal|pilot|trial/.test(s)) return 'Demo';
  if (/meeting|call|discovery/.test(s)) return 'First meeting';
  return String(v).trim();
}

// A status name as written, else negated wording first: "Not contacted" / "Unsent" weren't sent; "Awaiting reply" /
// "Not opened" were; "Meeting not booked" / "Cancelled meeting" aren't a booking.
function contactStatus(v) {
  const s = norm(v);
  const exact = exactly(s, Object.keys(CONTACT_STATUSES));
  if (exact) return exact;
  if (/\b(no|not|un) ?(reply|replied|response|responded|answered)|bounce/.test(s)) return 'No reply';
  if (/\b(no|not|never|un) ?(yet )?(sent|contacted|emailed|delivered)/.test(s)) return 'New';
  if (/\b(no|not|never|un) ?(yet )?(opened|clicked)|\bawait|\bwaiting|\b(repl|respon)\w* (pending|due)/.test(s)) return 'Sent';
  if (/meeting|\bbooked\b/.test(s) && !/\b(no|not|never)\b|\bun ?booked|cancel/.test(s)) return 'Meeting booked';
  if (/repl|respond|response|answered/.test(s)) return 'Replied';
  if (/open|clicked/.test(s)) return 'Opened';
  if (/sent|contacted|emailed|delivered/.test(s)) return 'Sent';
  return 'New';
}

function taskStatus(v) {
  const s = norm(v);
  return exactly(s, Object.keys(STATUS))
    || (/not started|not done|incomplete|to ?do|backlog|\bnew\b|\bopen\b/.test(s) && 'Not started')
    || (/done|complete|finished|closed|shipped/.test(s) && 'Done')
    || (/stuck|block|hold|waiting/.test(s) && 'Stuck')
    || (/progress|doing|working|started|active|review/.test(s) && 'In progress')
    || 'Not started';
}

function taskPriority(v) {
  const s = norm(v).replace(/\s/g, '');
  if (!s) return '';
  return exactly(s, Object.keys(PRIORITY))
    || (NOT_PRIORITY.test(norm(v)) && 'Medium')
    || (/urgent|critical|asap|^p?0$/.test(s) && 'Urgent')
    || (/^p?1$|high/.test(s) && 'High')
    || (/^p?3$|low/.test(s) && 'Low')
    || 'Medium';
}

const LABEL_WORDS = { y: 'Yes', true: 'Yes', approved: 'Yes', n: 'No', false: 'No', rejected: 'No', declined: 'No', waiting: 'Pending' };
// A board label: the option with the same name (or a close one), else blank.
function label(v, options) {
  const s = norm(v);
  if (!s) return '';
  const keys = Object.keys(options);
  return exactly(s, keys)
    || (keys.includes(LABEL_WORDS[s]) && LABEL_WORDS[s])
    || (s.length > 2 && keys.find((k) => norm(k).startsWith(s) || s.startsWith(norm(k))))
    || '';
}

const AVATARS = ['#3b82f6', '#6366f1', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6'];
const avatarFor = (name) => AVATARS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATARS.length];

// ── Rows → records ───────────────────────────────────────────────────────────

/**
 * One CSV row (array of cells) → a state-shaped record without ids, or null when it has no name.
 * `me` (the importer) writes the imported note and owns clients and deals whose owner doesn't match anyone.
 * Tasks get everyone their people cell names in `values.people` (none when nobody matches). `board` is the
 * target board's module for tasks (a BOARD_MODULES entry).
 */
export function normalise(kind, row, mapping, { users = [], me = '', board, now = new Date() } = {}) {
  const get = (key) => {
    const i = mapping?.[key];
    return Number.isInteger(i) && i >= 0 ? String(row?.[i] ?? '').trim() : '';
  };
  const name = get('name').replace(/\s+/g, ' ');
  if (!name) return null;
  const created = toIso(get('created'));
  const note = () => {
    const text = get('notes');
    return text ? [{ user: me, text, ts: created || now.toISOString() }] : [];
  };
  const owner = (key) => people(get(key)).map((p) => matchUser(p, users)).find(Boolean) || '';

  switch (kind) {
    case 'clients': {
      const status = clientStatus(get('status'));
      const contact = owner('contact') || me;
      // The key contact, email and phone make the client's first contact, who gets the invoices.
      const person = { name: get('keyContact').replace(/\s+/g, ' '), role: '', email: emailOf(get('email')), phone: get('phone'), billing: true };
      return {
        name, group: status === 'Onboarding' ? 'Onboarding' : 'Active', status, priority: priority(get('priority'), false),
        next: get('next'), sector: get('sector'), contact, team: [...new Set([contact, ...matchUsers(get('team'), users)].filter(Boolean))],
        lastContact: toYmd(get('lastContact')), demo: get('demo'), demoUrl: get('demoUrl'), platformUrl: get('platformUrl'),
        contacts: person.name || person.email || person.phone ? [person] : [],
        avatar: avatarFor(name), abn: get('abn'), billingAddress: get('billingAddress'),
        notes: note(), tasks: [], invoices: [], access: [],
      };
    }
    case 'contacts':
      return {
        name, org: get('org'), email: emailOf(get('email')), stage: contactStage(get('stage')), status: contactStatus(get('status')),
        last: toIso(get('last')) || created || now.toISOString(),
      };
    case 'deals': {
      const currency = get('currency').toUpperCase();
      return {
        name, sector: get('sector'), value: parseMoney(get('value')), priority: priority(get('priority'), true),
        stage: dealStage(get('stage')), contact: owner('contact') || me, next: get('next'),
        currency: CURRENCIES.includes(currency) ? currency : 'AUD', closeOn: toYmd(get('closeOn')), account: get('account').replace(/\s+/g, ' '),
      };
    }
    case 'accounts':
      return {
        name, kind: accountKind(get('kind')), lifecycle: lifecycleOf(get('lifecycle')), sector: get('sector'), country: get('country'),
        region: get('region'), timezone: zoneOf(get('timezone')), website: get('website'), size: get('size'), contact: owner('contact') || me,
        guardrails: get('guardrails'), notes: get('notes'),
      };
    case 'people':
      return {
        name, account: get('account').replace(/\s+/g, ' '), title: get('title'), email: emailOf(get('email')), phone: get('phone'),
        linkedin: get('linkedin'), role: roleOf(get('role')), timezone: zoneOf(get('timezone')), contact: owner('contact') || me,
      };
    case 'leads':
      return {
        name, title: get('title'), email: emailOf(get('email')), company: get('company').replace(/\s+/g, ' '), phone: get('phone'),
        linkedin: get('linkedin'), domain: get('domain'), sector: get('sector'), country: get('country'), region: get('region'),
        timezone: zoneOf(get('timezone')), size: get('size'), owner: owner('contact') || me, note: get('notes'),
      };
    case 'tasks': {
      const status = taskStatus(get('status'));
      const values = { people: matchUsers(get('people'), users), status };
      const cols = BOARD_SCHEMAS[board]?.columns || [{ key: 'priority', type: 'label', options: PRIORITY }, { key: 'due', type: 'date' }];
      cols.forEach((c) => {
        // No Client, Deal, Also on or Department to import (a task lands in its board's department).
        if (c.key === 'people' || c.key === 'status' || ['owner', 'people', 'also', 'status', 'client', 'deal', 'department'].includes(c.type)) return;
        if (c.key === 'priority') values.priority = taskPriority(get('priority'));
        else if (c.type === 'date') values[c.key] = toYmd(get(c.key));
        else if (c.type === 'label') values[c.key] = label(get(c.key), c.options);
        else values[c.key] = get(c.key);
      });
      return { name, values, done: status === 'Done', updates: note(), subtasks: [] };
    }
    default:
      return null;
  }
}
