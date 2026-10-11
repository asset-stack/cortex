// Example data shaped on the Client Tracker, the monday.com Posting Schedule and the
// master-layout whiteboard. Everything here is demo content until a real backend is wired in.
// The repo is public: organisations, people, invoices and amounts are fictional and emails are
// placeholders (example.com). Never put real client names or details in this file.

let n = 0;
const id = (p) => `${p}_${(++n).toString(36)}`;
let now = Date.now(); // refreshed by createSeed, so Reset gives fresh relative times
const hoursAgo = (h) => new Date(now - h * 3600e3).toISOString();

export const USERS = [
  { id: 'david', name: 'David', initials: 'DV', color: '#9cd326' },
  { id: 'dale', name: 'Dale', initials: 'DL', color: '#579bfc' },
  { id: 'stu', name: 'Stu', initials: 'ST', color: '#a78bfa' },
  { id: 'nick', name: 'Nick', initials: 'NK', color: '#ff9a3c' },
  { id: 'sam', name: 'Sam', initials: 'SM', color: '#ff7575' },
];

const item = (name, values, extra = {}) => ({
  id: id('it'), name, values, updates: [], subtasks: [], done: false, ...extra,
});

function boards() {
  return {
    projects: {
      groups: [
        { id: id('g'), name: 'Active', color: '#c9ffe6', items: [
          item('Register NFP', { owner: 'dale', status: 'In progress', priority: 'High', due: '2026-10-30' },
            { subtasks: [{ id: id('s'), text: 'Draft constitution', done: true }, { id: id('s'), text: 'Lodge with ACNC', done: false }] }),
          item('Free Tender Portal', { owner: 'david', status: 'Not started', priority: 'Medium', due: '2026-11-15' }),
        ] },
        { id: id('g'), name: 'Backlog', color: '#e6eaf2', items: [
          item('AssetStack Academy', { owner: 'sam', status: 'Not started', priority: 'Low', due: '' }),
        ] },
      ],
    },
    admin: {
      groups: [
        { id: id('g'), name: 'This quarter', color: '#ffe6b0', items: [
          item('Merchandise', { owner: 'david', status: 'In progress', priority: 'Low', due: '2026-10-18' }),
          item('Trademark', { owner: 'dale', status: 'Stuck', priority: 'High', due: '2026-10-22' },
            { updates: [{ id: id('u'), user: 'dale', text: 'Waiting on IP Australia examiner response.', ts: hoursAgo(30) }] }),
          item('Insurance renewal', { owner: 'dale', status: 'In progress', priority: 'High', due: '2026-10-31' }),
          item('Set up Alltell phones', { owner: 'sam', status: 'Not started', priority: 'Medium', due: '2026-11-08' }),
          item('Outsource time logger', { owner: 'david', status: 'Not started', priority: 'Low', due: '2026-11-20' }),
        ] },
      ],
    },
    marketing: {
      groups: [
        { id: id('g'), name: 'October', color: '#bfe9ff', items: [
          item('LinkedIn weekly engagement', { owner: 'david', status: 'In progress', type: 'Industry', channel: 'LinkedIn', approval: '', due: '2026-10-31' }),
          item('Golf Day promotion', { owner: '', status: 'In progress', type: 'Sponsorship', channel: 'LinkedIn', approval: '', due: '2026-10-12' }),
          item('Stefi on site', { owner: 'david', status: 'In progress', type: 'Industry', channel: 'LinkedIn', approval: 'No', due: '2026-10-15' }),
          item('Golf Day content', { owner: '', status: 'In progress', type: 'Industry', channel: 'Content', approval: '', due: '2026-10-16' }),
          item('Connect Sydney – Pimble Bridge', { owner: 'david', status: 'Not started', type: 'Projects', channel: 'Website', approval: '', due: '2026-10-20' }),
          item('Monthly award', { owner: 'david', status: 'Stuck', type: 'Staff internal', channel: 'LinkedIn', approval: 'No', due: '2026-10-28' }),
          item('Dolphins & Colts announcement', { owner: 'david', status: 'In progress', type: 'Sponsorship', channel: 'LinkedIn', approval: 'Yes', due: '2026-10-24' }),
        ] },
        { id: id('g'), name: 'November', color: '#ead9ff', items: [
          item('LinkedIn weekly engagement', { owner: '', status: 'Not started', type: 'Projects', channel: 'LinkedIn', approval: '', due: '2026-11-30' }),
          item('Westbay case study', { owner: 'sam', status: 'Not started', type: 'Projects', channel: 'Website', approval: 'Pending', due: '2026-11-14' }),
          item('G2 + Google reviews', { owner: 'david', status: 'Not started', type: 'Industry', channel: 'Reviews', approval: '', due: '2026-11-21' }),
          item('Council landing page (Upwork)', { owner: 'sam', status: 'Not started', type: 'Projects', channel: 'Content', approval: '', due: '2026-11-25' }),
        ] },
      ],
    },
  };
}

// `contact` is the deal owner's user id.
const deal = (name, sector, value, priority, stage, contact, next) => ({ id: id('d'), name, sector, value, priority, stage, contact, next });

function clients() {
  return [
    {
      id: id('c'), name: 'Westbay Council', group: 'Onboarding', status: 'Onboarding', priority: 'P1',
      next: 'David to finalise onboarding meeting', sector: 'Government', contact: 'dale', team: ['dale', 'david'],
      lastContact: '2026-05-19', demo: 'Live site with client', keyContact: 'Alex Taylor', email: 'alex.taylor@example.com',
      demoUrl: 'https://demo.example.com', avatar: '#3b82f6',
      notes: [
        { id: id('n'), user: 'david', text: 'Kick-off went well. Alex wants the asset register imported before training.', ts: hoursAgo(72) },
        { id: id('n'), user: 'dale', text: 'Sent the capability statement and onboarding plan.', ts: hoursAgo(120) },
        { id: id('n'), user: 'stu', text: 'Data template shared with their GIS team.', ts: hoursAgo(200) },
      ],
      tasks: [{ id: id('t'), text: 'Book onboarding meeting', done: false }, { id: id('t'), text: 'Import asset register', done: false }],
      invoices: [
        { id: id('i'), number: 'INV-1017', issued: '2026-10-08', due: '2026-11-07', status: 'Sent', lines: [{ id: id('l'), desc: 'Onboarding – Phase 1', qty: 1, rate: 18450 }] },
        { id: id('i'), number: 'INV-1012', issued: '2026-09-01', due: '2026-10-01', status: 'Overdue', lines: [{ id: id('l'), desc: 'Asset data capture', qty: 1, rate: 12600 }] },
      ],
      access: [
        { id: id('a'), name: 'Alex Taylor', email: 'alex.taylor@example.com', role: 'Client admin' },
        { id: id('a'), name: 'Field team (3 seats)', email: 'field-team@example.com', role: 'Field user' },
        { id: id('a'), name: 'David', email: 'david@example.com', role: 'AssetStack' },
        { id: id('a'), name: 'Dale', email: 'dale@example.com', role: 'AssetStack' },
      ],
    },
    {
      id: id('c'), name: 'Northside Diocese', group: 'Active', status: 'Proposal sent', priority: 'P1',
      next: 'Dale to send scope', sector: 'Healthcare', contact: 'dale', team: ['stu', 'david', 'dale'],
      lastContact: '2026-05-17', demo: 'Demo with client', keyContact: 'Jordan Price', email: 'jordan.price@example.com', demoUrl: '', avatar: '#6366f1',
      notes: [], tasks: [{ id: id('t'), text: 'Send scope document', done: false }], invoices: [],
      access: [{ id: id('a'), name: 'Jordan Price', email: 'jordan.price@example.com', role: 'Client admin' }, { id: id('a'), name: 'Stu', email: 'stu@example.com', role: 'AssetStack' }],
    },
    {
      id: id('c'), name: 'Coastal Rail', group: 'Active', status: 'Passive', priority: 'P2',
      next: 'Re-send demo link (blocked on their network)', sector: 'Transport', contact: 'nick', team: ['nick'],
      lastContact: '2026-08-11', demo: 'Re-send demo link', keyContact: 'Casey Ng', email: 'casey.ng@example.com', demoUrl: '', avatar: '#f59e0b',
      notes: [{ id: id('n'), user: 'nick', text: 'Spoke with their senior engineer. Previous demo link would not open on their network.', ts: hoursAgo(1400) }],
      tasks: [], invoices: [], access: [],
    },
    {
      id: id('c'), name: 'Harbour Construction', group: 'Active', status: 'Active', priority: 'P2',
      next: 'Pilot running on two sites', sector: 'Construction', contact: 'stu', team: ['stu'],
      lastContact: '2026-10-02', demo: 'Pilot', keyContact: 'Jamie Park', email: 'jamie.park@example.com', demoUrl: '', avatar: '#ef4444',
      notes: [], tasks: [],
      invoices: [{ id: id('i'), number: 'INV-1014', issued: '2026-09-12', due: '2026-10-12', status: 'Paid', lines: [{ id: id('l'), desc: 'Pilot licence', qty: 1, rate: 7250 }] }],
      access: [{ id: id('a'), name: 'Jamie Park', email: 'jamie.park@example.com', role: 'Client admin' }],
    },
  ];
}

function chat() {
  const general = id('ch'), sales = id('ch'), marketing = id('ch'), westbay = id('ch');
  return {
    channels: [
      { id: general, name: 'general', members: USERS.map((u) => u.id) },
      { id: sales, name: 'sales', members: ['david', 'dale', 'nick', 'stu'] },
      { id: marketing, name: 'marketing', members: ['david', 'sam'] },
      { id: westbay, name: 'westbay-onboarding', members: ['david', 'dale', 'stu'] },
    ],
    messages: [
      { id: id('m'), channel: general, user: 'stu', text: 'Morning all. Golf Day is Monday 12th, shirts arrive Friday.', ts: hoursAgo(26) },
      { id: id('m'), channel: general, user: 'sam', text: '@david can you approve the Dolphins & Colts post before lunch?', ts: hoursAgo(3) },
      { id: id('m'), channel: sales, user: 'nick', text: 'Coastal Rail still cannot open the demo link on their network. Trying a PDF walkthrough instead.', ts: hoursAgo(20) },
      { id: id('m'), channel: sales, user: 'dale', text: '@nick send it through, I will add it to the Diocese scope pack too.', ts: hoursAgo(19) },
      { id: id('m'), channel: westbay, user: 'dale', text: '@david Alex is free Thursday 10am for the onboarding meeting.', ts: hoursAgo(1.5) },
      { id: id('m'), channel: marketing, user: 'sam', text: 'Case study draft for Westbay is in the Marketing board.', ts: hoursAgo(48) },
    ],
    // Read positions are per viewer: { [userId]: { [channelId]: ts } }.
    lastRead: Object.fromEntries(USERS.map((u) => [u.id, { [general]: hoursAgo(10), [sales]: hoursAgo(1), [marketing]: hoursAgo(1), [westbay]: hoursAgo(5) }])),
  };
}

export function createSeed() {
  n = 0;
  now = Date.now();
  const seedBoards = boards();
  const deals = [
    deal('City of Lakeside', 'Government', 70000, 'P2', 'Opportunities', 'dale', 'Intro call'),
    deal('Riverbend Water', 'Utilities', 220000, 'P1', 'Opportunities', 'david', 'Send digital twin brief'),
    deal('Coastal Rail', 'Transport', 160000, 'P2', 'Opportunities', 'nick', 'PDF walkthrough'),
    deal('Shire of Southcliff', 'Government', 55000, 'P2', 'First meetings', 'dale', 'Thursday 10am walkthrough'),
    deal('Eastgate University Facilities', 'Education', 90000, 'P3', 'First meetings', 'stu', 'Confirm campus list'),
    deal('Northside Diocese', 'Healthcare', 110000, 'P1', 'Demos', 'dale', 'Scope document'),
    deal('Harbour Construction', 'Construction', 190000, 'P1', 'Demos', 'stu', 'Pilot review'),
    deal('Westbay Council', 'Government', 130000, 'P1', 'Won', 'david', 'Onboarding'),
  ];
  const seedClients = clients();
  // Won deals that already have a client start linked, so Pipeline shows "Client", not "Make client".
  deals.forEach((dl) => {
    if (dl.stage !== 'Won') return;
    const c = seedClients.find((x) => x.name === dl.name);
    if (c) dl.clientId = c.id;
  });
  return {
    version: 1,
    me: 'david',
    users: USERS,
    boards: seedBoards,
    deals,
    clients: seedClients,
    contacts: [
      { id: id('p'), name: 'Alex Taylor', org: 'Westbay Council', email: 'alex.taylor@example.com', stage: 'Won', status: 'Replied', last: hoursAgo(48) },
      { id: id('p'), name: 'Jordan Price', org: 'Northside Diocese', email: 'jordan.price@example.com', stage: 'Demo', status: 'Opened', last: hoursAgo(96) },
      { id: id('p'), name: 'Riley Shaw', org: 'Riverbend Water', email: 'riley.shaw@example.com', stage: 'Opportunity', status: 'Sent', last: hoursAgo(6) },
      { id: id('p'), name: 'Casey Ng', org: 'Coastal Rail', email: 'casey.ng@example.com', stage: 'Opportunity', status: 'No reply', last: hoursAgo(216) },
      { id: id('p'), name: 'Morgan Hale', org: 'Shire of Southcliff', email: 'morgan.hale@example.com', stage: 'First meeting', status: 'Replied', last: hoursAgo(24) },
    ],
    emails: [
      { id: id('e'), kind: 'reply', contact: 'Morgan Hale', subject: 'Re: Asset register walkthrough', snippet: 'Thursday 10am works, can you include our facilities lead?', ts: hoursAgo(24) },
      { id: id('e'), kind: 'open', contact: 'Jordan Price', subject: 'Proposal – asset program', snippet: 'Opened 3 times', ts: hoursAgo(96) },
      { id: id('e'), kind: 'sent', contact: 'Riley Shaw', subject: 'Digital twin for treatment sites', snippet: 'Sequence: Utilities intro, step 1 of 4', ts: hoursAgo(6) },
    ],
    sequences: [
      { id: id('q'), name: 'Council intro', steps: 4, enrolled: 18, replyRate: 0.22 },
      { id: id('q'), name: 'Utilities intro', steps: 4, enrolled: 9, replyRate: 0.11 },
      { id: id('q'), name: 'Post-demo follow-up', steps: 3, enrolled: 6, replyRate: 0.5 },
    ],
    approvals: [],
    ...chat(),
  };
}
