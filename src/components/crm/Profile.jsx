// The CRM profile's sections (docs/PHASE2.md §19), shared by a deal's profile (Pipeline) and a client's (Clients):
// Next steps (board tasks linked to it), Timeline (notes and meetings) and Links. `target`: { dealId } or { clientId }.
import { useId, useState } from 'react';
import { CalendarDays, ExternalLink, FileText, Link2, Pencil, Plus, StickyNote, Trash2 } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { PRIORITY } from '@/data/boards';
import { Avatar, AvatarStack } from '@/components/ui';
import NewTaskModal from '@/components/board/NewTaskModal';
import { useAccess } from '@/lib/access';
import { boardHref } from '@/lib/boards';
import { LINK_LABELS, canAddEntry, canChangeEntry, linksOf, timelineOf } from '@/lib/crm';
import { ago, localYmd, safeUrl, shortDate } from '@/lib/format';
import { clientTasks, dealTasks, isWaiting, whereOf } from '@/lib/work';
import { cn } from '@/lib/cn';

const ICON = 'grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white';
const SMALL_BTN = 'inline-flex h-9 items-center gap-1.5 rounded-full chip px-3.5 text-[13px] font-semibold';

function Heading({ children, actions }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-bold">{children}</h3>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** A deal's or client's next steps: its open linked tasks (each opens it) and Add next step (a task for someone, linked
 *  to it, on an Outreach board for a deal and a Clients board for a client). */
export function NextSteps({ target }) {
  const { state } = useStore();
  const access = useAccess();
  const [adding, setAdding] = useState(false);
  const rows = target.dealId ? dealTasks(state, target.dealId) : clientTasks(state, target.clientId);
  const modules = target.dealId ? ['outreach'] : ['clients'];
  const canAdd = state.boards.some((b) => modules.includes(b.module) && !b.owner && access.canEditBoard(b));
  return (
    <section>
      <Heading actions={canAdd && <button type="button" onClick={() => setAdding(true)} className={SMALL_BTN}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add next step</button>}>
        Next steps
      </Heading>
      {adding && (
        <NewTaskModal title="New next step" onClose={() => setAdding(false)} modules={modules}
          {...(target.dealId ? { dealId: target.dealId } : { clientId: target.clientId })} />
      )}
      {rows.length === 0 ? <p className="mt-1 dimmer">None open.</p> : (
        <ul className="mt-2 flex flex-col gap-1">
          {rows.map(({ item, board }) => (
            <li key={item.id}>
              <a href={boardHref(board, item.id)} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-white/5">
                <AvatarStack userIds={item.values.people} size={24} max={1} label="Owner" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-semibold">{item.name.trim() || 'Untitled task'}</span>
                  <span className="block truncate text-[12.5px] dimmer">
                    {whereOf(state, board, item).join(' › ')}{item.values.due ? ` · ${shortDate(item.values.due)}` : ''}{isWaiting(item) ? ' · Waiting to be accepted' : ''}
                  </span>
                </span>
                {PRIORITY[item.values.priority] && (
                  <span className="pill !h-[22px] shrink-0 !px-2 !text-[11px]" style={{ backgroundColor: PRIORITY[item.values.priority] }}>
                    <span className="sr-only">Priority: </span>{item.values.priority}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Timeline ──────────────────────────────────────────────────────────────────────────────────────────────────────

const blank = (kind) => ({ kind, title: '', body: '', url: '', happenedOn: kind === 'meeting' ? localYmd() : '', attendees: '' });

/** Add or edit a note or a meeting. A meeting: its date, title, who attended, a link to its notes (a Google Doc …) and a
 *  short summary of what was agreed and the next steps. */
function EntryForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState('');
  const ids = useId();
  const set = (k) => (e) => { setErr(''); setF((x) => ({ ...x, [k]: e.target.value })); };
  const meeting = f.kind === 'meeting';
  const submit = (e) => {
    e.preventDefault();
    if (meeting && f.url && !safeUrl(f.url)) { setErr('That link isn’t a web address'); return; }
    if (!onSave(f)) setErr(meeting ? 'Add a title, a summary or a notes link' : 'Write something first');
  };
  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2 rounded-2xl chip p-3">
      {meeting && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-2">
            <input className="field" placeholder="Meeting" aria-label="Meeting title" value={f.title} onChange={set('title')} maxLength={300} autoFocus />
            <input type="date" className="field" aria-label="Meeting date" value={f.happenedOn} onChange={set('happenedOn')} />
          </div>
          <input className="field" placeholder="Who attended" aria-label="Who attended" value={f.attendees} onChange={set('attendees')} maxLength={1000} />
          <input className="field" placeholder="Meeting notes link (Google Doc)" aria-label="Meeting notes link" inputMode="url" value={f.url} onChange={set('url')} />
        </>
      )}
      <textarea className="field resize-y !rounded-[18px]" rows={meeting ? 4 : 3} id={`${ids}-body`} value={f.body} onChange={set('body')}
        placeholder={meeting ? 'Summary and next steps' : 'Note'} aria-label={meeting ? 'Summary and next steps' : 'Note'} autoFocus={!meeting} />
      {err && <div role="alert" className="text-[12.5px] text-rose-200">{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full chip px-4 h-9 font-semibold">Cancel</button>
        <button type="submit" className="btn-primary rounded-full px-4 h-9 font-semibold">Save</button>
      </div>
    </form>
  );
}

function Entry({ e, onEdit }) {
  const { state, actions } = useStore();
  const users = useUsers();
  const own = !e.legacy && canChangeEntry(state, e);
  const notes = e.kind === 'meeting' && safeUrl(e.url);
  const Icon = e.kind === 'meeting' ? CalendarDays : StickyNote;
  const what = e.kind === 'meeting' ? e.title || 'meeting' : 'note';
  // There's no undo: ask first (as for contracts and expenses).
  const remove = () => {
    if (window.confirm(e.kind !== 'meeting' ? 'Delete this note?' : e.title ? `Delete the meeting ${e.title}?` : 'Delete this meeting?')) actions.removeEntry(e.id);
  };
  return (
    <li className="flex gap-3 rounded-2xl chip p-3">
      <Avatar userId={e.user} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] dimmer">
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className="sr-only">{e.kind === 'meeting' ? 'Meeting' : 'Note'}: </span>
            <span className="truncate">{users[e.user]?.name || 'Someone'} · {ago(e.createdAt)}</span>
          </div>
          {own && (
            <div className="-mr-1.5 -mt-1.5 flex shrink-0">
              <button type="button" onClick={() => onEdit(e)} aria-label={`Edit ${what}`} title="Edit" className={ICON}><Pencil className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={remove} aria-label={`Delete ${what}`} title="Delete" className={ICON}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          )}
        </div>
        {e.kind === 'meeting' && (
          <div className="mt-1">
            <div className="font-semibold">{e.title || 'Meeting'}{e.happenedOn && <span className="font-normal dim"> · {shortDate(e.happenedOn)}</span>}</div>
            {e.attendees && <div className="text-[12.5px] dim">{e.attendees}</div>}
          </div>
        )}
        {e.body && <p className="mt-1 whitespace-pre-wrap break-words">{e.body}</p>}
        {notes && (
          <a href={notes} target="_blank" rel="noopener noreferrer" className={cn(SMALL_BTN, 'mt-2 !h-8')}>
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />Open notes<ExternalLink className="h-3 w-3 dimmer" aria-hidden="true" />
          </a>
        )}
      </div>
    </li>
  );
}

/** A deal's or client's notes and meetings, newest first; Note and Meeting add one (Pipeline edit for a deal, Clients
 *  edit for a client); their author, or an admin, edits or deletes them. */
export function Timeline({ target }) {
  const { state, actions } = useStore();
  const [form, setForm] = useState(null); // { kind, … } new, or an entry being edited
  const list = timelineOf(state, target);
  const canAdd = canAddEntry(state, { ...target, clientId: target.clientId || state.deals.find((d) => d.id === target.dealId)?.clientId || '' });
  const save = (f) => (form.id
    ? actions.updateEntry(form.id, f) !== false
    : actions.addEntry({ ...f, ...target }) !== false);
  return (
    <section>
      <Heading actions={canAdd && !form && (
        <>
          <button type="button" onClick={() => setForm(blank('note'))} className={SMALL_BTN}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Note</button>
          <button type="button" onClick={() => setForm(blank('meeting'))} className={SMALL_BTN}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Meeting</button>
        </>
      )}>
        Timeline
      </Heading>
      {form && <EntryForm key={form.id || form.kind} initial={form} onSave={(f) => { const ok = save(f); if (ok) setForm(null); return ok; }} onCancel={() => setForm(null)} />}
      {list.length === 0 && !form && <p className="mt-1 dimmer">Nothing yet.</p>}
      <ol className="mt-3 flex flex-col gap-2.5">
        {list.map((e) => (form?.id === e.id ? null : <Entry key={e.id} e={e} onEdit={(x) => setForm({ ...x })} />))}
      </ol>
    </section>
  );
}

// ── Links ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A deal's or client's links (meeting notes, demo, deck, proposal, recording …), newest first; a client's Demo and
 *  Platform fields show here too. Add link: a label, a title and the address. */
export function Links({ target }) {
  const { state, actions } = useStore();
  const [f, setF] = useState(null);
  const [err, setErr] = useState('');
  const list = linksOf(state, target);
  const canAdd = canAddEntry(state, { ...target, clientId: target.clientId || state.deals.find((d) => d.id === target.dealId)?.clientId || '' });
  const submit = (e) => {
    e.preventDefault();
    if (!safeUrl(f.url)) { setErr('Add a web address'); return; }
    if (actions.addEntry({ kind: 'link', ...f, ...target }) === false) { setErr('Couldn’t add this link'); return; }
    setF(null);
  };
  return (
    <section>
      <Heading actions={canAdd && !f && (
        <button type="button" onClick={() => { setErr(''); setF({ label: 'Meeting notes', title: '', url: '' }); }} className={SMALL_BTN}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />Add link
        </button>
      )}>
        Links
      </Heading>
      {f && (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-2 rounded-2xl chip p-3">
          <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-2">
            <select className="field" aria-label="Kind of link" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })}>
              {LINK_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <input className="field" placeholder="Title" aria-label="Link title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={300} />
          </div>
          <input className="field" placeholder="https://" aria-label="Link address" inputMode="url" value={f.url} autoFocus
            onChange={(e) => { setErr(''); setF({ ...f, url: e.target.value }); }} />
          {err && <div role="alert" className="text-[12.5px] text-rose-200">{err}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setF(null)} className="rounded-full chip px-4 h-9 font-semibold">Cancel</button>
            <button type="submit" className="btn-primary rounded-full px-4 h-9 font-semibold">Add</button>
          </div>
        </form>
      )}
      {list.length === 0 && !f && <p className="mt-1 dimmer">No links yet.</p>}
      <ul className="mt-2 flex flex-col gap-1">
        {list.map((l) => (
          <li key={l.id} className="flex items-center gap-2 rounded-xl px-2 py-1 hover:bg-white/5">
            <Link2 className="h-4 w-4 shrink-0 dimmer" aria-hidden="true" />
            <span className="w-[104px] shrink-0 truncate text-[12px] font-semibold dim">{l.label}</span>
            <a href={safeUrl(l.url)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-semibold hover:underline">
              {l.title || l.url}<span className="sr-only"> (opens in a new tab)</span>
            </a>
            {!l.fixed && canChangeEntry(state, l) && (
              <button type="button" onClick={() => actions.removeEntry(l.id)} aria-label={`Remove link ${l.title || l.url}`} title="Remove" className={ICON}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
