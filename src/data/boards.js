// Board schemas: column definitions and label colours for the Monday-style boards, plus the other label sets.
// Column types: people | status | label | date | text

export const STATUS = {
  'Not started': '#9aa3b5',
  'In progress': '#fdab3d',
  Stuck: '#e2445c',
  Done: '#00c875',
};

export const PRIORITY = { High: '#e2445c', Medium: '#fdab3d', Low: '#579bfc' };

// Projects (with the former Admin board merged in) and Marketing. Both are modules in src/lib/access.js.
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
};

// Item values with `people` as a clean list of user ids (the people column). Phase 1's single `owner` becomes
// people, as the 0002 migration does in the database.
export function withPeople(values) {
  const { owner, ...rest } = values && typeof values === 'object' ? values : {};
  const list = Array.isArray(rest.people) ? rest.people : [];
  return { ...rest, people: [...new Set([owner, ...list].filter(Boolean).map(String))] };
}

export const DEAL_STAGES = ['Opportunities', 'First meetings', 'Demos', 'Won'];
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
