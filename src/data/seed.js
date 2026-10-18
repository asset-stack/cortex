// Example data shaped on the Client Tracker, the monday.com Posting Schedule and the
// master-layout whiteboard. Demo mode only: live mode starts from what is in Supabase.
// The repo is public: organisations, people, invoices, payments and amounts are fictional and emails are
// placeholders (example.com). Never put real client names, ABNs, bank or contact details in this file.
// Relative imports with extensions, so scripts/test-sync.mjs can load this file in Node.
import {
  addDays, addMonths, contactPipelineLocal, ensureTodosLocal, generateDueInvoicesLocal, isoDow, makeTodo, uid,
} from '../lib/automations.js';
import { TEAM_TIMEZONE, localYmd } from '../lib/format.js';
import { withPeople } from './boards.js';
import { TOOL_PRESETS } from '../lib/tools.js';
import { BOARD_MODULES, EXISTING_BOARD, FIRST_GROUP, FIRST_GROUP_COLOR, STARTING_BOARDS } from '../lib/boards.js';

let n = 0;
const id = (p) => `${p}_${(++n).toString(36)}`;
let now = Date.now(); // refreshed by createSeed, so Reset gives fresh relative times
const hoursAgo = (h) => new Date(now - h * 3600e3).toISOString();

const person = (id, name, initials, color, role, timezone) => ({ id, name, initials, color, email: `${id}@example.com`, role, active: true, timezone });

// SuperAdmin, Admin and Staff (the ops mailbox). Real names and emails live only in the database.
export const USERS = [
  person('david', 'David', 'DV', '#9cd326', 'superadmin', TEAM_TIMEZONE),
  person('josh', 'Josh', 'JS', '#579bfc', 'admin', 'Asia/Tbilisi'),
  person('hello', 'Hello', 'HE', '#a78bfa', 'staff', 'Asia/Manila'),
];

// Business details for invoices. Left blank in the demo: the real ones are entered in Settings.
export const ORG = {
  businessName: 'AssetStack', abn: '', address: '', email: '', phone: '', bankAccountName: '', bsb: '', accountNumber: '',
  paymentTermsDays: 30, invoicePrefix: 'INV-', contractTemplate: '', contractFolder: '',
};

const item = (name, values, extra = {}) => ({
  id: id('it'), name, values, updates: [], subtasks: [], done: values.status === 'Done', ...extra,
});

// Projects: everyone's own page, then the team boards; Marketing: its team boards (docs/PHASE2.md §11).
const board = (module, name, groups, owner = '') => ({ id: id('b'), module, name: owner ? '' : name, owner, groups });
const group = (name, color, items) => ({ id: id('g'), name, color, items });

function boards() {
  return [
    board('projects', '', [
      group('Active', '#c9ffe6', [
        item('Investor update', { people: ['david'], status: 'In progress', priority: 'High', due: '2026-10-28' }),
        item('AssetStack Academy outline', { people: ['david'], status: 'Not started', priority: 'Low', due: '' }),
      ]),
    ], 'david'),
    board('projects', '', [
      group('Active', '#c9ffe6', [
        item('Partner pricing sheet', { people: ['josh'], status: 'In progress', priority: 'Medium', due: '2026-10-24' }),
      ]),
    ], 'josh'),
    board('projects', '', [
      group('Active', '#c9ffe6', [
        item('Order merchandise samples', { people: ['hello'], status: 'In progress', priority: 'Low', due: '2026-10-21' }),
        item('Tidy the shared drive', { people: ['hello'], status: 'Not started', priority: 'Low', due: '' }),
      ]),
    ], 'hello'),
    board('projects', 'Landing Page', [
      group('Active', '#c9ffe6', [
        item('Hero copy refresh', { people: ['hello', 'david'], status: 'In progress', priority: 'High', due: '2026-10-23' },
          { updates: [{ id: id('u'), user: 'hello', text: 'First draft is in the doc. @David can you check the headline?', ts: hoursAgo(8) }] }),
        item('Council case study section', { people: ['david'], status: 'Not started', priority: 'Medium', due: '2026-11-06' }),
        item('Page speed audit', { people: ['josh'], status: 'Not started', priority: 'Low', due: '2026-11-13' }),
      ]),
      group('Backlog', '#e6eaf2', [
        item('Pricing page', { people: [], status: 'Not started', priority: 'Low', due: '' }),
      ]),
    ]),
    board('projects', 'Tender Portal', [
      group('Active', '#c9ffe6', [
        item('Free Tender Portal', { people: ['david', 'hello'], status: 'In progress', priority: 'High', due: '2026-11-15' },
          { subtasks: [{ id: id('s'), text: 'Supplier sign-up flow', done: true }, { id: id('s'), text: 'Tender alert emails', done: false }] }),
        item('Tender alert emails', { people: ['josh'], status: 'Not started', priority: 'Medium', due: '2026-11-20' }),
      ]),
    ]),
    board('projects', 'General', [
      group('Active', '#c9ffe6', [
        item('Register NFP', { people: ['josh'], status: 'In progress', priority: 'High', due: '2026-10-30' },
          { subtasks: [{ id: id('s'), text: 'Draft constitution', done: true }, { id: id('s'), text: 'Lodge with the regulator', done: false }] }),
      ]),
      group('Backlog', '#e6eaf2', [
        item('AssetStack Academy', { people: ['hello'], status: 'Not started', priority: 'Low', due: '' }),
      ]),
      // The former Admin board.
      group('Admin', '#ffe6b0', [
        item('Merchandise', { people: ['hello'], status: 'In progress', priority: 'Low', due: '2026-10-18' }),
        item('Trademark', { people: ['josh'], status: 'Stuck', priority: 'High', due: '2026-10-22' },
          { updates: [{ id: id('u'), user: 'josh', text: 'Waiting on the examiner response.', ts: hoursAgo(30) }] }),
        item('Insurance renewal', { people: ['josh', 'hello'], status: 'In progress', priority: 'High', due: '2026-10-31' }),
        item('Set up office phones', { people: ['hello'], status: 'Not started', priority: 'Medium', due: '2026-11-08' }),
        item('Outsource time logger', { people: ['david'], status: 'Done', priority: 'Low', due: '2026-10-09' }),
      ]),
    ]),
    board('marketing', 'Daily Automation', [
      group('Every day', '#bfe9ff', [
        item('Morning LinkedIn post', { people: ['hello'], status: 'In progress', type: 'Industry', channel: 'LinkedIn', approval: 'Yes', due: '' }),
        item('Engage with 10 council posts', { people: ['hello'], status: 'In progress', type: 'Industry', channel: 'LinkedIn', approval: '', due: '' }),
        item('Answer new reviews', { people: ['david'], status: 'Not started', type: 'Industry', channel: 'Reviews', approval: '', due: '' }),
      ]),
    ]),
    board('marketing', 'Posting schedule', [
      group('October', '#bfe9ff', [
        item('LinkedIn weekly engagement', { people: ['hello'], status: 'In progress', type: 'Industry', channel: 'LinkedIn', approval: '', due: '2026-10-31' }),
        item('Golf Day promotion', { people: [], status: 'In progress', type: 'Sponsorship', channel: 'LinkedIn', approval: '', due: '2026-10-12' }),
        item('Team on site', { people: ['david'], status: 'In progress', type: 'Industry', channel: 'LinkedIn', approval: 'No', due: '2026-10-15' }),
        item('Golf Day content', { people: ['hello'], status: 'In progress', type: 'Industry', channel: 'Content', approval: '', due: '2026-10-16' }),
        item('Bridge project spotlight', { people: ['david'], status: 'Not started', type: 'Projects', channel: 'Website', approval: '', due: '2026-10-20' }),
        item('Monthly award', { people: ['josh'], status: 'Stuck', type: 'Staff internal', channel: 'LinkedIn', approval: 'No', due: '2026-10-28' }),
        item('Sponsorship announcement', { people: ['david', 'hello'], status: 'In progress', type: 'Sponsorship', channel: 'LinkedIn', approval: 'Yes', due: '2026-10-24' }),
      ]),
      group('November', '#ead9ff', [
        item('LinkedIn weekly engagement', { people: [], status: 'Not started', type: 'Projects', channel: 'LinkedIn', approval: '', due: '2026-11-30' }),
        item('Westbay case study', { people: ['hello', 'david'], status: 'Not started', type: 'Projects', channel: 'Website', approval: 'Pending', due: '2026-11-14' },
          { updates: [{ id: id('u'), user: 'david', text: '@Hello can you add the October usage numbers?', ts: hoursAgo(5) }] }),
        item('G2 + Google reviews', { people: ['david'], status: 'Not started', type: 'Industry', channel: 'Reviews', approval: '', due: '2026-11-21' }),
        item('Council landing page', { people: ['hello'], status: 'Not started', type: 'Projects', channel: 'Content', approval: '', due: '2026-11-25' }),
      ]),
    ]),
    board('marketing', 'Campaigns', [
      group('This quarter', '#ead9ff', [
        item('Council digital twin campaign', { people: ['david', 'hello'], status: 'In progress', type: 'Projects', channel: 'LinkedIn', approval: 'Pending', due: '2026-11-28' }),
        item('Utilities email campaign', { people: ['josh'], status: 'Not started', type: 'Industry', channel: 'Content', approval: '', due: '2026-12-05' }),
      ]),
    ]),
    board('marketing', 'Events', [
      group('Upcoming', '#ffe6b0', [
        item('Golf Day', { people: ['hello', 'josh'], status: 'In progress', type: 'Sponsorship', channel: 'LinkedIn', approval: 'Yes', due: '2026-10-12' }),
        item('Local government conference stand', { people: ['david'], status: 'Not started', type: 'Industry', channel: 'Website', approval: '', due: '2026-11-19' }),
      ]),
    ]),
  ];
}

// `contact` is the deal owner's user id; `contactId` the outreach contact it came from.
const deal = (name, sector, value, priority, stage, contact, next, contactId = '') => ({
  id: id('d'), name, sector, value, priority, stage, contact, next, contactId,
});

const invoice = (number, issued, due, status, desc, rate, extra = {}) => ({
  id: id('i'), number, issued, due, status, planId: '', sentAt: '', paidOn: '', sentTo: '',
  lines: [{ id: id('l'), desc, qty: 1, rate }], ...extra,
});
const plan = (description, amount, frequency, nextDate, active = true) => ({
  id: id('bp'), description, amount, frequency, nextDate, anchorDay: nextDate ? Number(nextDate.slice(8, 10)) : 0, active,
});
const usage = (month, assets, sites, seats, credits = 0, notes = '') => ({ id: id('cu'), month, assets, sites, seats, credits, notes });
// A client's own people (client.contacts): invoices go to those marked billing.
const clientPerson = (name, role, email, billing = false, phone = '') => ({ id: id('pc'), name, role, email, phone, billing });
const contract = (fields) => ({
  id: id('k'), status: 'Draft', title: 'Software Subscription Agreement', docId: '', docUrl: '', startDate: '', endDate: '',
  annualFee: 0, paymentTerms: 'Invoiced annually in advance, payable within 14 days', userLimit: '1 master user & unlimited view only',
  platform: 'AssetStack - Property Management', customisations: 'Ten per 12-month period (clause 6)', mobileApp: 'Included',
  governingLaw: 'New South Wales', createdBy: 'david', sentBy: '', sentAt: '', signedAt: '', ...fields,
});

function clients(today) {
  const thisMonth = `${today.slice(0, 7)}-01`;
  // Westbay's licence is due on the 1st: createSeed runs generateDueInvoicesLocal, which bills this month.
  const westbayPlan = plan('Platform licence (monthly)', 2400, 'monthly', thisMonth);
  const harbourPlan = plan('Pilot licence (quarterly)', 7250, 'quarterly', addMonths(thisMonth, 2));
  return [
    {
      id: id('c'), name: 'Westbay Council', group: 'Onboarding', status: 'Onboarding', priority: 'P1',
      next: 'David to finalise onboarding meeting', sector: 'Government', contact: 'josh', team: ['josh', 'david'],
      lastContact: '2026-05-19', demo: 'Live site with client', demoUrl: 'https://demo.example.com',
      platformUrl: 'https://westbay.example.com', avatar: '#3b82f6', abn: '', billingAddress: '',
      contacts: [
        clientPerson('Alex Taylor', 'Asset manager', 'alex.taylor@example.com', false, '0400 000 001'),
        clientPerson('Accounts payable', 'Finance', 'accounts.westbay@example.com', true),
      ],
      contracts: [contract({
        status: 'Sent for signature', startDate: '2026-11-01', endDate: '2027-10-31', annualFee: 28800, platform: 'AssetStack - Asset Management',
        paymentTerms: 'Invoiced monthly in advance, payable within 30 days', sentBy: 'josh', sentAt: hoursAgo(30),
      })],
      notes: [
        { id: id('n'), user: 'david', text: 'Kick-off went well. Alex wants the asset register imported before training.', ts: hoursAgo(72) },
        { id: id('n'), user: 'josh', text: 'Sent the capability statement and onboarding plan.', ts: hoursAgo(120) },
        { id: id('n'), user: 'hello', text: 'Data template shared with their GIS team.', ts: hoursAgo(200) },
      ],
      tasks: [{ id: id('t'), text: 'Book onboarding meeting', done: false }, { id: id('t'), text: 'Import asset register', done: false }],
      invoices: [
        invoice('INV-1017', '2026-10-08', '2026-11-07', 'Sent', 'Onboarding – Phase 1', 18450, { sentAt: '2026-10-08T01:00:00.000Z' }),
        invoice('INV-1012', '2026-09-01', '2026-10-01', 'Overdue', 'Asset data capture', 12600, { sentAt: '2026-09-01T01:00:00.000Z' }),
      ],
      access: [
        { id: id('a'), name: 'Alex Taylor', email: 'alex.taylor@example.com', role: 'Client admin' },
        { id: id('a'), name: 'Field team (3 seats)', email: 'field-team@example.com', role: 'Field user' },
        { id: id('a'), name: 'David', email: 'david@example.com', role: 'AssetStack' },
        { id: id('a'), name: 'Josh', email: 'josh@example.com', role: 'AssetStack' },
      ],
      plans: [westbayPlan],
      usage: [
        usage('2026-10-01', 5200, 12, 6, 1840, 'Asset register import'), usage('2026-09-01', 3400, 9, 5, 1210), usage('2026-08-01', 1250, 4, 3, 430),
      ],
    },
    {
      id: id('c'), name: 'Northside Diocese', group: 'Active', status: 'Proposal sent', priority: 'P1',
      next: 'Josh to send scope', sector: 'Healthcare', contact: 'josh', team: ['hello', 'david', 'josh'],
      lastContact: '2026-05-17', demo: 'Demo with client', demoUrl: '', platformUrl: '', avatar: '#6366f1', abn: '', billingAddress: '',
      contacts: [clientPerson('Jordan Price', 'Facilities lead', 'jordan.price@example.com', true)], contracts: [],
      notes: [], tasks: [{ id: id('t'), text: 'Send scope document', done: false }], invoices: [],
      access: [{ id: id('a'), name: 'Jordan Price', email: 'jordan.price@example.com', role: 'Client admin' }, { id: id('a'), name: 'Hello', email: 'hello@example.com', role: 'AssetStack' }],
      plans: [plan('Support retainer (from signing)', 1800, 'monthly', '', false)],
      usage: [],
    },
    {
      id: id('c'), name: 'Coastal Rail', group: 'Active', status: 'Passive', priority: 'P2',
      next: 'Re-send demo link (blocked on their network)', sector: 'Transport', contact: 'hello', team: ['hello'],
      lastContact: '2026-08-11', demo: 'Re-send demo link', demoUrl: '', platformUrl: '', avatar: '#f59e0b', abn: '', billingAddress: '',
      contacts: [clientPerson('Casey Ng', 'Senior engineer', 'casey.ng@example.com', true)], contracts: [],
      notes: [{ id: id('n'), user: 'hello', text: 'Spoke with their senior engineer. Previous demo link would not open on their network.', ts: hoursAgo(1400) }],
      tasks: [], invoices: [], access: [], plans: [], usage: [],
    },
    {
      id: id('c'), name: 'Harbour Construction', group: 'Active', status: 'Active', priority: 'P2',
      next: 'Pilot running on two sites', sector: 'Construction', contact: 'david', team: ['david', 'hello'],
      lastContact: '2026-10-02', demo: 'Pilot', demoUrl: '', platformUrl: 'https://harbour.example.com', avatar: '#ef4444', abn: '', billingAddress: '',
      contacts: [clientPerson('Jamie Park', 'Project director', 'jamie.park@example.com', true)],
      contracts: [contract({
        status: 'Signed', startDate: '2026-07-01', endDate: '2027-06-30', annualFee: 29000, platform: 'AssetStack - Construction',
        paymentTerms: 'Invoiced quarterly in advance, payable within 30 days', createdBy: 'david', sentBy: 'david',
        sentAt: '2026-06-20T01:00:00.000Z', signedAt: '2026-06-24',
      })],
      notes: [], tasks: [],
      invoices: [invoice('INV-1014', '2026-09-12', '2026-10-12', 'Paid', 'Pilot licence (quarterly)', 7250, {
        planId: harbourPlan.id, sentAt: '2026-09-12T01:00:00.000Z', paidOn: '2026-10-06',
      })],
      access: [{ id: id('a'), name: 'Jamie Park', email: 'jamie.park@example.com', role: 'Client admin' }],
      plans: [harbourPlan],
      usage: [usage('2026-10-01', 960, 2, 4, 310), usage('2026-09-01', 820, 2, 4, 280, 'Pilot')],
    },
  ];
}

function chat() {
  const general = id('ch'), sales = id('ch'), marketing = id('ch'), westbay = id('ch');
  return {
    channels: [
      { id: general, name: 'general', members: USERS.map((u) => u.id) },
      { id: sales, name: 'sales', members: ['david', 'josh', 'hello'] },
      { id: marketing, name: 'marketing', members: ['david', 'hello'] },
      { id: westbay, name: 'westbay-onboarding', members: ['david', 'josh'] },
    ],
    messages: [
      { id: id('m'), channel: general, user: 'hello', text: 'Morning all. Golf Day is Monday 12th, shirts arrive Friday.', ts: hoursAgo(26) },
      { id: id('m'), channel: general, user: 'hello', text: '@David can you approve the sponsorship post before lunch?', ts: hoursAgo(3) },
      { id: id('m'), channel: sales, user: 'hello', text: 'Coastal Rail still cannot open the demo link on their network. Trying a PDF walkthrough instead.', ts: hoursAgo(20) },
      { id: id('m'), channel: sales, user: 'josh', text: '@Hello send it through, I will add it to the Diocese scope pack too.', ts: hoursAgo(19) },
      { id: id('m'), channel: sales, user: 'josh', text: 'Bayview Water replied to the utilities sequence. It is in Pipeline now.', ts: hoursAgo(2.5) },
      { id: id('m'), channel: westbay, user: 'josh', text: '@David Alex is free Thursday 10am for the onboarding meeting.', ts: hoursAgo(1.5) },
      { id: id('m'), channel: marketing, user: 'hello', text: 'Case study draft for Westbay is in the Marketing board.', ts: hoursAgo(48) },
    ],
    // Read positions are per viewer: { [userId]: { [channelId]: ts } }.
    lastRead: Object.fromEntries(USERS.map((u) => [u.id, { [general]: hoursAgo(10), [sales]: hoursAgo(1), [marketing]: hoursAgo(1), [westbay]: hoursAgo(5) }])),
  };
}

// Daily marketing routines for the ops role, and a weekly one for the SuperAdmin.
const routines = () => [
  { id: id('r'), title: 'LinkedIn engagement', category: 'LinkedIn', minutes: 60, assignee: 'hello', weekdays: [1, 2, 3, 4, 5], start: '09:00', active: true },
  { id: id('r'), title: 'Company page post', category: 'Marketing', minutes: 30, assignee: 'hello', weekdays: [1, 3, 5], start: '11:00', active: true },
  { id: id('r'), title: 'Check outreach replies', category: 'Outreach', minutes: 15, assignee: 'hello', weekdays: [1, 2, 3, 4, 5], start: '15:00', active: true },
  { id: id('r'), title: 'Pipeline review', category: 'Meetings', minutes: 30, assignee: 'david', weekdays: [1], start: '08:30', active: true },
];

// Outreach (docs/PHASE2.md §12): three outreach mailboxes, two weeks of what the outreach agent logs in its sheet
// (fictional organisations and people), and the team's notes. Deterministic for a given day. `idf(prefix)` makes ids.
const OUTREACH_ORGS = [
  ['Northbrook Shire Council', 'Local government', 'Northbrook VIC'], ['Eastvale City Council', 'Local government', 'Eastvale NSW'],
  ['Riverbend Water', 'Water utility', 'Riverbend QLD'], ['Pinecrest Regional Council', 'Local government', 'Pinecrest WA'],
  ['Harbourside Ports', 'Ports', 'Harbourside SA'], ['Glenmore Shire Council', 'Local government', 'Glenmore TAS'],
  ['Westfield Health District', 'Health', 'Westfield NSW'], ['Lakeside Education Trust', 'Education', 'Lakeside VIC'],
  ['Sunridge City Council', 'Local government', 'Sunridge QLD'], ['Coastline Housing', 'Community housing', 'Coastline NSW'],
  ['Redgum Shire Council', 'Local government', 'Redgum SA'], ['Bayport Transit', 'Transport', 'Bayport VIC'],
];
const OUTREACH_PEOPLE = ['Alex Morgan', 'Sam Rivera', 'Jordan Blake', 'Casey Nguyen', 'Taylor Brooks', 'Morgan Ellis', 'Riley Chen',
  'Jamie Patel', 'Avery Quinn', 'Drew Hartley', 'Robin Shaw', 'Cameron Lee'];
const OUTREACH_ROLES = ['Manager Facilities', 'Asset Manager', 'Director Infrastructure', 'Manager Property', 'Chief Financial Officer'];
const OUTREACH_SIGNALS = ['Open tender: building condition audit', 'Asset management plan due for review', 'Capital works program published',
  'New facilities manager started', 'Council budget names an asset register refresh'];
const OUTREACH_SKIPS = ['skipped-unverified', 'skipped-colleague', 'skipped-held', 'draft-saved'];
const OUTREACH_REPLIES = [['negative', 'Not a priority this year.'], ['referral', 'Pointed us to their asset team lead.'],
  ['positive', 'Keen to see a short demo.'], ['neutral', 'Asked for a one-page overview.']];

export function outreachDemo(today, idf = (p) => `${p}_${uid()}`) {
  const mailboxes = [
    { id: idf('mb'), name: 'David', addresses: ['david@example.com'], owner: 'david', active: true },
    { id: idf('mb'), name: 'Josh', addresses: ['josh@example.com'], owner: 'josh', active: true },
    { id: idf('mb'), name: 'Sarah', addresses: ['sarah@example.com'], owner: '', active: true },
  ];
  let r = 7; // a small fixed pseudo-random sequence, so the demo is the same every time
  const rnd = (k) => { r = (r * 1103515245 + 12345) % 2147483648; return Math.floor(r / 65536) % k; };
  const emails = [];
  // The last 12 working days: David sends throughout, Josh for the last 6, Sarah for the last 3.
  const days = [];
  for (let d = today; days.length < 12; d = addDays(d, -1)) if (isoDow(d) <= 5) days.unshift(d);
  // A contact is logged once a day (the sheet's row key is the contact's email and the day): first and last names
  // mixed, never the same person twice in a day.
  const FIRST = OUTREACH_PEOPLE.map((x) => x.split(' ')[0]);
  const LAST = OUTREACH_PEOPLE.map((x) => x.split(' ')[1]);
  let taken = new Set();
  const person = () => {
    for (;;) {
      const name = `${FIRST[rnd(FIRST.length)]} ${LAST[rnd(LAST.length)]}`;
      const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
      if (!taken.has(email)) { taken.add(email); return { name, email }; }
    }
  };
  days.forEach((day, di) => {
    taken = new Set();
    mailboxes.forEach((m, mi) => {
      if ((mi === 1 && di < 6) || (mi === 2 && di < 9)) return;
      const logged = [9, 7, 6][mi] + rnd(5);
      for (let k = 0; k < logged; k++) {
        const [organisation, vertical, location] = OUTREACH_ORGS[rnd(OUTREACH_ORGS.length)];
        const { name, email } = person();
        const sent = rnd(10) < 7;
        const status = sent ? 'sent' : OUTREACH_SKIPS[rnd(OUTREACH_SKIPS.length)];
        const id = idf('oe');
        const e = {
          id, rowKey: '', mailbox: m.id, sender: m.addresses[0], dateLogged: day, vertical, organisation, domain: 'example.com', location,
          contactName: name, contactRole: OUTREACH_ROLES[rnd(OUTREACH_ROLES.length)],
          contactEmail: email, tier: ['A', 'B', 'C'][rnd(3)],
          signal: OUTREACH_SIGNALS[rnd(OUTREACH_SIGNALS.length)], subject: sent ? `${organisation}: asset condition data` : '',
          variant: sent ? ['v1', 'v2'][rnd(2)] : '', status, sentOn: sent ? day : '', messageId: sent ? `msg-${id}` : '',
          threadId: sent ? `thr-${id}` : '', sequenceStatus: sent ? 'active' : '', followupStage: 0,
          nextFollowup: sent ? addDays(day, 4) : '', bounced: false, replyStatus: '', replyOn: '', replySummary: '', note: '',
          meetingOn: '', inSheet: true,
        };
        e.rowKey = `${e.contactEmail}|${day}`;
        if (sent && rnd(100) < 2) { e.bounced = true; e.sequenceStatus = 'bounced'; }
        else if (sent && rnd(100) < 7) {
          const replyOn = addDays(day, 1 + rnd(3));
          if (replyOn <= today) {
            const [kind, summary] = OUTREACH_REPLIES[rnd(OUTREACH_REPLIES.length)];
            Object.assign(e, { replyStatus: kind, replyOn, replySummary: summary, sequenceStatus: `replied-${kind}` });
            if (kind === 'positive') e.meetingOn = addDays(replyOn, 2) <= today ? addDays(replyOn, 2) : '';
          }
        }
        emails.push(e);
        // Some emails go to two people at the organisation (one Gmail message, a row each, as the agent logs them).
        if (sent && rnd(10) < 2) {
          const other = person();
          emails.push({ ...e, id: idf('oe'), rowKey: `${other.email}|${day}`, contactName: other.name, contactEmail: other.email,
            contactRole: OUTREACH_ROLES[rnd(OUTREACH_ROLES.length)], bounced: false, sequenceStatus: e.bounced ? 'active' : e.sequenceStatus });
        }
      }
    });
  });
  // At least one meeting booked, so every number on the page has something to show.
  if (!emails.some((e) => e.meetingOn)) {
    const e = emails.find((x) => x.sentOn && x.sentOn <= addDays(today, -4) && !x.bounced);
    if (e) Object.assign(e, { replyStatus: 'positive', replyOn: addDays(e.sentOn, 1), replySummary: OUTREACH_REPLIES[2][1],
      sequenceStatus: 'replied-positive', meetingOn: addDays(e.sentOn, 3) });
  }
  const notes = [ // newest first, as in state
    { id: idf('on'), mailbox: mailboxes[1].id, pinned: false, author: 'josh', createdAt: `${addDays(today, -1)}T03:40:00.000Z`,
      body: 'Water utilities reply more to the v2 subject line. Keep v1 for councils.' },
    { id: idf('on'), mailbox: '', pinned: true, author: 'david', createdAt: `${addDays(today, -2)}T09:15:00.000Z`,
      body: 'What works now: open with the live tender or capital works item in the first line, keep it under 90 words, one ask (a 15-minute call).' },
  ];
  return { mailboxes, outreachNotes: notes, outreachEmails: emails, outreachSheet: '' };
}

const previousWeekday = (day) => { let d = addDays(day, -1); while (isoDow(d) > 5) d = addDays(d, -1); return d; };

// Hello's last working day, as saved from the 16:30 prompt.
const timesheet = (day) => [
  ['09:00', 'LinkedIn', 'Engagement on council posts', 'suggested'],
  ['10:00', 'Outreach', 'Replies and follow-ups', 'suggested'],
  ['11:00', 'Marketing', 'Company page post', 'suggested'],
  ['12:00', 'Email marketing', 'Utilities sequence, step 2', 'manual'],
  ['13:00', 'Marketing', 'Westbay case study draft', 'manual'],
  ['14:00', 'Admin', 'Phone quotes', 'manual'],
  ['15:00', 'Outreach', 'Outreach replies', 'suggested'],
  ['16:00', 'Other', '', 'suggested'],
].map(([start, category, note, source]) => ({ id: id('te'), user: 'hello', day, start, minutes: 60, category, note, source }));

export function createSeed() {
  n = 0;
  now = Date.now();
  const today = localYmd(new Date(now));
  const lastWorkday = previousWeekday(today);
  const seedClients = clients(today);
  const [westbay, , , harbour] = seedClients;

  // Newest first. Bayview Water has just replied (the automation below turns it into a deal and a to-do).
  const contacts = [
    { id: id('p'), name: 'Quinn Avery', org: 'Bayview Water', email: 'quinn.avery@example.com', stage: 'Opportunity', status: 'Replied', last: hoursAgo(3), owner: 'hello' },
    { id: id('p'), name: 'Drew Lennox', org: 'Hillcrest Shire', email: 'drew.lennox@example.com', stage: 'Opportunity', status: 'New', last: '', owner: 'hello' },
    { id: id('p'), name: 'Alex Taylor', org: 'Westbay Council', email: 'alex.taylor@example.com', stage: 'Won', status: 'Replied', last: hoursAgo(48), owner: 'josh' },
    { id: id('p'), name: 'Jordan Price', org: 'Northside Diocese', email: 'jordan.price@example.com', stage: 'Demo', status: 'Opened', last: hoursAgo(96), owner: 'josh' },
    { id: id('p'), name: 'Riley Shaw', org: 'Riverbend Water', email: 'riley.shaw@example.com', stage: 'Opportunity', status: 'Sent', last: hoursAgo(6), owner: 'david' },
    { id: id('p'), name: 'Casey Ng', org: 'Coastal Rail', email: 'casey.ng@example.com', stage: 'Opportunity', status: 'No reply', last: hoursAgo(216), owner: 'hello' },
    { id: id('p'), name: 'Morgan Hale', org: 'Shire of Southcliff', email: 'morgan.hale@example.com', stage: 'First meeting', status: 'Meeting booked', last: hoursAgo(24), owner: 'josh' },
  ];
  const contactId = (name) => contacts.find((c) => c.name === name).id;

  // Deals that came from an outreach contact keep the link, so a later reply or booking moves them on.
  const deals = [
    deal('City of Lakeside', 'Government', 70000, 'P2', 'Opportunities', 'josh', 'Intro call'),
    deal('Riverbend Water', 'Utilities', 220000, 'P1', 'Opportunities', 'david', 'Send digital twin brief', contactId('Riley Shaw')),
    deal('Coastal Rail', 'Transport', 160000, 'P2', 'Opportunities', 'hello', 'PDF walkthrough', contactId('Casey Ng')),
    deal('Shire of Southcliff', 'Government', 55000, 'P2', 'First meetings', 'josh', 'Thursday 10am walkthrough', contactId('Morgan Hale')),
    deal('Eastgate University Facilities', 'Education', 90000, 'P3', 'First meetings', 'david', 'Confirm campus list'),
    deal('Northside Diocese', 'Healthcare', 110000, 'P1', 'Demos', 'josh', 'Scope document', contactId('Jordan Price')),
    deal('Harbour Construction', 'Construction', 190000, 'P1', 'Demos', 'david', 'Pilot review'),
    deal('Westbay Council', 'Government', 130000, 'P1', 'Won', 'david', 'Onboarding', contactId('Alex Taylor')),
  ];
  // Won deals that already have a client start linked, so Pipeline shows "Client", not "Make client".
  deals.forEach((dl) => {
    if (dl.stage !== 'Won') return;
    const c = seedClients.find((x) => x.name === dl.name);
    if (c) dl.clientId = c.id;
  });

  // Money in: the week's bank screenshot hasn't been attached in the demo (files never go in the repo).
  const statement = { id: id('bs'), weekStart: '2026-10-05', filePath: '', note: 'Two client payments', uploadedBy: 'david', createdAt: '2026-10-09T06:00:00.000Z' };
  const invoiceNo = (c, number) => c.invoices.find((i) => i.number === number).id;

  const state = {
    version: 1,
    me: 'david',
    users: USERS.map((u) => ({ ...u })),
    // No overrides: staff start on the defaults (outreach hidden, pipeline and clients view-only). The SuperAdmin
    // switches modules on per person in Settings → Team.
    moduleAccess: [],
    org: { ...ORG },
    boards: boards(),
    deals,
    clients: seedClients,
    contacts,
    emails: [
      { id: id('e'), kind: 'reply', contactId: contactId('Quinn Avery'), contact: 'Quinn Avery', subject: 'Re: Digital twin for water assets', snippet: 'Keen to see it. Could you send a short overview first?', ts: hoursAgo(3) },
      { id: id('e'), kind: 'reply', contactId: contactId('Morgan Hale'), contact: 'Morgan Hale', subject: 'Re: Asset register walkthrough', snippet: 'Thursday 10am works, can you include our facilities lead?', ts: hoursAgo(24) },
      { id: id('e'), kind: 'open', contactId: contactId('Jordan Price'), contact: 'Jordan Price', subject: 'Proposal – asset program', snippet: 'Opened 3 times', ts: hoursAgo(96) },
      { id: id('e'), kind: 'sent', contactId: contactId('Riley Shaw'), contact: 'Riley Shaw', subject: 'Digital twin for treatment sites', snippet: 'Sequence: Utilities intro, step 1 of 4', ts: hoursAgo(6) },
    ],
    sequences: [
      { id: id('q'), name: 'Council intro', steps: 4, enrolled: 18, replyRate: 0.22 },
      { id: id('q'), name: 'Utilities intro', steps: 4, enrolled: 9, replyRate: 0.11 },
      { id: id('q'), name: 'Post-demo follow-up', steps: 3, enrolled: 6, replyRate: 0.5 },
    ],
    approvals: [],
    ...chat(),
    routines: routines(),
    todos: [],
    routineRuns: [], // demo only: the routine runs ensureTodosLocal has made (routine_runs in the database)
    payments: [
      { id: id('pay'), invoiceId: invoiceNo(westbay, 'INV-1012'), clientId: westbay.id, amount: 5000, receivedOn: '2026-10-07', reference: 'Part payment INV-1012', statementId: statement.id },
      { id: id('pay'), invoiceId: invoiceNo(harbour, 'INV-1014'), clientId: harbour.id, amount: 7975, receivedOn: '2026-10-06', reference: 'INV-1014', statementId: statement.id },
    ],
    bankStatements: [statement],
    // Amounts include GST (GST = amount / 11).
    expenses: [
      { id: id('x'), date: '2026-10-09', vendor: 'Office supplies', category: 'Office', amount: 88, gst: 8, clientId: '', receiptPath: '', notes: 'Printer paper and toner', createdBy: 'josh' },
      { id: id('x'), date: '2026-10-07', vendor: 'Regional flights', category: 'Travel', amount: 412.5, gst: 37.5, clientId: westbay.id, receiptPath: '', notes: 'Onboarding visit', createdBy: 'david' },
      { id: id('x'), date: '2026-10-03', vendor: 'Coastal Golf Club', category: 'Marketing', amount: 1650, gst: 150, clientId: '', receiptPath: '', notes: 'Golf Day hole sponsorship', createdBy: 'david' },
    ],
    subscriptions: [
      { id: id('sub'), name: 'Google Workspace', vendor: 'Google', category: 'Software', amount: 69, cycle: 'monthly', renewsOn: '2026-11-01', active: true, notes: '3 seats' },
      { id: id('sub'), name: 'Supabase Pro', vendor: 'Supabase', category: 'Hosting', amount: 40, cycle: 'monthly', renewsOn: '2026-11-03', active: true, notes: '' },
      { id: id('sub'), name: 'Claude Team', vendor: 'Anthropic', category: 'Software', amount: 150, cycle: 'monthly', renewsOn: '2026-10-20', active: true, notes: '' },
      { id: id('sub'), name: 'Domain names', vendor: 'Registrar', category: 'Hosting', amount: 60, cycle: 'annually', renewsOn: '2027-03-14', active: true, notes: '' },
      { id: id('sub'), name: 'Project boards', vendor: 'Boards app', category: 'Software', amount: 48, cycle: 'monthly', renewsOn: '', active: false, notes: 'Replaced by Cortex' },
    ],
    timeEntries: timesheet(lastWorkday),
    ...outreachDemo(today, id),
    // Hello's logins and links in My Work (set up by an admin).
    tools: ['Gmail', 'Google Drive', 'Apollo', 'Claude'].map((name) => {
      const preset = TOOL_PRESETS.find((x) => x.name === name);
      return { id: id('wt'), user: 'hello', ...preset, username: 'hello@example.com', notes: '', createdBy: 'david' };
    }),
  };

  // The automations, run the way the app runs them, so the demo data follows the same rules.
  const opts = { uid: () => id('td') };
  generateDueInvoicesLocal(state, today, { uid: () => id('i') }); // Westbay's licence for this month: Awaiting approval
  contactPipelineLocal(state, contactId('Quinn Avery'), 'Sent', { ...opts, day: today, me: 'josh', uid: () => id('d') });

  // Hello's last working day: routines done except one, which carries over.
  ensureTodosLocal(state, lastWorkday, { ...opts, me: 'hello' });
  state.todos.forEach((t) => {
    if (t.day === lastWorkday && t.title !== 'Check outreach replies') Object.assign(t, { done: true, doneAt: `${lastWorkday}T07:00:00.000Z` });
  });
  // Today: routines (on weekdays) and work the admins assigned.
  ensureTodosLocal(state, today, { ...opts, me: 'hello' });
  const todo = (fields) => state.todos.push(makeTodo({ day: today, ...fields }, opts.uid));
  todo({ assignee: 'hello', createdBy: 'david', title: 'Update Westbay case study draft', start: '13:00', minutes: 45, category: 'Marketing' });
  todo({ assignee: 'hello', createdBy: 'josh', title: 'Golf Day photos to the Marketing board', minutes: 30, category: 'Marketing' });
  todo({ assignee: 'hello', createdBy: 'josh', title: 'Book a room for Thursday onboarding', minutes: 15, category: 'Admin', done: true, doneAt: new Date(now).toISOString() });
  todo({ assignee: 'josh', createdBy: 'josh', title: 'Prepare Shire of Southcliff walkthrough', start: '10:00', minutes: 60, category: 'Demos' });
  return state;
}

const COLLECTIONS = ['moduleAccess', 'todos', 'routines', 'payments', 'bankStatements', 'expenses', 'subscriptions', 'timeEntries', 'tools'];

// Brings demo data saved by older builds (localStorage) up to the current shape. Safe to run more than once.
export function migrate(data) {
  // lastRead used to be one map shared by everyone; it is now { [userId]: { [channelId]: ts } }.
  const lr = data.lastRead || {};
  if (Object.values(lr).some((v) => typeof v === 'string')) data.lastRead = Object.fromEntries(data.users.map((u) => [u.id, { ...lr }]));
  // Deal owners used to be display names; they are now user ids.
  const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  (data.deals || []).forEach((dl) => {
    const u = data.users.find((x) => x.id === dl.contact || normName(x.name) === normName(dl.contact));
    if (u) dl.contact = u.id;
  });
  // Business details, user accounts and client billing fields arrived with live mode.
  data.org = { ...ORG, ...data.org };

  // Phase 2 roles: member is now staff, and someone has to be SuperAdmin to manage access.
  data.users = data.users.map((u) => {
    const seed = USERS.find((x) => x.id === u.id);
    const user = { email: seed?.email ?? `${u.id}@example.com`, role: seed?.role ?? 'staff', active: true, ...u };
    if (!user.timezone) user.timezone = seed?.timezone || TEAM_TIMEZONE; // added in 0003
    if (!['superadmin', 'admin', 'staff'].includes(user.role)) user.role = 'staff'; // ROLES in src/lib/access.js
    return user;
  });
  if (!data.users.some((u) => u.role === 'superadmin' && u.active !== false)) {
    const first = data.users.find((u) => u.role === 'admin' && u.active !== false) || data.users.find((u) => u.active !== false);
    if (first) first.role = 'superadmin';
  }

  const firstGroup = (module) => ({ id: uid(), name: FIRST_GROUP[module], color: FIRST_GROUP_COLOR, items: [] });
  if (!Array.isArray(data.boards)) {
    // The Admin board merges into Projects (its groups move to the end; the seeded "To do" becomes "Admin"), as 0002
    // does in the database.
    const legacy = data.boards && typeof data.boards === 'object' ? data.boards : {};
    legacy.projects ||= { groups: [] };
    legacy.marketing ||= { groups: [] };
    if (legacy.admin) {
      (legacy.admin.groups || []).forEach((g) => legacy.projects.groups.push({ ...g, name: g.name === 'To do' ? 'Admin' : g.name }));
      delete legacy.admin;
    }
    // Sub-boards (0006): the Projects groups go on General and the Marketing ones on Posting schedule, next to the
    // other starting team boards; a board with no groups starts with one.
    data.boards = BOARD_MODULES.flatMap((module) => STARTING_BOARDS[module].map((name) => {
      const groups = name === EXISTING_BOARD[module] ? legacy[module].groups || [] : [];
      return { id: uid(), module, name, owner: '', groups: groups.length ? groups : [firstGroup(module)] };
    }));
  }
  // Everyone has their own Projects page (0006 and its new-profile trigger).
  const pages = data.users.filter((u) => !data.boards.some((b) => b.module === 'projects' && b.owner === u.id))
    .map((u) => ({ id: uid(), module: 'projects', name: '', owner: u.id, groups: [firstGroup('projects')] }));
  data.boards = [...pages, ...data.boards];
  // An item's single owner becomes its people, as the 0002 migration does in the database.
  const userIds = new Set(data.users.map((u) => u.id));
  data.boards.forEach((b) => {
    b.name ??= '';
    b.owner ??= '';
    (b.groups ||= []).forEach((g) => (g.items || []).forEach((it) => {
      const values = { ...it.values };
      if (!userIds.has(values.owner)) delete values.owner; // a stale owner is dropped
      it.values = withPeople(values);
    }));
  });

  (data.contacts || []).forEach((c) => { c.owner ??= ''; });
  (data.deals || []).forEach((dl) => { dl.contactId ??= ''; });
  (data.clients || []).forEach((c) => {
    c.abn ??= '';
    c.billingAddress ??= '';
    c.plans ??= [];
    c.plans.forEach((p) => { p.anchorDay ??= /^\d{4}-\d{2}-\d{2}$/.test(p.nextDate || '') ? Number(p.nextDate.slice(8, 10)) : 0; });
    c.usage ??= [];
    c.usage.forEach((u) => { u.credits ??= 0; });
    (c.invoices ||= []).forEach((inv) => { inv.planId ??= ''; inv.sentAt ??= ''; inv.paidOn ??= ''; inv.sentTo ??= ''; });
    // 0004: the key contact / email become the client's first, billing contact; platform link and contracts are new.
    if (!Array.isArray(c.contacts)) {
      const name = String(c.keyContact ?? '').trim();
      const email = String(c.email ?? '').trim().toLowerCase();
      c.contacts = name || email ? [{ id: uid(), name, role: '', email, phone: '', billing: true }] : [];
    }
    delete c.keyContact;
    delete c.email;
    c.platformUrl ??= '';
    c.contracts ??= [];
  });
  COLLECTIONS.forEach((k) => { data[k] ??= []; });
  // Outreach (0007): demo data saved before it gets the demo mailboxes, emails and notes.
  if (!Array.isArray(data.mailboxes)) Object.assign(data, outreachDemo(localYmd()));
  data.outreachNotes ??= [];
  data.outreachEmails ??= [];
  if (typeof data.outreachSheet !== 'string') data.outreachSheet = '';
  // Demo only: which routine runs ensureTodosLocal has made (the database's routine_runs), from the to-dos older
  // builds made, so a deleted one doesn't come back.
  data.routineRuns ??= data.todos.filter((t) => t.routineId).map((t) => `${t.day}|${t.routineId}|${t.assignee}`);
  return data;
}
