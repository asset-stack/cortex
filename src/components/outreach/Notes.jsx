import { useEffect, useState } from 'react';
import { Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { Avatar, ConfirmModal } from '@/components/ui';
import { useAccess } from '@/lib/access';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ALL, NONE, mailboxColor } from './shared';

const SMALL_BUTTON = 'grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white';

/** A note's mailbox ('' = all mailboxes): the active ones, plus the one it is on now. */
function MailboxSelect({ value, onChange, mailboxes, label }) {
  const list = mailboxes.filter((m) => m.active !== false || m.id === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="field !w-auto !rounded-full !py-1.5">
      <option value="">All</option>
      {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );
}

function Note({ note: n, mailboxes, canChange }) {
  const { actions } = useStore();
  const users = useUsers();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(n.body);
  const [confirm, setConfirm] = useState(false);
  const mailbox = n.mailbox ? mailboxes.find((m) => m.id === n.mailbox) : null;
  const author = users[n.author]?.name || 'Unknown';
  const save = () => {
    if (!text.trim()) return;
    if (text.trim() !== n.body && actions.updateOutreachNote(n.id, { body: text.trim() }) === false) return;
    setEditing(false);
  };
  return (
    <li className="border-t rowline py-3.5 first:border-t-0">
      <div className="flex items-center gap-2 text-[12.5px]">
        <Avatar userId={n.author} size={22} ring={false} />
        <span className="font-semibold truncate">{author}</span>
        <span className="dimmer tnum shrink-0">{shortDate(n.createdAt)}</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-[11.5px] dim">
          {mailbox && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: mailboxColor(mailboxes, mailbox.id) }} />}
          <span className="truncate">{mailbox ? mailbox.name : 'All'}</span>
        </span>
        {n.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-amber-200" aria-label="Pinned" />}
        {canChange && !editing && (
          <span className="ml-auto flex shrink-0 items-center">
            <button type="button" onClick={() => actions.updateOutreachNote(n.id, { pinned: !n.pinned })} aria-label={n.pinned ? 'Unpin note' : 'Pin note'} title={n.pinned ? 'Unpin' : 'Pin'} className={SMALL_BUTTON}>
              {n.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            </button>
            <button type="button" onClick={() => { setText(n.body); setEditing(true); }} aria-label="Edit note" title="Edit" className={SMALL_BUTTON}><Pencil className="h-4 w-4" /></button>
            <button type="button" onClick={() => setConfirm(true)} aria-label="Delete note" title="Delete" className={SMALL_BUTTON}><Trash2 className="h-4 w-4" /></button>
          </span>
        )}
      </div>
      {editing ? (
        <form className="mt-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus aria-label="Note"
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
            }}
            className="field resize-y !rounded-[18px] text-[13.5px]" />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="rounded-full chip h-9 px-4 font-semibold">Cancel</button>
            <button type="submit" disabled={!text.trim()} className="btn-primary rounded-full h-9 px-4 font-semibold">Save</button>
          </div>
        </form>
      ) : (
        <p className="mt-2 whitespace-pre-wrap break-words text-[13.5px] dim">{n.body}</p>
      )}
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={() => actions.removeOutreachNote(n.id)} title="Delete note?" />
    </li>
  );
}

function AddNote({ filter, mailboxes }) {
  const { actions } = useStore();
  const fallback = filter === ALL || filter === NONE ? '' : filter;
  const [body, setBody] = useState('');
  const [mailbox, setMailbox] = useState(fallback);
  const [pinned, setPinned] = useState(false);
  useEffect(() => { setMailbox(fallback); }, [fallback]);
  const submit = (e) => {
    e?.preventDefault();
    if (!body.trim()) return;
    if (actions.addOutreachNote({ body: body.trim(), mailbox, pinned }) === false) return;
    setBody('');
    setPinned(false);
    setMailbox(fallback);
  };
  return (
    <form onSubmit={submit} className="mt-3">
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Add a note" aria-label="New note"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }}
        className="field resize-y !rounded-[18px] text-[13.5px]" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <MailboxSelect value={mailbox} onChange={setMailbox} mailboxes={mailboxes} label="Mailbox for the note" />
        <label className="inline-flex items-center gap-2 text-[13px] dim">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="h-4 w-4 accent-white" />Pin
        </label>
        <button type="submit" disabled={!body.trim()} className="btn-primary ml-auto rounded-full h-9 px-4 font-semibold">Add note</button>
      </div>
    </form>
  );
}

/** The team's notes (what works), pinned first, then newest. For a mailbox: its notes and those for all mailboxes. */
export default function Notes({ filter, mailboxes, className }) {
  const { state } = useStore();
  const access = useAccess();
  const editable = access.canEdit('outreach');
  const notes = (state.outreachNotes || [])
    .filter((n) => filter === ALL || !n.mailbox || n.mailbox === filter)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.createdAt).localeCompare(String(a.createdAt)));
  return (
    <section className={cn('min-w-0 rounded-[26px] glass glass-rim p-5', className)}>
      <h2 className="font-extrabold text-[16px]">Notes</h2>
      {editable && <AddNote filter={filter} mailboxes={mailboxes} />}
      {notes.length ? (
        <ul className={cn(editable && 'mt-2')}>
          {notes.map((n) => (
            <Note key={n.id} note={n} mailboxes={mailboxes} canChange={editable && (n.author === state.me || access.isAdmin)} />
          ))}
        </ul>
      ) : <p className="mt-3 text-[13px] dimmer">No notes yet</p>}
    </section>
  );
}
