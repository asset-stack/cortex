// Board schemas: column definitions and label colours for the Monday-style boards.
// Column types: person | status | label | date | text

export const STATUS = {
  'Not started': '#9aa3b5',
  'In progress': '#fdab3d',
  Stuck: '#e2445c',
  Done: '#00c875',
};

export const PRIORITY = { High: '#e2445c', Medium: '#fdab3d', Low: '#579bfc' };

export const BOARD_SCHEMAS = {
  projects: {
    title: 'Projects',
    icon: 'FolderKanban',
    columns: [
      { key: 'owner', label: 'Owner', type: 'person' },
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      { key: 'priority', label: 'Priority', type: 'label', options: PRIORITY },
      { key: 'due', label: 'Due', type: 'date' },
    ],
  },
  admin: {
    title: 'Admin',
    icon: 'ClipboardList',
    columns: [
      { key: 'owner', label: 'Owner', type: 'person' },
      { key: 'status', label: 'Status', type: 'status', options: STATUS },
      { key: 'priority', label: 'Priority', type: 'label', options: PRIORITY },
      { key: 'due', label: 'Due', type: 'date' },
    ],
  },
  marketing: {
    title: 'Marketing',
    icon: 'Megaphone',
    columns: [
      { key: 'owner', label: 'Owner', type: 'person' },
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
};

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
export const INVOICE_STATUS = { Draft: '#9aa3b5', Sent: '#579bfc', Paid: '#00c875', Overdue: '#e2445c' };
export const GST_RATE = 0.1;
// Printed on invoices. Fill in the ABN before sending tax invoices; without one the print says "Invoice".
export const SUPPLIER = { name: 'AssetStack', abn: '' };
