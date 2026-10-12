// Clients tab: the client board / list with a recent-invoices panel, and the client drawer (Overview, Invoices,
// Billing, Usage, Access). Everything is read-only at view access.
import { useMemo, useState } from 'react';
import {
  Clock, ExternalLink, Gauge, Info, KeyRound, Landmark, LayoutGrid, List, NotebookPen, Plus, Receipt, Repeat, Trash2, UserRound,
} from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { CLIENT_GROUPS, CLIENT_STATUSES, PLAN_FREQUENCIES } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { PLAN_MONTHS, addMonths, isPlanDate } from '@/lib/automations';
import { Avatar, Drawer, KpiRow, LabelPicker, Modal, PersonPicker, QuickAdd, SearchField, Segmented } from '@/components/ui';
import { ago, compactMoney, count, fullDate, invoiceTotals, localYmd, money, money2, monthLabel, monthStart, parseAmount, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { InvoiceEditor } from './invoice';
import { Labelled, NumField, STATUS_TEXT, Switch, moneyField, owedTotals } from './shared';

const TABS = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'invoices', label: 'Invoices', icon: Receipt },
  { id: 'billing', label: 'Billing', icon: Repeat },
  { id: 'usage', label: 'Usage', icon: Gauge },
  { id: 'access', label: 'Access', icon: KeyRound },
];

// Demo links are free text: add https:// when there is no scheme, and only ever link http(s).
function safeDemoUrl(v) {
  const s = (v || '').trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

function ClientCard({ c, onOpen }) {
  const demoHref = safeDemoUrl(c.demoUrl);
  return (
    <article className="mt-3 rounded-[26px] glass glass-rim float p-5">
      <div className="flex items-start gap-3.5">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl font-bold ring-1 ring-white/40" style={{ background: c.avatar }}>{c.name[0]}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => onOpen(c.id, 'overview')} className="text-[17px] font-extrabold hover:underline text-left">{c.name}</button>
            <span className="pill !h-6 !text-[12px]" style={{ backgroundColor: CLIENT_STATUSES[c.status] }}>{c.status}</span>
          </div>
          {c.next && <p className="dim mt-0.5">{c.next}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] dimmer">
            {c.sector && <span className="inline-flex items-center gap-1.5"><Landmark className="h-3.5 w-3.5" />{c.sector}</span>}
            {c.keyContact && <span className="inline-flex items-center gap-1.5"><UserRound className="h-3.5 w-3.5" />{c.keyContact}</span>}
            <span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />{shortDate(c.lastContact)}</span>
          </div>
        </div>
        <span className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-bold', c.priority === 'P1' ? 'bg-rose-500' : 'bg-emerald-500')}>{c.priority}</span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[12.5px]">
        {demoHref && (
          <a href={demoHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full chip px-3 py-1.5 font-semibold"><ExternalLink className="h-3.5 w-3.5" />Demo</a>
        )}
        <button type="button" onClick={() => onOpen(c.id, 'invoices')} className="inline-flex items-center gap-1.5 rounded-full chip px-3 py-1.5 font-semibold" aria-label={`${c.invoices.length} invoices`}>
          <Receipt className="h-3.5 w-3.5" />{c.invoices.length}
        </button>
        <button type="button" onClick={() => onOpen(c.id, 'access')} className="inline-flex items-center gap-1.5 rounded-full chip px-3 py-1.5 font-semibold" aria-label={`${c.access.length} users with access`}>
          <KeyRound className="h-3.5 w-3.5" />{c.access.length}
        </button>
        <button type="button" onClick={() => onOpen(c.id, 'overview')} className="inline-flex items-center gap-1.5 rounded-full chip px-3 py-1.5 font-semibold"
          aria-label={c.notes.length ? `${c.notes.length} ${c.notes.length === 1 ? 'note' : 'notes'}` : 'Notes'}>
          <NotebookPen className="h-3.5 w-3.5" />{c.notes.length || 'Note'}
        </button>
        <div className="ml-auto flex -space-x-2">{c.team.map((u) => <Avatar key={u} userId={u} size={26} />)}</div>
      </div>
    </article>
  );
}

function Overview({ c, editable }) {
  const { actions } = useStore();
  const users = useUsers();
  const upd = (k) => (e) => actions.updateClient(c.id, { [k]: e.target.value });
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Status</span>
          <LabelPicker label="Status" value={c.status} options={CLIENT_STATUSES} allowEmpty={false} readOnly={!editable}
            onChange={(v) => actions.updateClient(c.id, { status: v, group: v === 'Onboarding' ? 'Onboarding' : 'Active' })} />
        </div>
        <div className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Priority</span>
          <LabelPicker label="Priority" value={c.priority} options={{ P1: '#e2445c', P2: '#10b981' }} allowEmpty={false} readOnly={!editable}
            onChange={(v) => actions.updateClient(c.id, { priority: v })} />
        </div>
        <div className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Owner</span>
          <div><PersonPicker value={c.contact} readOnly={!editable} onChange={(v) => actions.updateClient(c.id, { contact: v, team: Array.from(new Set([v, ...c.team].filter(Boolean))) })} /></div>
        </div>
      </div>
      <div className="grid gap-3">
        {[['next', 'Next step'], ['sector', 'Sector'], ['keyContact', 'Key contact'], ['email', 'Email'], ['demo', 'Demo'], ['demoUrl', 'Demo link']].map(([k, l]) => (
          <label key={k} className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">{l}</span><input className="field" value={c[k] || ''} readOnly={!editable} onChange={upd(k)} /></label>
        ))}
        <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Last contact</span><input type="date" className="field" value={c.lastContact || ''} readOnly={!editable} onChange={upd('lastContact')} /></label>
        <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">ABN</span><input className="field" inputMode="numeric" autoComplete="off" value={c.abn || ''} readOnly={!editable} onChange={upd('abn')} /></label>
        <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Billing address</span>
          <textarea className="field resize-none !rounded-[18px]" rows={3} autoComplete="off" value={c.billingAddress || ''} readOnly={!editable} onChange={upd('billingAddress')} />
        </label>
      </div>
      <section>
        <h3 className="font-bold">Tasks</h3>
        <ul className="mt-2 flex flex-col gap-1">
          {c.tasks.map((t) => (
            <li key={t.id}><label className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-white/5">
              <input type="checkbox" checked={t.done} disabled={!editable} onChange={() => actions.toggleClientTask(c.id, t.id)} className="h-4 w-4 accent-[#5fd4ff] disabled:opacity-60" />
              <span className={t.done ? 'line-through dimmer' : ''}>{t.text}</span></label></li>
          ))}
        </ul>
        {c.tasks.length === 0 && !editable && <p className="mt-1 dimmer">No tasks.</p>}
        {editable && <QuickAdd className="mt-2" placeholder="Add task" onSubmit={(t) => actions.addClientTask(c.id, t)} />}
      </section>
      <section>
        <h3 className="font-bold">Notes</h3>
        {editable && <QuickAdd className="mt-2" placeholder="Add a note" onSubmit={(t) => actions.addClientNote(c.id, t)} />}
        {c.notes.length === 0 && !editable && <p className="mt-1 dimmer">No notes.</p>}
        <ol className="mt-3 flex flex-col gap-2.5">
          {c.notes.map((n) => (
            <li key={n.id} className="flex gap-3 rounded-2xl chip p-3">
              <Avatar userId={n.user} size={28} />
              <div className="min-w-0"><div className="text-[12.5px] dimmer">{users[n.user]?.name} · {ago(n.ts)}</div><p className="mt-0.5">{n.text}</p></div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Invoices({ c, editable }) {
  const { actions } = useStore();
  return (
    <div className="flex flex-col gap-3">
      {editable && (
        <button type="button" onClick={() => actions.addInvoice(c.id)} className="btn-primary no-print self-start inline-flex items-center gap-2 rounded-full px-4 h-10 font-semibold"><Plus className="h-4 w-4" />New invoice</button>
      )}
      {c.invoices.length === 0 && <p className="dimmer no-print">No invoices yet.</p>}
      {c.invoices.map((inv) => <InvoiceEditor key={inv.id} c={c} inv={inv} />)}
    </div>
  );
}

const firstOfNextMonth = () => addMonths(monthStart(localYmd()), 1);

// A plan's next invoice date saves once it is a real day: typing a year passes through 0002, 0020 … on the way.
function PlanDate({ value, onCommit }) {
  const [text, setText] = useState(null); // what is typed, until it saves or the field loses focus
  return (
    <input type="date" min="2000-01-01" max="2099-12-31" className="field !py-1.5 !px-3 tnum" value={text ?? value}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (isPlanDate(v) && v !== value) onCommit(v);
      }}
      onBlur={() => {
        if (text === '' && value) onCommit('');
        setText(null);
      }} />
  );
}

function PlanRow({ c, p, editable }) {
  const { actions } = useStore();
  const set = (patch) => actions.updatePlan(c.id, p.id, patch);
  if (!editable) {
    return (
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl chip p-3">
        <div className="min-w-0 flex-1 basis-[180px]">
          <div className="font-semibold break-words">{p.description || 'Untitled plan'}</div>
          <div className="text-[12.5px] dimmer tnum">{money2(p.amount)} ex GST · {PLAN_FREQUENCIES[p.frequency]} · Next {fullDate(p.nextDate)}</div>
        </div>
        <span className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-bold', p.active ? 'bg-emerald-500/70' : 'bg-white/15')}>{p.active ? 'Active' : 'Paused'}</span>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-2 rounded-2xl chip p-3">
      <div className="flex items-center gap-2">
        <input className="field !py-1.5" placeholder="Description" aria-label="Plan description" value={p.description} onChange={(e) => set({ description: e.target.value })} />
        <Switch checked={p.active} label={`${p.description || 'Plan'} active`} onChange={(active) => set({ active })} />
        <button type="button" aria-label={`Delete plan ${p.description}`} title="Delete" onClick={() => actions.deletePlan(c.id, p.id)}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><Trash2 className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Labelled label="Amount (ex GST)"><NumField decimal format={moneyField} className="!py-1.5" value={p.amount} onCommit={(amount) => set({ amount })} /></Labelled>
        <Labelled label="Frequency">
          <select className="field !py-1.5" value={p.frequency} onChange={(e) => set({ frequency: e.target.value })}>
            {Object.entries(PLAN_FREQUENCIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Labelled>
        <Labelled label="Next invoice" className="col-span-2 sm:col-span-1">
          <PlanDate value={p.nextDate} onCommit={(nextDate) => set({ nextDate })} />
        </Labelled>
      </div>
    </li>
  );
}

function Billing({ c, editable }) {
  const { actions } = useStore();
  const blank = () => ({ description: '', amount: '', frequency: 'monthly', nextDate: firstOfNextMonth() });
  const [f, setF] = useState(blank);
  const plans = c.plans || [];
  const monthly = plans.filter((p) => p.active).reduce((t, p) => t + (Number(p.amount) || 0) / (PLAN_MONTHS[p.frequency] || 1), 0);
  const amount = parseAmount(f.amount);
  const badAmount = f.amount.trim() !== '' && !Number.isFinite(amount);
  const badDate = f.nextDate !== '' && !isPlanDate(f.nextDate);
  const submit = (e) => {
    e.preventDefault();
    if (!f.description.trim() || badAmount || badDate) return;
    if (actions.addPlan(c.id, { ...f, description: f.description.trim(), amount: Number.isFinite(amount) ? amount : 0 }) !== false) setF(blank());
  };
  return (
    <div className="flex flex-col gap-4">
      {plans.length > 0 && (
        <div className="flex items-baseline justify-between gap-3 rounded-2xl chip px-4 py-3">
          <span className="dim">Per month</span><span className="font-extrabold tnum">{money(monthly)} <span className="text-[12px] font-semibold dimmer">ex GST</span></span>
        </div>
      )}
      {plans.length === 0 && <p className="dimmer">No billing plans.</p>}
      <ul className="flex flex-col gap-2">{plans.map((p) => <PlanRow key={p.id} c={c} p={p} editable={editable} />)}</ul>
      {editable && (
        <form onSubmit={submit} className="grid gap-2 rounded-2xl border border-dashed border-white/25 p-3">
          <input className="field" placeholder="Plan description" aria-label="Plan description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-3">
            <Labelled label="Amount (ex GST)">
              <input className={cn('field tnum', badAmount && '!border-rose-400')} inputMode="decimal" aria-invalid={badAmount || undefined} value={f.amount}
                onChange={(e) => setF({ ...f, amount: e.target.value })} />
            </Labelled>
            <Labelled label="Frequency">
              <select className="field" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
                {Object.entries(PLAN_FREQUENCIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Labelled>
            <Labelled label="First invoice" className="col-span-2 sm:col-span-1">
              <input type="date" min="2000-01-01" max="2099-12-31" className={cn('field !px-3 tnum', badDate && '!border-rose-400')}
                aria-invalid={badDate || undefined} value={f.nextDate} onChange={(e) => setF({ ...f, nextDate: e.target.value })} />
            </Labelled>
          </div>
          <button type="submit" disabled={!f.description.trim() || badAmount || badDate} className="btn-primary justify-self-start inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold">
            <Plus className="h-4 w-4" />Add plan
          </button>
        </form>
      )}
    </div>
  );
}

const USAGE_FIELDS = [['assets', 'Assets'], ['sites', 'Sites'], ['seats', 'Seats']];

// This month back two years, plus next month, without the months the client already has.
function freeMonths(usage) {
  const have = new Set(usage.map((u) => u.month));
  const now = monthStart(localYmd());
  return Array.from({ length: 25 }, (_, i) => addMonths(now, 1 - i)).filter((m) => !have.has(m));
}

function Usage({ c, editable }) {
  const { actions } = useStore();
  const usage = c.usage || [];
  const months = freeMonths(usage);
  const now = monthStart(localYmd());
  const [month, setMonth] = useState('');
  const pick = months.includes(month) ? month : months.includes(now) ? now : months[0] || '';
  return (
    <div className="flex flex-col gap-3">
      {editable && months.length > 0 && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (pick) actions.upsertUsage(c.id, pick); }}>
          <select className="field" aria-label="Month" value={pick} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button type="submit" className="btn-primary inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 font-semibold"><Plus className="h-4 w-4" />Add month</button>
        </form>
      )}
      {usage.length === 0 && <p className="dimmer">No usage recorded.</p>}
      <ul className="flex flex-col gap-2">
        {usage.map((u) => (
          <li key={u.id} className="rounded-2xl chip p-3">
            <div className="font-bold">{monthLabel(u.month)}</div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {USAGE_FIELDS.map(([k, l]) => (editable ? (
                <Labelled key={k} label={l}><NumField format={count} className="!py-1.5" aria-label={`${l}, ${monthLabel(u.month)}`} value={u[k]} onCommit={(n) => actions.upsertUsage(c.id, u.month, { [k]: n })} /></Labelled>
              ) : (
                <div key={k} className="flex flex-col"><span className="text-[12px] dimmer">{l}</span><span className="font-extrabold tnum">{count(u[k])}</span></div>
              )))}
            </div>
            {editable ? (
              <input className="field mt-2 !py-1.5" placeholder="Notes" aria-label={`Notes, ${monthLabel(u.month)}`} value={u.notes} onChange={(e) => actions.upsertUsage(c.id, u.month, { notes: e.target.value })} />
            ) : u.notes && <p className="mt-2 text-[13px] dim">{u.notes}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Access({ c, editable }) {
  const { actions } = useStore();
  const [f, setF] = useState({ name: '', email: '', role: 'Field user' });
  return (
    <div className="flex flex-col gap-4">
      {c.access.length === 0 && <p className="dimmer">No one recorded.</p>}
      <ul className="flex flex-col gap-2">
        {c.access.map((a) => (
          <li key={a.id} className="flex items-center gap-3 rounded-2xl chip p-3">
            <div className="min-w-0 flex-1"><div className="font-semibold truncate">{a.name}</div><div className="text-[12px] dimmer truncate">{a.email}</div></div>
            <span className={cn('rounded-full px-2.5 py-1 text-[12px] font-bold', a.role === 'AssetStack' ? 'bg-[#2337EE]/60' : a.role === 'Client admin' ? 'bg-violet-500/50' : 'bg-white/15')}>{a.role}</span>
            {editable && <button type="button" aria-label={`Remove ${a.name}`} onClick={() => actions.removeAccess(c.id, a.id)} className="dimmer hover:text-white"><Trash2 className="h-4 w-4" /></button>}
          </li>
        ))}
      </ul>
      {editable && (
        <>
          <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (!f.name.trim()) return; actions.addAccess(c.id, { ...f, name: f.name.trim() }); setF({ name: '', email: '', role: 'Field user' }); }}>
            <div className="grid grid-cols-2 gap-2">
              <input className="field" placeholder="Name" aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <input className="field" placeholder="Email" aria-label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <select className="field" aria-label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option>Client admin</option><option>Field user</option><option>Viewer</option><option>AssetStack</option>
              </select>
              <button type="submit" className="btn-primary shrink-0 rounded-full px-4 font-semibold">Grant access</button>
            </div>
          </form>
          <p className="text-[12px] dimmer">Records who should have access. Granting real platform logins happens in the AssetStack product admin.</p>
        </>
      )}
    </div>
  );
}

/** `adding` / `onCloseAdd`: the page header's Add client. */
export default function ClientsTab({ adding, onCloseAdd }) {
  const { state, actions } = useStore();
  const access = useAccess();
  const editable = access.canEdit('clients');
  const [view, setView] = useState('board');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // { id, tab }
  const [newName, setNewName] = useState('');

  const clients = useMemo(() => state.clients.filter((c) => !q || `${c.name} ${c.sector} ${c.keyContact}`.toLowerCase().includes(q.toLowerCase())), [state.clients, q]);
  const totals = owedTotals(state.clients, access.isAdmin ? state.payments : []); // staff never see money in
  const recent = state.clients.flatMap((c) => c.invoices.map((i) => ({ ...i, client: c })))
    .sort((a, b) => b.issued.localeCompare(a.issued)).slice(0, 6);
  const current = open ? state.clients.find((c) => c.id === open.id) : null;

  return (
    <div>
      <KpiRow items={[
        { value: state.clients.length, label: 'Clients', tint: '#475569' },
        { value: state.clients.filter((c) => c.group === 'Onboarding').length, label: 'Onboarding', tint: '#7c3aed' },
        { value: state.clients.filter((c) => c.group === 'Active').length, label: 'Active', tint: '#0f9f6f' },
        { value: compactMoney(totals.outstanding), label: 'Owed', tint: '#f59e0b' },
      ]} />
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Segmented label="Layout" value={view} onChange={setView} options={[{ id: 'board', label: 'Board', icon: LayoutGrid }, { id: 'list', label: 'List', icon: List }]} />
        <SearchField value={q} onChange={setQ} placeholder="Search clients" />
      </div>

      <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {view === 'board' ? CLIENT_GROUPS.map((g, gi) => {
            const list = clients.filter((c) => c.group === g.key);
            return (
              <section key={g.key} className={gi ? 'mt-8' : ''}>
                <div className="flex items-center gap-2 font-extrabold text-[15px]">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.dot, boxShadow: `0 0 12px ${g.dot}` }} />{g.label}<span className="dimmer text-[12px]">{list.length}</span>
                </div>
                {list.map((c) => <ClientCard key={c.id} c={c} onOpen={(id, tab) => setOpen({ id, tab })} />)}
              </section>
            );
          }) : (
            <div className="overflow-x-auto scroll-thin rounded-[24px] glass">
              <table className="w-full min-w-[640px] text-[13.5px]">
                <thead><tr className="text-left text-[12px] dimmer"><th className="p-3 font-medium">Client</th><th className="p-3 font-medium w-[150px]">Status</th><th className="p-3 font-medium">Sector</th><th className="p-3 font-medium">Next step</th><th className="p-3 font-medium">Priority</th></tr></thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.id} className="border-t rowline hover:bg-white/5 cursor-pointer" onClick={() => setOpen({ id: c.id, tab: 'overview' })}>
                      <td className="p-3 font-semibold">
                        <button type="button" onClick={(e) => { e.stopPropagation(); setOpen({ id: c.id, tab: 'overview' }); }} className="text-left hover:underline">{c.name}</button>
                      </td>
                      <td className="p-2"><span className="pill" style={{ backgroundColor: CLIENT_STATUSES[c.status] }}>{c.status}</span></td>
                      <td className="p-3 dim">{c.sector}</td>
                      <td className="p-3 dim">{c.next}</td>
                      <td className="p-3 font-bold">{c.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <aside className="min-w-0">
          <div className="rounded-[26px] glass glass-rim p-5">
            <div className="font-extrabold text-[16px]">Invoices</div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[[totals.outstanding, 'Owed', 'text-sky-100'], [totals.overdue, 'Overdue', 'text-rose-200'], [totals.paid, 'Paid', 'text-emerald-200']].map(([v, l, cl]) => (
                <div key={l} className="rounded-2xl chip px-1 py-2"><div className={cn('font-black tnum', cl)}>{compactMoney(v)}</div><div className="text-[11.5px] dimmer">{l}</div></div>
              ))}
            </div>
            <ul className="mt-3">
              {recent.map((i) => (
                <li key={i.id}>
                  <button type="button" onClick={() => setOpen({ id: i.client.id, tab: 'invoices' })} className="flex w-full items-center justify-between gap-3 border-t rowline py-3 text-left">
                    <div className="min-w-0"><div className="font-semibold truncate">{i.client.name}</div><div className="text-[12px] dimmer tnum">{i.number}</div></div>
                    <div className="shrink-0 text-right"><div className="font-bold tnum">{money(invoiceTotals(i).total)}</div>
                      <span className="text-[11.5px] font-bold" style={{ color: STATUS_TEXT[i.status] }}>{i.status}</span></div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      <Drawer open={!!current} onClose={() => setOpen(null)} title={current?.name || ''} width={560}>
        {current && (
          <>
            <div className="mb-5 no-print"><Segmented label="Client sections" value={open.tab} onChange={(tab) => setOpen({ ...open, tab })} options={TABS} /></div>
            {open.tab === 'overview' && <Overview c={current} editable={editable} />}
            {open.tab === 'invoices' && <Invoices c={current} editable={editable} />}
            {open.tab === 'billing' && <Billing c={current} editable={editable} />}
            {open.tab === 'usage' && <Usage c={current} editable={editable} />}
            {open.tab === 'access' && <Access c={current} editable={editable} />}
          </>
        )}
      </Drawer>

      <Modal open={adding && editable} onClose={onCloseAdd} title="Add client">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) { actions.addClient(newName.trim()); setNewName(''); onCloseAdd(); } }}>
          <input className="field" placeholder="Organisation name" aria-label="Organisation name" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          <button type="submit" className="btn-primary shrink-0 rounded-full px-5 font-semibold">Add</button>
        </form>
      </Modal>
    </div>
  );
}
