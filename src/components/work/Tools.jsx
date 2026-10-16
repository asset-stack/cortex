import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { safeUrl } from '@/lib/format';
import { TOOL_PRESETS } from '@/lib/tools';
import { cn } from '@/lib/cn';

const TILE = ['#579bfc', '#a78bfa', '#00c875', '#fdab3d', '#ff7575', '#21b8b0', '#ff5ac4'];
const tileColour = (name) => TILE[[...String(name)].reduce((n, ch) => n + ch.charCodeAt(0), 0) % TILE.length];
const ICON = 'grid h-7 w-7 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white disabled:opacity-30';
const BLANK = { name: '', url: '', username: '', how: '', notes: '' };

/** Add or edit one tool. New ones can start from a preset (name, link and how to sign in). */
function ToolForm({ tool, person, taken, onSave, onCancel }) {
  const [form, setForm] = useState(tool || BLANK);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const presets = TOOL_PRESETS.filter((p) => !taken.includes(p.name.toLowerCase()));
  const pick = (e) => {
    const p = TOOL_PRESETS.find((x) => x.name === e.target.value);
    if (p) setForm((f) => ({ ...f, ...p, username: f.username || person?.email || '' }));
  };
  const submit = (e) => {
    e.preventDefault();
    if (form.name.trim() || form.url.trim()) onSave(form);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-2xl chip p-3">
      {!tool && presets.length > 0 && (
        <select defaultValue="" onChange={pick} aria-label="Preset" className="field">
          <option value="" disabled>Preset</option>
          {presets.map((p) => <option key={p.name}>{p.name}</option>)}
        </select>
      )}
      <input className="field" value={form.name} onChange={set('name')} placeholder="Name" aria-label="Name" autoFocus={Boolean(tool)} />
      <input className="field" value={form.url} onChange={set('url')} placeholder="Link" aria-label="Link" inputMode="url" />
      <input className="field" value={form.username} onChange={set('username')} placeholder="Username or login email" aria-label="Username" />
      <input className="field" value={form.how} onChange={set('how')} placeholder="How to sign in" aria-label="How to sign in" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full chip px-4 py-1.5 text-[13px] font-semibold">Cancel</button>
        <button type="submit" disabled={!form.name.trim() && !form.url.trim()}
          className="btn-primary rounded-full px-4 py-1.5 text-[13px] font-semibold disabled:opacity-50">Save</button>
      </div>
    </form>
  );
}

function ToolRow({ tool, editable, first, last, onEdit }) {
  const { actions } = useStore();
  const [copied, setCopied] = useState(false);
  const href = safeUrl(tool.url);
  const name = tool.name || tool.url;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tool.username);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the username is on screen to select */ }
  };
  return (
    <li className="flex gap-3 rounded-2xl p-2 hover:bg-white/[.06]">
      <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[15px] font-extrabold text-white"
        style={{ backgroundColor: tileColour(name) }}>{name.trim().charAt(0).toUpperCase() || '?'}</span>
      <div className="min-w-0 flex-1">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 font-semibold hover:underline">
            <span className="truncate">{name}</span><ExternalLink className="h-3.5 w-3.5 shrink-0 dimmer" aria-hidden="true" />
          </a>
        ) : <div className="truncate font-semibold">{name}</div>}
        {tool.username && (
          <div className="flex min-w-0 items-center gap-1 text-[12.5px] dim">
            <span className="truncate">{tool.username}</span>
            <button type="button" onClick={copy} aria-label={`Copy ${name} username`} title="Copy" className="grid h-6 w-6 shrink-0 place-items-center rounded-full hover:bg-white/10">
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}
        {tool.how && <div className="text-[12px] dimmer">{tool.how}</div>}
      </div>
      {editable && (
        <div className="flex shrink-0 items-start">
          <button type="button" onClick={() => actions.moveTool(tool.id, -1)} disabled={first} aria-label={`Move ${name} up`} className={ICON}><ChevronUp className="h-4 w-4" /></button>
          <button type="button" onClick={() => actions.moveTool(tool.id, 1)} disabled={last} aria-label={`Move ${name} down`} className={ICON}><ChevronDown className="h-4 w-4" /></button>
          <button type="button" onClick={onEdit} aria-label={`Edit ${name}`} className={ICON}><Pencil className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => actions.removeTool(tool.id)} aria-label={`Remove ${name}`} className={ICON}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </li>
  );
}

/** `person`'s logins and links (Gmail, Apollo, Claude…). Their own to edit, or anyone's for admins; no passwords. */
export default function Tools({ person }) {
  const { state, actions } = useStore();
  const { isAdmin } = useAccess();
  const [editing, setEditing] = useState(null); // a tool id, 'new' or null
  if (!person) return null;
  const editable = person.id === state.me || isAdmin;
  const tools = state.tools.filter((t) => t.user === person.id);
  const taken = tools.map((t) => t.name.trim().toLowerCase());
  const add = (form) => { if (actions.addTool(person.id, form) !== false) setEditing(null); };
  const save = (id) => (form) => { actions.updateTool(id, form); setEditing(null); };

  return (
    <section className="glass glass-rim self-start rounded-[24px] p-5" aria-label="Tools">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-extrabold text-[16px]"><KeyRound className="h-4 w-4" aria-hidden="true" />Tools</h2>
        {editable && editing !== 'new' && (
          <button type="button" onClick={() => setEditing('new')} aria-label="Add tool" title="Add"
            className="grid h-8 w-8 place-items-center rounded-full chip"><Plus className="h-4 w-4" /></button>
        )}
      </div>
      {tools.length === 0 && editing !== 'new' && <p className="mt-3 dimmer">No tools yet.</p>}
      <ul className={cn('flex flex-col gap-1', tools.length > 0 && 'mt-3')}>
        {tools.map((t, i) => (editing === t.id ? (
          <li key={t.id}>
            <ToolForm tool={t} person={person} taken={taken} onSave={save(t.id)} onCancel={() => setEditing(null)} />
          </li>
        ) : (
          <ToolRow key={t.id} tool={t} editable={editable} first={i === 0} last={i === tools.length - 1} onEdit={() => setEditing(t.id)} />
        )))}
      </ul>
      {editing === 'new' && (
        <div className="mt-3"><ToolForm person={person} taken={taken} onSave={add} onCancel={() => setEditing(null)} /></div>
      )}
    </section>
  );
}
