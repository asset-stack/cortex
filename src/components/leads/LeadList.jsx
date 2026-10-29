// Leads → Lists (docs/PHASE2.md §23): one list (or all) with search and filters, flags on each lead (suppressed, already
// in the CRM, a repeat), a bulk status change, and Export for agent: the leads ready to send as the agent's CSV, marked
// Sent to agent.
import { useMemo, useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { LEAD_STATUSES, agentCsv, leadFlags, sendable } from '@/lib/leads';
import { localYmd } from '@/lib/format';
import { ConfirmModal, InlineRename, SearchField } from '@/components/ui';
import { OpenLink, Pill } from '@/components/crm/bits';
import { cn } from '@/lib/cn';
import { StatusPill } from './LeadProfile';

const SMALL_BTN = 'inline-flex h-10 items-center gap-1.5 rounded-full chip px-4 text-[13px] font-semibold';
const SELECT = 'field !h-10 !w-auto !rounded-full !py-0';
const ALL = '';
const SHOW = { '': 'All leads', ready: 'Ready for agent', suppressed: 'Suppressed', crm: 'In CRM', repeat: 'Repeats' };
const text = (l) => [l.name, l.title, l.email, l.company, l.domain, l.sector, l.country, l.region].join(' ').toLowerCase();

function Flags({ f }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {f.suppressed && <Pill className="bg-rose-700/70" title={f.suppressed}>Suppressed</Pill>}
      {f.person && f.lead.status !== 'converted' && <Pill className="bg-emerald-700/70" title={f.account?.name}>In CRM</Pill>}
      {!f.person && f.account && f.lead.status !== 'converted' && <Pill className="chip" title={f.account.name}>Account in CRM</Pill>}
      {f.duplicate && <Pill className="bg-amber-500/80 text-black">Repeat</Pill>}
    </span>
  );
}

function download(name, body) {
  const href = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export default function LeadList({ listId, onList, onOpen }) {
  const { state, actions } = useStore();
  const access = useAccess();
  const editable = access.canEdit('outreach');
  const lists = state.leadLists || [];
  const list = lists.find((l) => l.id === listId) || null;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [show, setShow] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exported, setExported] = useState(null);

  const inList = useMemo(() => (state.leads || []).filter((l) => listId === ALL || l.listId === listId), [state.leads, listId]);
  const flags = useMemo(() => leadFlags(state, inList), [state, inList]);
  const term = q.trim().toLowerCase();
  const rows = flags.filter((f) => (!term || text(f.lead).includes(term)) && (!status || f.lead.status === status)
    && (!show || (show === 'ready' ? sendable(f) : show === 'suppressed' ? f.suppressed : show === 'crm' ? f.person || f.account : f.duplicate)));
  const ready = flags.filter(sendable);
  const shownIds = rows.map((f) => f.lead.id);
  const chosen = shownIds.filter((id) => picked.has(id));
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setPicked(chosen.length === shownIds.length ? new Set() : new Set(shownIds));

  const exportReady = () => {
    if (!ready.length) return;
    const name = `${(list?.name || 'leads').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'leads'}-${localYmd()}.csv`;
    download(name, agentCsv(ready.map((f) => f.lead)));
    const n = editable ? actions.setLeadsStatus(ready.filter((f) => f.lead.status === 'new').map((f) => f.lead.id), 'queued') || 0 : 0;
    setExported({ count: ready.length, marked: n });
  };

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <select className={SELECT} aria-label="List" value={listId} onChange={(e) => { onList(e.target.value); setPicked(new Set()); setExported(null); }}>
          <option value={ALL}>All lists</option>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {list && editable && !renaming && (
          <>
            <button type="button" className={SMALL_BTN} onClick={() => setRenaming(true)}>Rename</button>
            <button type="button" className={SMALL_BTN} aria-label="Delete list" title="Delete list" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
          </>
        )}
        {list && renaming && (
          <InlineRename value={list.name} label="List name" className="field !h-10 !w-auto"
            onSave={(name) => actions.updateLeadList(list.id, { name })} onDone={() => setRenaming(false)} />
        )}
        <button type="button" onClick={exportReady} disabled={!ready.length}
          className="btn-primary ml-auto inline-flex h-10 items-center gap-2 rounded-full px-4 text-[13px] font-semibold disabled:opacity-50">
          <Download className="h-4 w-4" aria-hidden="true" />Export for agent<span className="tnum">({ready.length})</span>
        </button>
      </div>
      {list?.notes && <p className="mt-2 text-[13px] dim">{list.notes}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Search leads" />
        <select className={SELECT} aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {Object.entries(LEAD_STATUSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className={SELECT} aria-label="Show" value={show} onChange={(e) => setShow(e.target.value)}>
          {Object.entries(SHOW).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div role="status">
        {exported && (
          <p className="mt-3 rounded-2xl glass px-4 py-2.5 text-[13px] font-semibold">
            Exported {exported.count}{exported.marked ? `, ${exported.marked} marked Sent to agent` : ''}
          </p>
        )}
      </div>
      {editable && chosen.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl glass px-4 py-2">
          <span className="text-[13px] font-semibold tnum">{chosen.length} selected</span>
          <select className={SELECT} aria-label="Set status" value="" onChange={(e) => { if (e.target.value) { actions.setLeadsStatus(chosen, e.target.value); setPicked(new Set()); } }}>
            <option value="">Set status</option>
            {Object.entries(LEAD_STATUSES).filter(([k]) => k !== 'converted').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button type="button" className={cn(SMALL_BTN, 'ml-auto text-rose-200')} onClick={() => { actions.removeLeads(chosen); setPicked(new Set()); }}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />Remove
          </button>
        </div>
      )}

      {!rows.length ? <p className="mt-6 dimmer">{inList.length ? 'No matches.' : lists.length ? 'No leads on this list.' : 'No lists yet.'}</p> : (
        <div className="mt-4 rounded-[24px] glass">
          <div className="hidden overflow-x-auto scroll-thin md:block">
            <table className="w-full min-w-[960px] text-[13px]">
              <thead>
                <tr className="text-left text-[12px] dimmer">
                  {editable && (
                    <th className="w-10 py-2.5 pl-5">
                      <input type="checkbox" className="h-4 w-4 accent-white" aria-label="Select all" checked={chosen.length === shownIds.length} onChange={toggleAll} />
                    </th>
                  )}
                  <th className={cn('px-3 py-2.5 font-medium', !editable && 'pl-5')}>Name</th>
                  <th className="px-3 py-2.5 font-medium">Company</th>
                  <th className="px-3 py-2.5 font-medium">Email</th>
                  <th className="px-3 py-2.5 font-medium">Location</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 pr-5 font-medium"><span className="sr-only">Flags</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  const l = f.lead;
                  return (
                    <tr key={l.id} className="border-t rowline align-middle hover:bg-white/5">
                      {editable && (
                        <td className="py-2.5 pl-5"><input type="checkbox" className="h-4 w-4 accent-white" aria-label={`Select ${l.name || l.email}`} checked={picked.has(l.id)} onChange={() => toggle(l.id)} /></td>
                      )}
                      <td className={cn('max-w-[240px] px-3 py-2.5', !editable && 'pl-5')}>
                        <OpenLink onClick={() => onOpen(l.id)} className="block">{l.name || l.email}</OpenLink>
                        {l.title && <div className="truncate text-[12px] dimmer">{l.title}</div>}
                      </td>
                      <td className="max-w-[200px] px-3 py-2.5">
                        <div className="truncate">{l.company || '—'}</div>
                        {l.sector && <div className="truncate text-[12px] dimmer">{l.sector}</div>}
                      </td>
                      <td className="max-w-[220px] truncate px-3 py-2.5 dim">{l.email || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 dim">{[l.region, l.country].filter(Boolean).join(', ') || '—'}</td>
                      <td className="px-3 py-2.5"><StatusPill value={l.status} /></td>
                      <td className="px-3 py-2.5 pr-5"><Flags f={f} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col md:hidden">
            {rows.map((f) => {
              const l = f.lead;
              return (
                <li key={l.id} className="flex items-start gap-3 border-t rowline px-4 py-3 first:border-t-0">
                  {editable && <input type="checkbox" className="mt-1 h-4 w-4 accent-white" aria-label={`Select ${l.name || l.email}`} checked={picked.has(l.id)} onChange={() => toggle(l.id)} />}
                  <div className="min-w-0 flex-1">
                    <OpenLink onClick={() => onOpen(l.id)}>{l.name || l.email}</OpenLink>
                    <div className="mt-0.5 truncate text-[12.5px] dim">{[l.title, l.company].filter(Boolean).join(' · ')}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1"><StatusPill value={l.status} /><Flags f={f} /></div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {list && (
        <ConfirmModal open={deleting} onClose={() => setDeleting(false)} title={`Delete ${list.name}?`}
          onConfirm={() => { actions.removeLeadList(list.id); onList(ALL); }}>
          {`Its ${inList.length} lead${inList.length === 1 ? ' is' : 's are'} deleted too.`}
        </ConfirmModal>
      )}
    </div>
  );
}
