import { Fragment, useMemo, useRef, useState } from 'react';
import { Clock, ExternalLink, KeyRound, Landmark, LayoutGrid, List, NotebookPen, Plus, Printer, Receipt, Trash2, UserRound } from 'lucide-react';
import { useIsAdmin, useStore, useUsers } from '@/data/store';
import { CLIENT_GROUPS, CLIENT_STATUSES, INVOICE_STATUS } from '@/data/boards';
import { Avatar, Drawer, KpiRow, LabelPicker, Modal, PageHeader, PersonPicker, QuickAdd, SearchField, Segmented } from '@/components/ui';
import {
  ago, compactMoney, daysBetween, formatAbn, formatBsb, fullDate, invoiceTotals, isBadAmount, money, money2, parseAmount, shortDate, unitMoney,
} from '@/lib/format';
import { cn } from '@/lib/cn';

const TABS = [{ id: 'overview', label: 'Overview' }, { id: 'invoices', label: 'Invoices' }, { id: 'access', label: 'Access' }];

function owed(clients) {
  let outstanding = 0, overdue = 0, paid = 0;
  clients.forEach((c) => c.invoices.forEach((i) => {
    const { total } = invoiceTotals(i);
    if (i.status === 'Sent') outstanding += total;
    if (i.status === 'Overdue') { overdue += total; outstanding += total; }
    if (i.status === 'Paid') paid += total;
  }));
  return { outstanding, overdue, paid };
}

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
          aria-label={c.notes.length ? `${c.notes.length} ${c.notes.length === 1 ? 'note' : 'notes'}` : 'Add note'}>
          <NotebookPen className="h-3.5 w-3.5" />{c.notes.length || 'Note'}
        </button>
        <div className="ml-auto flex -space-x-2">{c.team.map((u) => <Avatar key={u} userId={u} size={26} />)}</div>
      </div>
    </article>
  );
}

function Overview({ c }) {
  const { actions } = useStore();
  const users = useUsers();
  const upd = (k) => (e) => actions.updateClient(c.id, { [k]: e.target.value });
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Status</span>
          <LabelPicker label="Status" value={c.status} options={CLIENT_STATUSES} allowEmpty={false} onChange={(v) => actions.updateClient(c.id, { status: v, group: v === 'Onboarding' ? 'Onboarding' : 'Active' })} />
        </div>
        <div className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Priority</span>
          <LabelPicker label="Priority" value={c.priority} options={{ P1: '#e2445c', P2: '#10b981' }} allowEmpty={false} onChange={(v) => actions.updateClient(c.id, { priority: v })} />
        </div>
        <div className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Owner</span>
          <div><PersonPicker value={c.contact} onChange={(v) => actions.updateClient(c.id, { contact: v, team: Array.from(new Set([v, ...c.team].filter(Boolean))) })} /></div>
        </div>
      </div>
      <div className="grid gap-3">
        {[['next', 'Next step'], ['sector', 'Sector'], ['keyContact', 'Key contact'], ['email', 'Email'], ['demo', 'Demo'], ['demoUrl', 'Demo link']].map(([k, l]) => (
          <label key={k} className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">{l}</span><input className="field" value={c[k] || ''} onChange={upd(k)} /></label>
        ))}
        <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Last contact</span><input type="date" className="field" value={c.lastContact || ''} onChange={upd('lastContact')} /></label>
        <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">ABN</span><input className="field" inputMode="numeric" autoComplete="off" value={c.abn || ''} onChange={upd('abn')} /></label>
        <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Billing address</span>
          <textarea className="field resize-none !rounded-[18px]" rows={3} autoComplete="off" value={c.billingAddress || ''} onChange={upd('billingAddress')} />
        </label>
      </div>
      <section>
        <h3 className="font-bold">Tasks</h3>
        <ul className="mt-2 flex flex-col gap-1">
          {c.tasks.map((t) => (
            <li key={t.id}><label className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-white/5">
              <input type="checkbox" checked={t.done} onChange={() => actions.toggleClientTask(c.id, t.id)} className="h-4 w-4 accent-[#5fd4ff]" />
              <span className={t.done ? 'line-through dimmer' : ''}>{t.text}</span></label></li>
          ))}
        </ul>
        <QuickAdd className="mt-2" placeholder="Add task" onSubmit={(t) => actions.addClientTask(c.id, t)} />
      </section>
      <section>
        <h3 className="font-bold">Notes</h3>
        <QuickAdd className="mt-2" placeholder="Add a note" onSubmit={(t) => actions.addClientNote(c.id, t)} />
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

const str = (v) => String(v ?? '').trim();

// The printed copy (Print / PDF): an Australian tax invoice. Hidden on screen and in an ordinary browser print;
// shown only for its own Print / PDF (html.printing-invoice in index.css, which also styles .tax-invoice).
function TaxInvoice({ c, inv, org, t }) {
  const abn = str(org.abn);
  const kind = abn ? 'Tax invoice' : 'Invoice'; // without the supplier's ABN it isn't a valid tax invoice
  // Terms come from the invoice's own dates, so the printed copy can't contradict itself if Settings change later.
  const orgDays = parseInt(org.paymentTermsDays, 10);
  const days = daysBetween(inv.issued, inv.due) ?? (orgDays >= 0 ? orgDays : 30);
  const contact = [str(org.email), str(org.phone)].filter(Boolean).join(' · ');
  const bank = [['Account name', str(org.bankAccountName)], ['BSB', formatBsb(org.bsb)], ['Account number', str(org.accountNumber)]].filter(([, v]) => v);
  return (
    <div className="tax-invoice hidden">
      <header className="ti-row">
        <h1>{inv.status === 'Draft' ? `Draft ${kind.toLowerCase()}` : kind}</h1>
        <div className="ti-supplier">
          <div className="ti-name">{str(org.businessName) || 'AssetStack'}</div>
          {abn && <div>ABN {formatAbn(abn)}</div>}
          {str(org.address) && <div className="ti-pre">{str(org.address)}</div>}
          {contact && <div>{contact}</div>}
        </div>
      </header>
      <section className="ti-row ti-parties">
        <div>
          <h2>Bill to</h2>
          <div className="ti-name">{c.name}</div>
          {str(c.abn) && <div>ABN {formatAbn(c.abn)}</div>}
          {str(c.billingAddress) && <div className="ti-pre">{str(c.billingAddress)}</div>}
        </div>
        <dl className="ti-meta">
          <dt>Invoice number</dt><dd>{inv.number}</dd>
          <dt>Issue date</dt><dd>{fullDate(inv.issued)}</dd>
          <dt>Due date</dt><dd>{fullDate(inv.due)}</dd>
          {(inv.status === 'Paid' || inv.status === 'Overdue') && <><dt>Status</dt><dd>{inv.status}</dd></>}
        </dl>
      </section>
      <table className="ti-lines">
        <thead>
          <tr><th>Description</th><th className="num">Qty</th><th className="num">Unit price (ex GST)</th><th className="num">GST</th><th className="num">Amount (inc GST)</th></tr>
        </thead>
        <tbody>
          {inv.lines.map((l, i) => (
            <tr key={l.id}>
              <td className="ti-pre">{l.desc}</td><td className="num">{str(l.qty)}</td><td className="num">{unitMoney(parseAmount(l.rate) || 0)}</td>
              <td className="num">{money2(t.lines[i].gst)}</td><td className="num">{money2(t.lines[i].inc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="ti-totals">
        <tbody>
          <tr><th>Subtotal (ex GST)</th><td className="num">{money2(t.subtotal)}</td></tr>
          <tr><th>GST 10%</th><td className="num">{money2(t.gst)}</td></tr>
          <tr className="ti-total"><th>Total (inc GST)</th><td className="num">{money2(t.total)}</td></tr>
        </tbody>
      </table>
      <p className="ti-gst-note">Total includes GST of {money2(t.gst)}</p>
      <section className="ti-pay">
        <h2>Payment</h2>
        <dl className="ti-meta">
          {bank.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
          <dt>Reference</dt><dd>{inv.number}</dd>
          <dt>Terms</dt><dd>{days === 0 ? 'Due on receipt' : `Due in ${days} ${days === 1 ? 'day' : 'days'}`}</dd>
        </dl>
      </section>
    </div>
  );
}

function InvoiceEditor({ c, inv }) {
  const { state, actions } = useStore();
  const isAdmin = useIsAdmin();
  const ref = useRef(null);
  const org = state.org || {};
  const t = invoiceTotals(inv);
  // An amount that doesn't parse counts as $0, so the printed copy would contradict its own totals.
  const badAmounts = inv.lines.some((l) => isBadAmount(l.qty) || isBadAmount(l.rate));
  // Print just this invoice: flag it and the page for the print CSS, and clear the flags afterwards.
  // (A data attribute, so React's className updates can't drop it mid-print.)
  const printThis = () => {
    const el = ref.current;
    if (!el || badAmounts) return;
    el.setAttribute('data-print-target', '');
    document.documentElement.classList.add('printing-invoice');
    window.addEventListener('afterprint', () => {
      el.removeAttribute('data-print-target');
      document.documentElement.classList.remove('printing-invoice');
    }, { once: true });
    window.print();
  };
  return (
    <div ref={ref} className="invoice-card rounded-2xl chip p-4">
      <div className="no-print">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-extrabold">{inv.number}</div>
            <div className="text-[12px] dimmer">{c.name} · Issued {fullDate(inv.issued)} · Due {fullDate(inv.due)}</div>
          </div>
          <div className="w-[120px]">
            <LabelPicker label={`${inv.number} status`} value={inv.status} options={INVOICE_STATUS} allowEmpty={false} onChange={(v) => actions.updateInvoice(c.id, inv.id, { status: v })} />
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {inv.lines.map((l) => (
            <div key={l.id} className="grid grid-cols-[1fr_56px_96px_28px] gap-2 items-center">
              <input className="field !py-1.5" placeholder="Description" aria-label="Description" value={l.desc} onChange={(e) => actions.updateInvoiceLine(c.id, inv.id, l.id, { desc: e.target.value })} />
              <input className={cn('field !py-1.5 !px-2 text-right tnum', isBadAmount(l.qty) && '!border-rose-400')} aria-label="Quantity" aria-invalid={isBadAmount(l.qty) || undefined} inputMode="decimal" value={l.qty} onChange={(e) => actions.updateInvoiceLine(c.id, inv.id, l.id, { qty: e.target.value })} />
              <input className={cn('field !py-1.5 !px-2 text-right tnum', isBadAmount(l.rate) && '!border-rose-400')} aria-label="Rate (ex GST)" aria-invalid={isBadAmount(l.rate) || undefined} inputMode="decimal" value={l.rate} onChange={(e) => actions.updateInvoiceLine(c.id, inv.id, l.id, { rate: e.target.value })} />
              <button type="button" aria-label="Remove line" onClick={() => actions.removeInvoiceLine(c.id, inv.id, l.id)} className="dimmer hover:text-white"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <button type="button" onClick={() => actions.addInvoiceLine(c.id, inv.id)} className="self-start inline-flex items-center gap-1.5 rounded-full chip px-3 py-1 text-[12.5px]"><Plus className="h-3.5 w-3.5" />Line</button>
        </div>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 text-[13px] tnum">
          <dt className="dimmer">Subtotal</dt><dd className="text-right">{money2(t.subtotal)}</dd>
          <dt className="dimmer">GST 10%</dt><dd className="text-right">{money2(t.gst)}</dd>
          <dt className="font-bold">Total</dt><dd className="text-right font-extrabold">{money2(t.total)}</dd>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" onClick={printThis} disabled={badAmounts} title={badAmounts ? 'Fix the highlighted amounts first' : undefined} className="inline-flex items-center gap-1.5 rounded-full chip px-3 py-1.5 text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"><Printer className="h-3.5 w-3.5" />Print / PDF</button>
          {!str(org.abn) && (isAdmin
            ? <a href="#/settings?tab=business" className="text-[12px] text-amber-200 underline underline-offset-2 hover:text-white">Add your ABN in Settings to issue tax invoices</a>
            : <span className="text-[12px] text-amber-200">Ask an admin to add the ABN in Settings to issue tax invoices</span>)}
        </div>
      </div>
      <TaxInvoice c={c} inv={inv} org={org} t={t} />
    </div>
  );
}

function Invoices({ c }) {
  const { actions } = useStore();
  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={() => actions.addInvoice(c.id)} className="btn-primary no-print self-start inline-flex items-center gap-2 rounded-full px-4 h-10 font-semibold"><Plus className="h-4 w-4" />New invoice</button>
      {c.invoices.length === 0 && <p className="dimmer no-print">No invoices yet.</p>}
      {c.invoices.map((inv) => <InvoiceEditor key={inv.id} c={c} inv={inv} />)}
    </div>
  );
}

function Access({ c }) {
  const { actions } = useStore();
  const [f, setF] = useState({ name: '', email: '', role: 'Field user' });
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {c.access.map((a) => (
          <li key={a.id} className="flex items-center gap-3 rounded-2xl chip p-3">
            <div className="min-w-0 flex-1"><div className="font-semibold truncate">{a.name}</div><div className="text-[12px] dimmer truncate">{a.email}</div></div>
            <span className={cn('rounded-full px-2.5 py-1 text-[12px] font-bold', a.role === 'AssetStack' ? 'bg-[#2337EE]/60' : a.role === 'Client admin' ? 'bg-violet-500/50' : 'bg-white/15')}>{a.role}</span>
            <button type="button" aria-label={`Remove ${a.name}`} onClick={() => actions.removeAccess(c.id, a.id)} className="dimmer hover:text-white"><Trash2 className="h-4 w-4" /></button>
          </li>
        ))}
      </ul>
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
    </div>
  );
}

export default function Clients() {
  const { state, actions } = useStore();
  const [view, setView] = useState('board');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // { id, tab }
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const clients = useMemo(() => state.clients.filter((c) => !q || `${c.name} ${c.sector} ${c.keyContact}`.toLowerCase().includes(q.toLowerCase())), [state.clients, q]);
  const totals = owed(state.clients);
  const allInvoices = state.clients.flatMap((c) => c.invoices.map((i) => ({ ...i, client: c })))
    .sort((a, b) => b.issued.localeCompare(a.issued)).slice(0, 6);
  const current = open ? state.clients.find((c) => c.id === open.id) : null;

  return (
    <div>
      <PageHeader title="Clients" action="Add client" onAction={() => setAdding(true)} />
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
              {allInvoices.map((i) => (
                <li key={i.id}>
                  <button type="button" onClick={() => setOpen({ id: i.client.id, tab: 'invoices' })} className="flex w-full items-center justify-between gap-3 border-t rowline py-3 text-left">
                    <div className="min-w-0"><div className="font-semibold truncate">{i.client.name}</div><div className="text-[12px] dimmer tnum">{i.number}</div></div>
                    <div className="text-right"><div className="font-bold tnum">{money(invoiceTotals(i).total)}</div>
                      <span className="text-[11.5px] font-bold" style={{ color: { Paid: '#86efac', Overdue: '#fecdd3', Sent: '#bae6fd', Draft: '#e2e8f0' }[i.status] }}>{i.status}</span></div>
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
            {open.tab === 'overview' && <Overview c={current} />}
            {open.tab === 'invoices' && <Invoices c={current} />}
            {open.tab === 'access' && <Access c={current} />}
          </>
        )}
      </Drawer>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add client">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) { actions.addClient(newName.trim()); setNewName(''); setAdding(false); } }}>
          <input className="field" placeholder="Organisation name" aria-label="Organisation name" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          <button type="submit" className="btn-primary shrink-0 rounded-full px-5 font-semibold">Add</button>
        </form>
      </Modal>
    </div>
  );
}
