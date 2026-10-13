// Client contracts: the Key Details a new Software Subscription Agreement starts from, and the {{Placeholder}} values
// the google Edge Function writes into the copy of the Google Doc template. Pure (relative imports), for the Node tests.
import { addDays, addMonths } from './automations.js';
import { formatAbn, fullDate, money2, ymdIn, TEAM_TIMEZONE } from './format.js';
import { billingContacts } from './taxInvoice.js';

const str = (v) => String(v ?? '').trim();

export const CONTRACT_STATUS = {
  Draft: '#7e8799', 'Sent for signature': '#fdab3d', Signed: '#00c875', Cancelled: '#9aa3b5',
};

// What the template's Key Details usually say (the 72 CTS example): the admin changes any of them per client.
export const CONTRACT_DEFAULTS = {
  title: 'Software Subscription Agreement',
  platform: 'AssetStack - Property Management',
  paymentTerms: 'Invoiced annually in advance, payable within 14 days',
  userLimit: '1 master user & unlimited view only',
  customisations: 'Ten per 12-month period (clause 6)',
  mobileApp: 'Included',
  governingLaw: 'New South Wales',
};

/** End of a term: the day before the same date `months` later (1 Nov 2026 → 31 Oct 2027). When that month has no
 *  such day the term ends on its last day (31 Jan + 1 month → 28 Feb). '' without a start. */
export function termEnd(start, months = 12) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(start))) return '';
  const same = addMonths(start, months); // clamped to the month's last day when it is shorter
  return Number(same.slice(8)) < Number(start.slice(8)) ? same : addDays(same, -1);
}

/** A new contract's Key Details for `client`: the defaults, its annual fee from active plans, starting on the 1st of
 *  next month (Sydney) for 12 months. */
export function newContractDetails(client, today = ymdIn(TEAM_TIMEZONE)) {
  const yearly = (client?.plans || []).filter((p) => p.active !== false)
    .reduce((t, p) => t + (Number(p.amount) || 0) * ({ monthly: 12, quarterly: 4, annually: 1 }[p.frequency] || 0), 0);
  const startDate = addMonths(`${today.slice(0, 7)}-01`, 1);
  return { ...CONTRACT_DEFAULTS, startDate, endDate: termEnd(startDate), annualFee: Math.round(yearly * 100) / 100 };
}

/** The Doc's name in Drive: "<client> - Software Subscription Agreement - 1 Nov 2026". */
export function contractName(client, contract) {
  return [str(client?.name), str(contract?.title) || CONTRACT_DEFAULTS.title, contract?.startDate ? fullDate(contract.startDate) : '']
    .filter(Boolean).join(' - ');
}

/** {{Placeholder}} → text for the template. A placeholder the template doesn't have is simply not used. */
export function contractReplacements({ client, contract, today = ymdIn(TEAM_TIMEZONE) }) {
  const k = contract || {};
  const people = billingContacts(client);
  const fee = Number(k.annualFee) || 0;
  return {
    Customer: str(client?.name),
    'Customer ABN': str(client?.abn) ? formatAbn(client.abn) : '',
    'Customer address': str(client?.billingAddress),
    'Contact name': people.map((x) => str(x.name)).filter(Boolean).join(', '),
    'Contact email': people.map((x) => str(x.email)).filter(Boolean).join(', '),
    Platform: str(k.platform),
    'Start date': k.startDate ? fullDate(k.startDate) : '',
    'End date': k.endDate ? fullDate(k.endDate) : '',
    'Annual fee': fee ? money2(fee).replace(/\.00$/, '') : '',
    'Payment terms': str(k.paymentTerms),
    'User limit': str(k.userLimit),
    Customisations: str(k.customisations),
    'Mobile app': str(k.mobileApp),
    'Governing law': str(k.governingLaw),
    Date: fullDate(today),
  };
}
