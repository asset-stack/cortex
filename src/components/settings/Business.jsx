import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/data/store';
import { hashParam } from '@/lib/router';
import { cn } from '@/lib/cn';
import { Field } from './controls';

const ORG_DEFAULTS = {
  businessName: '', abn: '', address: '', email: '', phone: '', bankAccountName: '', bsb: '', accountNumber: '',
  paymentTermsDays: 30, invoicePrefix: 'INV-', contractTemplate: '', contractFolder: '',
};
const str = (v) => String(v ?? '').trim();

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
// The links the google function reads an id from (it also takes /u/0/ account paths).
const DOC_LINK = /^(https:\/\/)?(docs\.google\.com\/document|drive\.google\.com\/file)\/(u\/\d+\/)?d\/[\w-]{10,}/i;
const FOLDER_LINK = /^(https:\/\/)?drive\.google\.com\/drive\/(u\/\d+\/)?folders\/[\w-]{10,}/i;
const templateHint = (v) => (str(v) && !DOC_LINK.test(str(v)) ? 'Paste the Google Doc’s link (docs.google.com/document/d/…)' : '');
function folderHint(v) {
  const s = str(v);
  if (!s || FOLDER_LINK.test(s)) return '';
  return DOC_LINK.test(s) ? 'That’s a file: paste the folder’s link (drive.google.com/drive/folders/…)' : 'Paste the Drive folder’s link (drive.google.com/drive/folders/…)';
}

// Back from Google: the google Edge Function's callback lands on #/settings?tab=business&google=connected, or
// &google=error&reason=….
const GOOGLE_ERRORS = { denied: 'Google sign-in was cancelled', wrong_account: 'Connect the Google account for your own Cortex email' };
function googleReturn() {
  const result = hashParam('google');
  if (result === 'connected') return { ok: true, text: 'Google connected' };
  if (result === 'error') return { ok: false, text: GOOGLE_ERRORS[hashParam('reason')] || 'Couldn’t connect Google. Try again.' };
  return null;
}

const BUTTON = 'inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50';

/** The signed-in admin's own Google account: invoices are emailed from its Gmail and contracts made in its Drive.
 *  Each admin connects their own. Live mode only (it needs the google Edge Function). */
function GoogleAccount() {
  const { actions, google } = useStore();
  const [note, setNote] = useState(googleReturn); // { ok, text } | null
  const [busy, setBusy] = useState(''); // '' | 'connect' | 'test' | 'disconnect'
  const ref = useRef(null);
  useEffect(() => {
    const result = hashParam('google');
    if (!result) return;
    if (result === 'connected') actions.refreshGoogle();
    // Drop google / reason so a reload doesn't repeat the message (replaceState fires no hashchange).
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    params.delete('google');
    params.delete('reason');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `#/settings${query ? `?${query}` : ''}`);
    ref.current?.scrollIntoView({ block: 'center' });
  }, [actions]);

  // `act` → the note to show, or null while the browser leaves for Google (stays busy).
  const run = async (kind, act) => {
    setBusy(kind);
    setNote(null);
    let result;
    try {
      result = await act();
    } catch (e) {
      result = { ok: false, text: e?.message || 'Something went wrong' };
    }
    if (!result) return;
    setNote(result);
    setBusy('');
  };
  const connect = () => run('connect', async () => {
    const res = await actions.connectGoogle();
    if (!res.ok) return { ok: false, text: res.error || 'Couldn’t connect Google. Try again.' };
    window.location.assign(res.url); // to Google, which comes back here
    return null;
  });
  const test = () => run('test', async () => {
    const res = await actions.sendTestEmail();
    return res.ok ? { ok: true, text: `Test email sent to ${google.email}` } : { ok: false, text: res.error || 'Couldn’t send the test email' };
  });
  const disconnect = () => run('disconnect', async () => (
    (await actions.disconnectGoogle()) ? { ok: true, text: 'Disconnected' } : { ok: false, text: 'Couldn’t disconnect. Try again.' }
  ));

  let body;
  if (google.demo) body = <span className="dim">Live mode only</span>;
  else if (!google.ready) body = <span className="dimmer">Checking…</span>;
  else if (google.connected) {
    body = (
      <>
        <span className="min-w-0 break-all">Connected as <span className="font-semibold">{google.email}</span></span>
        <button type="button" onClick={test} disabled={Boolean(busy)} className={cn(BUTTON, 'chip')}>{busy === 'test' ? 'Sending…' : 'Send test email'}</button>
        <button type="button" onClick={disconnect} disabled={Boolean(busy)} className={cn(BUTTON, 'chip')}>Disconnect</button>
      </>
    );
  } else {
    body = <button type="button" onClick={connect} disabled={Boolean(busy)} className={cn(BUTTON, 'btn-primary')}>Connect Google</button>;
  }
  const message = note || (google.error ? { ok: false, text: `Couldn’t check your Google account: ${google.error}` } : null);
  return (
    <>
      <h2 ref={ref} className="mt-7 font-extrabold text-[16px]">Google account</h2>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">{body}</div>
      <p role="status" className={cn('text-[12.5px]', message && 'mt-2', message?.ok ? 'text-emerald-200' : 'text-amber-200')}>{message?.text}</p>
    </>
  );
}

/** Business details used on invoices: name, ABN, contact, bank and invoice settings; your Google account; and the
 *  contract template and folder (Google Drive links). */
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
      <GoogleAccount />
      <h2 className="mt-7 font-extrabold text-[16px]">Contracts</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Contract template" type="url" value={org.contractTemplate} onChange={set('contractTemplate')} hint={templateHint(org.contractTemplate)} />
        <Field label="Contracts folder" type="url" value={org.contractFolder} onChange={set('contractFolder')} hint={folderHint(org.contractFolder)} />
      </div>
    </div>
  );
}
