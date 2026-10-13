// The email an invoice goes out with, sent with its PDF from the signed-in admin's own Gmail (Settings → Business →
// Google account). Opened by Approve, Send and Resend (InvoiceActions); the buttons follow the invoice's status, so
// after an Approve and send that approved but didn't send, it offers Send.
import { useId, useState } from 'react';
import { BadgeCheck, Paperclip, Send } from 'lucide-react';
import { useStore } from '@/data/store';
import { Modal } from '@/components/ui';
import { addDays, termsOf } from '@/lib/automations';
import { TEAM_TIMEZONE, ymdIn } from '@/lib/format';
import { invoiceEmail, isEmail, taxInvoiceModel } from '@/lib/taxInvoice';
import { cn } from '@/lib/cn';
import { Labelled, MODAL_FORM, UNISSUED, hasBadAmounts } from './shared';

const str = (v) => String(v ?? '').trim();
const MAX_TO = 10; // the google function's limit

// "a@example.com, b@example.com" → the distinct addresses (lower case), and anything typed that isn't one.
function recipients(text) {
  const all = [...new Set(String(text ?? '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  return { to: all.filter(isEmail), bad: all.filter((x) => !isEmail(x)) };
}

// Approving issues the invoice today (Sydney), due after the payment terms, as approveInvoice does: the email is
// drafted for that copy, not the draft one.
function asApproved(inv, state) {
  if (!UNISSUED.includes(inv.status)) return inv;
  const today = ymdIn(TEAM_TIMEZONE);
  return { ...inv, status: 'Approved', issued: today, due: addDays(today, termsOf(state)) };
}

const BUTTON = 'inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50';

/** Mounted while open. Approve and send / Approve only for an unissued invoice, Send for an Approved or Sent one.
 *  Errors stay in the dialog; it closes once the action worked. */
export default function SendInvoice({ c, inv, onClose }) {
  const { state, actions, google } = useStore();
  const org = state.org || {};
  const [form, setForm] = useState(() => {
    const sender = state.users.find((u) => u.id === state.me) || {};
    const draft = invoiceEmail({ client: c, invoice: asApproved(inv, state), org, sender });
    return { to: draft.to.join(', '), subject: draft.subject, text: draft.text };
  });
  const [busy, setBusy] = useState(''); // '' | 'approve' | 'send'
  const [error, setError] = useState('');
  const hintId = useId();

  const approving = UNISSUED.includes(inv.status);
  const { to, bad } = recipients(form.to);
  const noAbn = !str(org.abn);
  const toHint = bad.length ? `Not an email address: ${bad.join(', ')}`
    : to.length > MAX_TO ? `Send to ${MAX_TO} addresses at most`
      : !to.length ? 'Add a billing contact on the client’s Overview, or type an address' : '';
  const badAmounts = hasBadAmounts(inv);
  const canSend = google.connected && !noAbn && !toHint && Boolean(str(form.subject)) && !badAmounts && !busy;
  const email = () => ({ to, subject: str(form.subject), text: form.text });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const title = `${approving ? 'Approve' : inv.status === 'Sent' ? 'Resend' : 'Send'} ${inv.number}`;

  // Close when it worked; otherwise show why and stay open.
  const run = async (kind, act) => {
    setBusy(kind);
    setError('');
    let message;
    try {
      message = await act();
    } catch (e) {
      message = e?.message || 'Something went wrong';
    }
    if (!message) { onClose(); return; }
    setError(message);
    setBusy('');
  };
  const approveOnly = () => run('approve', async () => ((await actions.approveInvoice(c.id, inv.id)) ? '' : 'Couldn’t approve this invoice.'));
  const approveAndSend = () => run('send', async () => {
    const res = await actions.approveInvoice(c.id, inv.id, email());
    if (!res) return 'Couldn’t approve this invoice.';
    return res.error ? `Approved, but not sent: ${res.error}` : '';
  });
  const send = () => run('send', async () => {
    const res = await actions.emailInvoice(c.id, inv.id, email());
    return res.ok ? '' : res.error || 'Couldn’t send the invoice.';
  });

  // No closing (X, backdrop, Escape) mid-request: the result would be lost, and the invoice, still Approved, would
  // offer Send again and email the client twice.
  return (
    <Modal open onClose={onClose} closable={!busy} title={title} width={520}>
      {/* Not a <form>: Enter in To or Subject must never approve or send. */}
      <div className={MODAL_FORM}>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] dimmer">From</span>
          {google.connected
            ? <span className="truncate font-semibold">{google.email}</span>
            : <a href="#/settings?tab=business" className="self-start text-amber-200 underline underline-offset-2 hover:text-white">Connect Google in Settings</a>}
        </div>
        <Labelled label="To">
          <input className={cn('field', toHint && '!border-amber-300')} type="text" inputMode="email" autoComplete="off" value={form.to}
            onChange={set('to')} aria-invalid={toHint ? true : undefined} aria-describedby={toHint ? hintId : undefined} />
          {toHint && <span id={hintId} className="text-[12px] text-amber-200">{toHint}</span>}
        </Labelled>
        <Labelled label="Subject">
          <input className={cn('field', !str(form.subject) && '!border-amber-300')} autoComplete="off" value={form.subject} onChange={set('subject')} />
        </Labelled>
        <Labelled label="Message">
          <textarea className="field resize-none !rounded-[18px]" rows={8} value={form.text} onChange={set('text')} />
        </Labelled>
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] dim">
          <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{taxInvoiceModel({ client: c, invoice: inv, org }).filename}</span>
        </div>
        {noAbn && (
          <p className="text-[12.5px] text-amber-200">
            Sending needs your ABN: without it this isn’t a valid tax invoice.{' '}
            <a href="#/settings?tab=business" className="underline underline-offset-2 hover:text-white">Add it in Settings</a>
          </p>
        )}
        {badAmounts && <p className="text-[12.5px] text-amber-200">Fix the invoice’s amounts first</p>}
        {error && <div role="alert" className="text-[12.5px] text-rose-200">{error}</div>}
        <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
          {approving && (
            <button type="button" onClick={approveOnly} disabled={Boolean(busy) || badAmounts} className={cn(BUTTON, 'chip')}>
              <BadgeCheck className="h-4 w-4" aria-hidden="true" />{busy === 'approve' ? 'Approving…' : 'Approve only'}
            </button>
          )}
          <button type="button" onClick={approving ? approveAndSend : send} disabled={!canSend} className={cn(BUTTON, 'btn-primary')}>
            <Send className="h-4 w-4" aria-hidden="true" />
            {busy === 'send' ? 'Sending…' : approving ? 'Approve and send' : 'Send'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
