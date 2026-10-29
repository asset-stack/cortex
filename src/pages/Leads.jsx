// Leads (docs/PHASE2.md §23, 0016): prospect lists imported from a CSV export (Apollo, LinkedIn, HubSpot …), checked
// against the suppress list and the CRM, with each lead's contact history; Export for agent hands the ready ones to the
// outreach agent, Convert to CRM makes one an account and contact. The suppress list, and a scoreboard of how each sector
// and country answers. Outreach view reads it all; Outreach edit changes it; Convert to CRM also needs Pipeline edit.
import { useEffect, useState } from 'react';
import { BarChart3, Ban, ListChecks, Trash2 } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { useAccess } from '@/lib/access';
import { hashParam } from '@/lib/router';
import { SUPPRESSION_KINDS, cleanSuppression, scoreboard } from '@/lib/leads';
import { shortDate } from '@/lib/format';
import { Modal, PageHeader, Segmented } from '@/components/ui';
import { Pill } from '@/components/crm/bits';
import Import from '@/components/settings/Import';
import LeadList from '@/components/leads/LeadList';
import LeadProfile from '@/components/leads/LeadProfile';

const TABS = [
  { id: 'lists', label: 'Lists', icon: ListChecks },
  { id: 'suppress', label: 'Suppress list', icon: Ban },
  { id: 'scoreboard', label: 'Scoreboard', icon: BarChart3 },
];

function Suppressions() {
  const { state, actions } = useStore();
  const users = useUsers();
  const editable = useAccess().canEdit('outreach');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const rows = state.suppressions || [];
  const add = (e) => {
    e.preventDefault();
    const clean = cleanSuppression({ value, reason });
    if (!clean) { setError('Enter an email or a domain.'); return; }
    if (!actions.addSuppression(clean)) { setError('Already on the list.'); return; }
    setValue(''); setReason(''); setError('');
  };
  return (
    <div className="mt-6">
      {editable && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[220px] flex-1 flex-col gap-1.5"><span className="text-[12px] dimmer">Email or domain</span>
            <input className="field" value={value} onChange={(e) => { setValue(e.target.value); setError(''); }} />
          </label>
          <label className="flex min-w-[180px] flex-1 flex-col gap-1.5"><span className="text-[12px] dimmer">Reason</span>
            <input className="field" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="submit" className="btn-primary h-11 rounded-full px-5 font-semibold">Add</button>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-[12.5px] text-amber-200">{error}</p>}
      {!rows.length ? <p className="mt-6 dimmer">Nobody suppressed.</p> : (
        <ul className="mt-5 flex flex-col rounded-[24px] glass">
          {rows.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t rowline px-5 py-3 first:border-t-0">
              <Pill className="chip">{SUPPRESSION_KINDS[x.kind]}</Pill>
              <span className="min-w-0 break-all font-semibold">{x.value}</span>
              {x.reason && <span className="text-[13px] dim">{x.reason}</span>}
              <span className="ml-auto text-[12px] dimmer">{[users[x.createdBy]?.name, x.createdAt && shortDate(x.createdAt)].filter(Boolean).join(' · ')}</span>
              {editable && (
                <button type="button" aria-label={`Remove ${x.value}`} title="Remove" onClick={() => actions.removeSuppression(x.id)}
                  className="grid h-8 w-8 place-items-center rounded-full chip"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Leads per sector or country, one bar colour, the number beside it; replied counts replied, meeting and converted.
function Scoreboard() {
  const { state } = useStore();
  const [by, setBy] = useState('sector');
  const rows = scoreboard(state.leads || [], by);
  const top = Math.max(1, ...rows.map((r) => r.leads));
  const rate = (r) => (r.contacted ? `${Math.round((r.replied / r.contacted) * 100)}%` : '—');
  return (
    <div className="mt-6">
      <Segmented label="Group by" value={by} onChange={setBy} options={[{ id: 'sector', label: 'Sector' }, { id: 'country', label: 'Country' }]} />
      {!rows.length ? <p className="mt-6 dimmer">No leads yet.</p> : (
        <div className="mt-5 overflow-x-auto scroll-thin rounded-[24px] glass">
          <table className="w-full min-w-[620px] text-[13px]">
            <thead>
              <tr className="text-left text-[12px] dimmer">
                <th className="px-3 py-2.5 pl-5 font-medium">{by === 'sector' ? 'Sector' : 'Country'}</th>
                <th className="w-[34%] px-3 py-2.5 font-medium">Leads</th>
                <th className="px-3 py-2.5 text-right font-medium">Contacted</th>
                <th className="px-3 py-2.5 text-right font-medium">Replied</th>
                <th className="px-3 py-2.5 text-right font-medium">Reply rate</th>
                <th className="px-3 py-2.5 pr-5 text-right font-medium">Meetings</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t rowline">
                  <td className="px-3 py-2.5 pl-5 font-semibold">{r.key}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="h-2.5 rounded-full bg-sky-400" style={{ width: `${(r.leads / top) * 100}%`, minWidth: 4 }} aria-hidden="true" />
                      <span className="tnum">{r.leads}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tnum">{r.contacted}</td>
                  <td className="px-3 py-2.5 text-right tnum">{r.replied}</td>
                  <td className="px-3 py-2.5 text-right tnum dim">{rate(r)}</td>
                  <td className="px-3 py-2.5 pr-5 text-right tnum">{r.meetings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Leads() {
  const { state, missing } = useStore();
  const access = useAccess();
  const editable = access.canEdit('outreach');
  const [tab, setTab] = useState(() => (TABS.some((t) => t.id === hashParam('tab')) ? hashParam('tab') : 'lists'));
  const [listId, setListId] = useState(() => hashParam('list') || '');
  const [open, setOpen] = useState(() => hashParam('lead') || null);
  const [importing, setImporting] = useState(false);
  const known = !listId || (state.leadLists || []).some((l) => l.id === listId);
  useEffect(() => { if (!known) setListId(''); }, [known]);
  // A link's ?list= / ?lead= is dropped once used, so a reload or Back doesn't reopen it.
  useEffect(() => {
    if (!open && (hashParam('lead') || hashParam('list'))) window.history.replaceState(window.history.state, '', '#/leads');
  }, [open]);
  if (missing.includes('leads')) return <div><PageHeader title="Leads" /><p className="mt-6 dimmer">Leads needs database update 0016.</p></div>;
  return (
    <div>
      <PageHeader title="Leads" action={editable ? 'Import CSV' : undefined} onAction={() => setImporting(true)} />
      <div className="mt-6">
        <Segmented label="Leads sections" value={tab} onChange={setTab} options={TABS} />
      </div>
      {tab === 'lists' && <LeadList listId={known ? listId : ''} onList={setListId} onOpen={setOpen} />}
      {tab === 'suppress' && <Suppressions />}
      {tab === 'scoreboard' && <Scoreboard />}
      <LeadProfile leadId={open} onClose={() => setOpen(null)} />
      <Modal open={importing} onClose={() => setImporting(false)} title="Import leads" width={960}>
        <div className="max-h-[75vh] overflow-y-auto scroll-thin">
          <Import only="leads" list={listId} onImported={(id) => { setListId(id); setTab('lists'); }} />
        </div>
      </Modal>
    </div>
  );
}
