import { useEffect, useState } from 'react';
import { useStore } from '@/data/store';
import { Field } from './controls';

const ORG_DEFAULTS = {
  businessName: '', abn: '', address: '', email: '', phone: '', bankAccountName: '', bsb: '', accountNumber: '',
  paymentTermsDays: 30, invoicePrefix: 'INV-',
};

// Hints only: an odd ABN or BSB is still saved.
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
function abnHint(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const d = s.replace(/\s/g, '');
  if (!/^\d{11}$/.test(d)) return 'ABN is 11 digits';
  // ATO check: subtract 1 from the first digit, weight the digits, and the sum divides by 89.
  const sum = [...d].reduce((t, c, i) => t + (Number(c) - (i === 0 ? 1 : 0)) * ABN_WEIGHTS[i], 0);
  return sum % 89 === 0 ? '' : 'Check the ABN';
}
const bsbHint = (v) => (String(v || '').trim() && !/^\d{6}$/.test(String(v).replace(/[\s-]/g, '')) ? 'BSB is 6 digits' : '');

/** Business details used on invoices: name, ABN, contact, bank and invoice settings. */
export default function Business() {
  const { state, actions } = useStore();
  const org = { ...ORG_DEFAULTS, ...state.org };
  const set = (k) => (e) => actions.updateOrg({ [k]: e.target.value });
  // Payment terms keep their own text so the box can be cleared while typing; only whole days are saved.
  const [terms, setTerms] = useState(String(org.paymentTermsDays));
  useEffect(() => { setTerms((t) => (Number(t) === org.paymentTermsDays && t.trim() !== '' ? t : String(org.paymentTermsDays))); }, [org.paymentTermsDays]);
  const onTerms = (e) => {
    const v = e.target.value;
    setTerms(v);
    const n = Number(v);
    if (v.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 365) actions.updateOrg({ paymentTermsDays: n });
  };
  return (
    <div className="rounded-[26px] glass glass-rim p-5 sm:p-6">
      <h2 className="font-extrabold text-[16px]">Details</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Business name" value={org.businessName} onChange={set('businessName')} />
        <Field label="ABN" value={org.abn} onChange={set('abn')} inputMode="numeric" hint={abnHint(org.abn)} />
        <Field label="Email" type="email" value={org.email} onChange={set('email')} />
        <Field label="Phone" type="tel" value={org.phone} onChange={set('phone')} />
        <Field label="Address" multiline rows={3} className="sm:col-span-2" value={org.address} onChange={set('address')} />
      </div>
      <h2 className="mt-7 font-extrabold text-[16px]">Bank</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Account name" className="sm:col-span-2" value={org.bankAccountName} onChange={set('bankAccountName')} />
        <Field label="BSB" value={org.bsb} onChange={set('bsb')} inputMode="numeric" hint={bsbHint(org.bsb)} />
        <Field label="Account number" value={org.accountNumber} onChange={set('accountNumber')} inputMode="numeric" />
      </div>
      <h2 className="mt-7 font-extrabold text-[16px]">Invoices</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Payment terms (days)" type="number" min={0} max={365} step={1} inputMode="numeric" value={terms} onChange={onTerms}
          onBlur={() => setTerms(String(org.paymentTermsDays))} />
        <Field label="Invoice prefix" value={org.invoicePrefix} onChange={set('invoicePrefix')} />
      </div>
    </div>
  );
}
