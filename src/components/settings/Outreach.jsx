import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, Loader2, Mail, Trash2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { ConfirmModal } from '@/components/ui';
import SyncStatus from '@/components/outreach/SyncStatus';
import { mailboxColor } from '@/components/outreach/shared';
import { parseAddresses, sheetFromUrl } from '@/lib/outreach';
import { ago } from '@/lib/format';
import { hashParam } from '@/lib/router';
import { cn } from '@/lib/cn';
import { Switch } from './controls';

// Back from Google after Connect Gmail (#/settings?tab=outreach&gmail=…&mailbox=…), shown on that mailbox's row.
const GMAIL_RESULTS = {
  connected: 'Gmail connected: its emails are being read',
  denied: 'Google sign-in was cancelled',
  wrong_account: 'Sign in as one of this mailbox’s addresses',
  gmail_scope: 'Allow Cortex to read Gmail to connect it',
  no_refresh_token: 'Google didn’t finish connecting. Try again.',
  client: 'Google didn’t accept Cortex’s Google key. Check the Google setup (DEPLOY.md section 11).',
  exchange: 'Google didn’t finish connecting. Try again.',
  save: 'Couldn’t save the connection. Try again.',
};
function gmailReturn() {
  const result = hashParam('gmail');
  if (!result) return null;
  const key = result === 'error' ? hashParam('reason') : result;
  return { mailbox: hashParam('mailbox'), ok: result === 'connected', text: GMAIL_RESULTS[key] || 'Couldn’t connect Gmail. Try again.' };
}
const BUTTON = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-50';
const ADDRESS_DOMAIN = '@assetstackai.com'; // the mailboxes Cortex's Google client can read for now (DEPLOY.md section 14)

/**
 * A mailbox's Gmail (0010): Connect Gmail (an admin signs in as the mailbox; Cortex then reads its cold emails and the
 * answers to them, headers only), then whether it's read and when it last synced, Reconnect, Disconnect.
 */
function MailboxGmail({ mailbox: m, gmail, live, note, onChanged }) {
  const { actions } = useStore();
  const [confirm, setConfirm] = useState(''); // '' | 'connect' | 'disconnect'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = m.name || 'Mailbox';
  const address = (m.addresses || []).find((a) => a.endsWith(ADDRESS_DOMAIN)) || '';
  const connect = async () => {
    setBusy(true);
    setError('');
    const res = await actions.connectMailboxGmail(m.id);
    if (res.ok) { window.location.assign(res.url); return; } // to Google, which comes back here
    setBusy(false);
    setError(res.error || 'Couldn’t connect Gmail. Try again.');
  };
  const disconnect = async () => {
    setBusy(true);
    const ok = await actions.disconnectMailboxGmail(m.id);
    setBusy(false);
    if (!ok) setError('Couldn’t disconnect. Try again.');
    onChanged();
  };

  let line;
  let warn = false;
  if (!gmail?.connected) line = live ? (address ? '' : `Gmail needs an ${ADDRESS_DOMAIN} address`) : 'Gmail: live mode only';
  else if (m.active === false) line = `Gmail: ${gmail.email} · paused while the mailbox is off`;
  else if (gmail.error) { line = `Gmail: ${gmail.error}`; warn = true; }
  else if (!gmail.ready) line = gmail.pending ? `Reading Gmail · ${gmail.pending.toLocaleString('en-AU')} left` : 'Reading Gmail…';
  else {
    const a = gmail.syncedAt ? ago(gmail.syncedAt) : '';
    line = `Gmail: ${gmail.email}${a && a !== '—' ? ` · ${a === 'now' ? 'synced just now' : `synced ${a} ago`}` : ''}`;
  }
  // Back from Google: "connected" only while it still is (a later disconnect or error replaces it).
  const message = error ? { ok: false, text: error } : note && (!note.ok || (gmail?.connected && !gmail.error && !gmail.reconnect)) ? note : null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-[18px] text-[12.5px]">
      <Mail className="h-3.5 w-3.5 shrink-0 dimmer" aria-hidden="true" />
      {line && <span className={cn('min-w-0 break-words', warn ? 'text-amber-200' : 'dim')}>{line}</span>}
      {live && (!gmail?.connected || gmail.reconnect || gmail.error) && (
        <button type="button" onClick={() => setConfirm('connect')} disabled={busy || !address} title={address ? `Sign in as ${address}` : undefined}
          className={cn(BUTTON, gmail?.connected ? 'chip' : 'btn-primary')}>
          {busy && confirm !== 'disconnect' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {gmail?.connected ? 'Reconnect Gmail' : 'Connect Gmail'}
        </button>
      )}
      {gmail?.connected && (
        <button type="button" onClick={() => setConfirm('disconnect')} disabled={busy} className={cn(BUTTON, 'chip')}>Disconnect Gmail</button>
      )}
      {message && <span role="status" className={cn('basis-full', message.ok ? 'text-emerald-200' : 'text-amber-200')}>{message.text}</span>}
      <ConfirmModal open={confirm === 'connect'} onClose={() => setConfirm('')} onConfirm={connect} action="Connect" title={`Connect Gmail for ${name}?`}>
        Sign in as {address}. Cortex reads its sent emails and the answers to them, to count cold emails, replies and bounces. It keeps who, when and the subject, never the message text.
      </ConfirmModal>
      <ConfirmModal open={confirm === 'disconnect'} onClose={() => setConfirm('')} onConfirm={disconnect} action="Disconnect" title={`Disconnect Gmail for ${name}?`}>
        Its Gmail numbers go too; Outreach counts it from the sheet again.
      </ConfirmModal>
    </div>
  );
}

const SMALL_BUTTON = 'grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30';

// Any typed address that isn't one ('' when all are).
function badAddress(text) {
  return String(text || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).find((x) => !parseAddresses(x).length) || '';
}
const addressHint = (text) => (badAddress(text) ? `Not an email address: ${badAddress(text)}` : '');
// A mailbox's name is its tab in the sheet: unique, and not the sync's Summary or Notes (the store refuses those too).
const nameHint = (mailboxes, id = '') => (text) => {
  const n = String(text || '').trim().toLowerCase();
  if (n === 'summary' || n === 'notes') return 'The sheet’s Summary and Notes tabs use this name';
  if (n && mailboxes.some((m) => m.id !== id && String(m.name).trim().toLowerCase() === n)) return 'Another mailbox has this name';
  return '';
};

/**
 * A text input that saves when you leave it or press Enter (Escape puts the saved value back). Only what you typed is
 * saved: an untouched field follows the saved value (another admin may change it meanwhile). `hintFor(text)` names a
 * problem (shown under it once you try to save, nothing saved); `onCommit(trimmed)` → false when the store refused,
 * which restores it; `format` tidies what was saved.
 */
function CommitInput({ value, onCommit, hintFor, format = (t) => t, className, wrapClass, ...props }) {
  const [text, setText] = useState(value);
  const [tried, setTried] = useState(false); // a save was refused for the hint: show it until fixed
  const dirty = useRef(false);
  const hintId = useId();
  useEffect(() => { if (!dirty.current) setText(value); }, [value]);
  const hint = hintFor?.(text) || '';
  const shown = tried && hint;
  const reset = () => { dirty.current = false; setTried(false); setText(value); };
  const commit = () => {
    if (!dirty.current) { setText(value); return; }
    if (hint) { setTried(true); return; }
    const t = text.trim();
    dirty.current = false;
    setTried(false);
    if (t === value.trim() || onCommit(t) === false) setText(value);
    else setText(format(t));
  };
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', wrapClass)}>
      <input value={text} autoComplete="off" spellCheck={false} {...props}
        onChange={(e) => { dirty.current = true; setText(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); reset(); }
        }}
        aria-invalid={shown ? true : undefined} aria-describedby={shown ? hintId : undefined}
        className={cn('field', shown && '!border-amber-300', className)} />
      <span id={hintId} aria-live="polite" className="text-[12px] text-amber-200 empty:hidden">{shown ? hint : ''}</span>
    </div>
  );
}

function SheetLink() {
  const { state, actions } = useStore();
  const saved = state.outreachSheet || '';
  const href = sheetFromUrl(saved).id ? saved : '';
  return (
    <div className="mt-3 flex items-start gap-2">
      <CommitInput value={saved} aria-label="Google Sheet link" placeholder="https://docs.google.com/spreadsheets/d/…" wrapClass="flex-1"
        hintFor={(t) => (!t.trim() ? '' : !sheetFromUrl(t).id ? 'Not a Google Sheets link'
          : !sheetFromUrl(t).gid ? 'Open the agent’s tab and copy its link (it ends in #gid=…)' : '')}
        onCommit={(t) => actions.setOutreachSheet(t)} />
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label="Open the sheet" title="Open the sheet"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full chip"><ExternalLink className="h-4 w-4" /></a>
      )}
    </div>
  );
}

function OwnerSelect({ value, onChange, label, className }) {
  const { state } = useStore();
  const people = state.users.filter((u) => u.active !== false || u.id === value);
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} aria-label={label} className={cn('field !rounded-full !py-1.5', className)}>
      <option value="">Nobody</option>
      {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
    </select>
  );
}

function MailboxRow({ mailbox: m, index, count, mailboxes, gmail, live, note, onGmailChanged }) {
  const { actions } = useStore();
  const [confirm, setConfirm] = useState(false);
  const name = m.name || 'Mailbox';
  const active = m.active !== false;
  return (
    <li className="border-t rowline px-3 py-3 sm:px-4">
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-[15px] h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: mailboxColor(mailboxes, m.id) }} />
        <CommitInput value={m.name} aria-label={`Name of ${name}`} wrapClass="flex-1" className={cn('font-semibold', !active && 'opacity-60')}
          hintFor={nameHint(mailboxes, m.id)} onCommit={(t) => (t ? actions.updateMailbox(m.id, { name: t }) : false)} />
        <span className="flex shrink-0 items-center pt-1">
          <button type="button" onClick={() => actions.moveMailbox(m.id, -1)} disabled={index === 0} aria-label={`Move ${name} up`} title="Move up" className={SMALL_BUTTON}><ArrowUp className="h-4 w-4" /></button>
          <button type="button" onClick={() => actions.moveMailbox(m.id, 1)} disabled={index === count - 1} aria-label={`Move ${name} down`} title="Move down" className={SMALL_BUTTON}><ArrowDown className="h-4 w-4" /></button>
          <button type="button" onClick={() => setConfirm(true)} aria-label={`Delete ${name}`} title="Delete" className={SMALL_BUTTON}><Trash2 className="h-4 w-4" /></button>
        </span>
      </div>
      <div className="mt-2 grid gap-2 pl-[18px] sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-start">
        <CommitInput value={(m.addresses || []).join(', ')} aria-label={`Addresses for ${name}`} placeholder="Addresses" inputMode="email"
          hintFor={addressHint} format={(t) => parseAddresses(t).join(', ')} onCommit={(t) => actions.updateMailbox(m.id, { addresses: parseAddresses(t) })} />
        <OwnerSelect value={m.owner} label={`Owner of ${name}`} onChange={(owner) => actions.updateMailbox(m.id, { owner })} className="sm:!w-[150px]" />
        <span className="flex items-center gap-2 text-[12.5px] dim sm:h-10">Active
          <Switch checked={active} label={`${name} active`} onChange={(on) => actions.updateMailbox(m.id, { active: on })} />
        </span>
      </div>
      <MailboxGmail mailbox={m} gmail={gmail} live={live} note={note} onChanged={onGmailChanged} />
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={() => actions.removeMailbox(m.id)} title={`Delete ${name}?`}>
        Its notes and its Gmail numbers go too; its sheet emails stay, as Unassigned.
      </ConfirmModal>
    </li>
  );
}

function AddMailbox() {
  const { state, actions } = useStore();
  const [name, setName] = useState('');
  const [addresses, setAddresses] = useState('');
  const [touched, setTouched] = useState(false); // the addresses' hint shows once you leave the field
  const hintId = useId();
  const nameId = useId();
  const nameProblem = nameHint(state.mailboxes || [])(name);
  const hint = addressHint(addresses);
  const shown = touched && hint;
  const submit = (e) => {
    e.preventDefault();
    if (hint) setTouched(true);
    if (!name.trim() || nameProblem || hint) return;
    if (actions.addMailbox({ name: name.trim(), addresses: parseAddresses(addresses) }) === false) return;
    setName('');
    setAddresses('');
    setTouched(false);
  };
  return (
    <form onSubmit={submit} className="border-t rowline px-3 py-3 sm:px-4">
      <div className="grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="New mailbox name" autoComplete="off"
          aria-invalid={nameProblem ? true : undefined} aria-describedby={nameProblem ? nameId : undefined}
          className={cn('field', nameProblem && '!border-amber-300')} />
        <input value={addresses} onChange={(e) => setAddresses(e.target.value)} onBlur={() => setTouched(true)} placeholder="Addresses"
          aria-label="New mailbox addresses" autoComplete="off" inputMode="email" spellCheck={false}
          aria-invalid={shown ? true : undefined} aria-describedby={shown ? hintId : undefined} className={cn('field', shown && '!border-amber-300')} />
        <button type="submit" disabled={!name.trim() || Boolean(nameProblem)} className="btn-primary h-10 rounded-full px-4 font-semibold">Add mailbox</button>
      </div>
      <p id={nameId} aria-live="polite" className="mt-1 text-[12px] text-amber-200 empty:hidden">{nameProblem}</p>
      <p id={hintId} aria-live="polite" className="mt-1 text-[12px] text-amber-200 empty:hidden">{shown ? hint : ''}</p>
    </form>
  );
}

/** Admins: the agent's Google Sheet (read into Cortex by the sync) and the outreach mailboxes, each its own data set. */
export default function Outreach() {
  const { state, outreach } = useStore();
  const mailboxes = state.mailboxes || [];
  // Each mailbox's Gmail connection (outreach.gmailStatus()), and the message from coming back after Connect Gmail.
  const [gmail, setGmail] = useState([]);
  const [back, setBack] = useState(gmailReturn);
  const api = useRef(outreach);
  api.current = outreach;
  const loadGmail = useCallback(async () => {
    const res = await api.current.gmailStatus();
    setGmail(res?.ok ? res.mailboxes : []);
  }, []);
  useEffect(() => { loadGmail(); }, [loadGmail, state.mailboxes]);
  // Drop gmail / reason / mailbox so a reload doesn't repeat it (replaceState fires no hashchange). A connect starts
  // its first read at once (SyncStatus, which also refreshes these rows as it goes).
  const [startGmail] = useState(() => Boolean(back?.ok));
  useEffect(() => {
    if (back) window.history.replaceState(window.history.state, '', '#/settings?tab=outreach');
  }, [back]);
  const gmailChanged = useCallback(() => { setBack(null); loadGmail(); }, [loadGmail]);
  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-[26px] glass glass-rim p-5 sm:p-6">
        <h2 className="font-extrabold text-[16px]">Sheet</h2>
        <SheetLink />
        <SyncStatus reader startGmail={startGmail} onSynced={loadGmail} className="mt-3" />
      </section>
      <section className="rounded-[26px] glass glass-rim p-2 sm:p-3">
        <h2 className="px-3 pb-3 pt-2 font-extrabold text-[16px] sm:px-4">Mailboxes</h2>
        <ul>
          {mailboxes.map((m, i) => (
            <MailboxRow key={m.id} mailbox={m} index={i} count={mailboxes.length} mailboxes={mailboxes} live={outreach.live}
              gmail={gmail.find((g) => g.mailbox === m.id)} note={back?.mailbox === m.id ? back : null} onGmailChanged={gmailChanged} />
          ))}
        </ul>
        <AddMailbox />
      </section>
    </div>
  );
}
