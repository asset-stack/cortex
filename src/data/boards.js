// Board schemas: column definitions and label colours for the Monday-style boards, plus the other label sets.
// Column types: people | status | label | date | text

export const STATUS = {
  'Not started': '#9aa3b5',
  'In progress': '#fdab3d',
  Stuck: '#e2445c',
  Done: '#00c875',
};

export const PRIORITY = { High: '#e2445c', Medium: '#fdab3d', Low: '#579bfc' };

// The board modules' columns (BOARD_MODULES): Projects (with the former Admin board merged in), Marketing, Outreach and
// Clients. All are modules in src/lib/access.js.
export const BOARD_SCHEMAS = {
  projects: {
    title: 'Projects',
    icon: 'FolderKanban',
    columns: [
      { key: 'people', label: 'People', type: 'people' },
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      { key: 'priority', label: 'Priority', type: 'label', options: PRIORITY },
      { key: 'due', label: 'Due', type: 'date' },
    ],
  },
  marketing: {
    title: 'Marketing',
    icon: 'Megaphone',
    columns: [
      { key: 'people', label: 'People', type: 'people' },
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
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
    ],
  },
  // Outreach's boards (Sales Tasks …) and Clients' (Demos, Previews …) have the standard task columns, as Projects.
  outreach: {
    title: 'Outreach',
    icon: 'Mail',
    columns: [
      { key: 'people', label: 'People', type: 'people' },
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      { key: 'priority', label: 'Priority', type: 'label', options: PRIORITY },
      { key: 'due', label: 'Due', type: 'date' },
    ],
  },
  clients: {
    title: 'Clients',
    icon: 'Building2',
    columns: [
      { key: 'people', label: 'People', type: 'people' },
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      { key: 'priority', label: 'Priority', type: 'label', options: PRIORITY },
      { key: 'due', label: 'Due', type: 'date' },
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
    ],
  },
};
// What a board's rows are called ("Task", or "Client" on Work in Progress), and whether it has dates (the calendar).
export const itemWord = (schema) => schema?.item || 'Task';
export const hasDates = (schema) => (schema?.columns || []).some((c) => c.type === 'date');

// Item values with `people` as a clean list of user ids (the people column). Phase 1's single `owner` becomes
// people, as the 0002 migration does in the database.
export function withPeople(values) {
  const { owner, ...rest } = values && typeof values === 'object' ? values : {};
  const list = Array.isArray(rest.people) ? rest.people : [];
  return { ...rest, people: [...new Set([owner, ...list].filter(Boolean).map(String))] };
}

// Pipeline's columns, in order (0008). A deal made a client leaves the board (it lives in Clients); there's no Won.
export const DEAL_STAGES = ['Opportunities', 'Contacted', 'First meetings', 'Demos'];
export const DEAL_PRIORITIES = ['P1', 'P2', 'P3'];
/** The column a deal shows in: its stage, or for a stage the board no longer has, Demos for the old Won (0008 moves
 *  those in the database; an old browser tab may still write one) and Opportunities for anything else. */
export const dealStage = (deal) => (DEAL_STAGES.includes(deal?.stage) ? deal.stage : deal?.stage === 'Won' ? 'Demos' : 'Opportunities');

/** A deal's edited fields, cleaned (Pipeline's Edit deal): text trimmed, a value of 0 or more, a known priority and
 *  stage, and an owner among `userIds` ('' for none). Fields that aren't valid are left out, so the deal keeps them. */
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
