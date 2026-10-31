// Board schemas: column definitions and label colours for the Monday-style boards, plus the other label sets.
// Column types: owner (one person) | people | also | client | deal | department | status | label | date | text. `owner`
// and `people` are both kept in `values.people` (user ids): an owner column holds one, so a task has one person
// answerable for it (docs/PHASE2.md §17). `also` (Also on, §20) holds the other people on it in `values.also`: they see it
// in their task lists, but it isn't theirs to answer for. `client` holds a client id in `values.client`, `deal` a deal id
// in `values.deal` (a next step on a deal's profile, §19), `department` a board module in `values.department` ('' = the
// board's own: departmentOf() in src/lib/boards.js). `team`: a column only team boards have (not personal pages).

export const STATUS = {
  'Not started': '#9aa3b5',
  'In progress': '#fdab3d',
  Stuck: '#e2445c',
  Done: '#00c875',
};

// Task priority, most pressing first (Sort and My Work → Priorities follow this order), and what each one means: the
// label picker shows the meaning under each option.
export const PRIORITY = { Urgent: '#e2445c', High: '#fdab3d', Medium: '#579bfc', Low: '#7d8fa3' };
export const PRIORITY_HINTS = { Urgent: 'Today: drop other work. One at a time.', High: 'This week', Medium: 'This month', Low: 'When free' };
const OWNER = { key: 'people', label: 'Owner', type: 'owner' };
const ALSO = { key: 'also', label: 'Also on', type: 'also', team: true };
const PRIORITY_COLUMN = { key: 'priority', label: 'Priority', type: 'label', options: PRIORITY, hints: PRIORITY_HINTS };
// Which department a task belongs to (§20): Operations, Marketing, Outreach, Clients or Pipeline. Last on every team board.
const DEPARTMENT = { key: 'department', label: 'Department', type: 'department', team: true };
// The deal a task is a next step for (§19, §22): first on Outreach's boards, after Department on Operations' team boards.
const DEAL = { key: 'deal', label: 'Deal', type: 'deal' };

// The board modules' columns (BOARD_MODULES): Projects (with the former Admin board merged in), Marketing, Outreach and
// Clients. All are modules in src/lib/access.js.
export const BOARD_SCHEMAS = {
  projects: {
    title: 'Operations', // shown as Operations since §18; the key stays 'projects'
    icon: 'FolderKanban',
    columns: [
      OWNER,
      ALSO,
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      PRIORITY_COLUMN,
      { key: 'due', label: 'Due', type: 'date' },
      DEPARTMENT,
      // A deal's next steps live here (§22); personal pages don't have it. `sparse`: a table shows it only once a task on
      // the board has one (the drawer always does), so boards that don't use it stay as they were.
      { ...DEAL, team: true, sparse: true },
    ],
  },
  marketing: {
    title: 'Marketing',
    icon: 'Megaphone',
    columns: [
      OWNER,
      ALSO,
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      PRIORITY_COLUMN,
      {
        key: 'type', label: 'Type', type: 'label',
        options: { Industry: '#d9a800', Sponsorship: '#21b8b0', Projects: '#7d8fa3', 'Staff internal': '#ff5ac4' },
      },
      {
        key: 'channel', label: 'Channel', type: 'label',
        options: { LinkedIn: '#0a66c2', Website: '#784bd1', Reviews: '#037f4c', Content: '#ff6b6b' },
      },
      { key: 'approval', label: 'Approval', type: 'label', options: { Yes: '#00c875', No: '#a25ddc', Pending: '#579bfc' } },
      { key: 'due', label: 'Due', type: 'date' },
      DEPARTMENT,
    ],
  },
  // Outreach's boards (Sales Tasks …) have the standard task columns, as Projects, and say which deal a task is for (a
  // next step on its profile, as Operations' can); Clients' (Demos, Previews …) say which client.
  outreach: {
    title: 'Outreach',
    icon: 'Mail',
    columns: [
      DEAL,
      OWNER,
      ALSO,
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      PRIORITY_COLUMN,
      { key: 'due', label: 'Due', type: 'date' },
      DEPARTMENT,
    ],
  },
  clients: {
    title: 'Clients',
    icon: 'Building2',
    columns: [
      { key: 'client', label: 'Client', type: 'client' },
      OWNER,
      ALSO,
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      PRIORITY_COLUMN,
      { key: 'due', label: 'Due', type: 'date' },
      DEPARTMENT,
    ],
  },
  // Work in Progress, under the deals on the Pipeline page: a row per client (`item`: what a row is called), its
  // details, status and contact (the team member on it; `people`, so it shows in their My Work).
  pipeline: {
    title: 'Pipeline',
    icon: 'GitBranch',
    item: 'Client',
    columns: [
      { key: 'details', label: 'Details', type: 'text' },
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      { key: 'people', label: 'Contact', type: 'people' },
      DEPARTMENT,
    ],
  },
};
// A board's schema: its module's, less the `team` columns (Also on, Department) on a personal page (`owner` set: notes
// nobody else is on, all in Operations). The same object every time, so it can be compared and memoised.
const PERSONAL = Object.fromEntries(Object.entries(BOARD_SCHEMAS)
  .map(([m, s]) => [m, { ...s, columns: s.columns.filter((c) => !c.team) }]));
export const schemaOf = (board) => (board?.owner ? PERSONAL : BOARD_SCHEMAS)[board?.module];
// What a board's rows are called ("Task", or "Client" on Work in Progress), and whether it has dates (the calendar).
export const itemWord = (schema) => schema?.item || 'Task';
export const hasDates = (schema) => (schema?.columns || []).some((c) => c.type === 'date');

// Item values with `people` as a clean list of user ids (the owner or people column). Phase 1's single `owner` becomes
// people, as the 0002 migration does in the database.
export function withPeople(values) {
  const { owner, ...rest } = values && typeof values === 'object' ? values : {};
  const list = Array.isArray(rest.people) ? rest.people : [];
  return { ...rest, people: [...new Set([owner, ...list].filter(Boolean).map(String))] };
}

// Pipeline's columns, in order (0008, Proposal sent §21). A deal made a client leaves the board (it lives in Clients);
// there's no Won: Make client sits on the last column.
export const DEAL_STAGES = ['Opportunities', 'Contacted', 'First meetings', 'Demos', 'Proposal sent'];
export const DEAL_PRIORITIES = ['P1', 'P2', 'P3'];
/** The column a deal shows in: its stage, or for a stage the board no longer has, the last column for the old Won (an
 *  old browser tab may still write one) and Opportunities for anything else. */
export const dealStage = (deal) => (DEAL_STAGES.includes(deal?.stage) ? deal.stage
  : deal?.stage === 'Won' ? DEAL_STAGES[DEAL_STAGES.length - 1] : 'Opportunities');

// A deal's or client's Lead (0013, §21): the work came through LYCO (co-pitched) or is AssetStack's own. '' = not set.
// `edge` colours a deal's block; the icon is src/components/LeadIcon.jsx.
export const LEADS = {
  lyco: { label: 'LYCO', title: 'LYCO lead · co-pitched', edge: '#22e36b' },
  assetstack: { label: 'AssetStack', title: 'AssetStack direct', edge: '#2337ee' },
};
export const isLead = (v) => typeof v === 'string' && Object.hasOwn(LEADS, v);
export const leadOf = (x) => (isLead(x?.source) ? x.source : '');

/** A deal's edited fields, cleaned (Pipeline's Edit deal): text trimmed, a value of 0 or more, a known priority,
 *  stage and Lead, and an owner among `userIds` ('' for none). Fields that aren't valid are left out, so the deal keeps them. */
export function cleanDealPatch(patch = {}, userIds = []) {
  const text = (v) => String(v ?? '').trim();
  const out = {};
  if ('name' in patch && text(patch.name)) out.name = text(patch.name);
  if ('sector' in patch) out.sector = text(patch.sector);
  if ('next' in patch) out.next = text(patch.next);
  if ('value' in patch && patch.value !== '' && patch.value !== null && Number.isFinite(Number(patch.value)) && Number(patch.value) >= 0) {
    out.value = Number(patch.value);
  }
  if ('priority' in patch && DEAL_PRIORITIES.includes(patch.priority)) out.priority = patch.priority;
  if ('stage' in patch && DEAL_STAGES.includes(patch.stage)) out.stage = patch.stage;
  if ('source' in patch && (patch.source === '' || isLead(patch.source))) out.source = patch.source;
  if ('contact' in patch) out.contact = userIds.includes(patch.contact) ? patch.contact : '';
  return out;
}
export const CLIENT_STATUSES = {
  Onboarding: '#f5a623',
  Active: '#1fbf86',
  'Proposal sent': '#ff5c7a',
  Passive: '#579bfc',
};
export const CLIENT_GROUPS = [
  { key: 'Onboarding', label: 'Onboarding', dot: '#c4a5ff' },
  { key: 'Active', label: 'Active', dot: '#5ef0b0' },
];

// Outreach contact statuses, in pipeline order. Replied and Meeting booked create or advance a deal.
export const CONTACT_STATUSES = {
  New: '#9aa3b5',
  Sent: '#579bfc',
  Opened: '#a78bfa',
  Replied: '#00c875',
  'Meeting booked': '#21b8b0',
  'No reply': '#7d8fa3',
};

// Billing plans create invoices Awaiting approval; only admins approve, send, void or mark paid.
export const INVOICE_STATUS = {
  Draft: '#9aa3b5',
  'Awaiting approval': '#fdab3d',
  Approved: '#a25ddc',
  Sent: '#579bfc',
  Paid: '#00c875',
  Overdue: '#e2445c',
  Void: '#5c6370',
};

// Work categories for to-dos, routines and timesheets (label → colour).
export const CATEGORIES = {
  'Email marketing': '#ff6b6b',
  LinkedIn: '#0a66c2',
  Demos: '#784bd1',
  Meetings: '#21b8b0',
  Outreach: '#fdab3d',
  Projects: '#579bfc',
  Marketing: '#ff5ac4',
  Clients: '#00c875',
  Admin: '#d9a800',
  Other: '#9aa3b5',
};

export const PLAN_FREQUENCIES = { monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually' };
export const SUBSCRIPTION_CYCLES = { monthly: 'Monthly', annually: 'Annually' };
export const EXPENSE_CATEGORIES = ['Software', 'Hosting', 'Travel', 'Marketing', 'Office', 'Contractors', 'Fees', 'Other'];

export const GST_RATE = 0.1;
