// Leads → one lead (docs/PHASE2.md §23): its details and status, why it mustn't be contacted, the CRM record it already is
// or Convert to CRM, its contact history (the outreach agent's sheet rows and Gmail threads for its email) and, once in
// the CRM, that person's timeline.
import { useEffect, useState } from 'react';
import { ArrowRight, Ban, ExternalLink, Loader2, Mail, Phone, Trash2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { LEAD_STATUSES, crmMatch, duplicatesOf, emailOf, leadDomain, suppressedBy } from '@/lib/leads';
import { gmailOutcome, gmailThreadUrl } from '@/lib/outreach';
import { localYmd, safeUrl, shortDate } from '@/lib/format';
import { ConfirmModal, Drawer, PersonPicker } from '@/components/ui';
import { Detail, Pill, TheirTime } from '@/components/crm/bits';
import { Timeline } from '@/components/crm/Profile';
import { mailboxName, replyColor, replyLabel, statusLabel } from '@/components/outreach/shared';
import { cn } from '@/lib/cn';

const SMALL_BTN = 'inline-flex h-9 items-center gap-1.5 rounded-full chip px-3.5 text-[13px] font-semibold';
export const STATUS_BG = {
  new: 'bg-slate-500/60', queued: 'bg-sky-600/70', contacted: 'bg-indigo-500/70', replied: 'bg-emerald-600/70', meeting: 'bg-violet-500/70',
  not_interested: 'bg-slate-600/70', bounced: 'bg-rose-700/70', converted: 'bg-emerald-700/80',
};
export const StatusPill = ({ value }) => <Pill className={STATUS_BG[value] || STATUS_BG.new}>{LEAD_STATUSES[value] || LEAD_STATUSES.new}</Pill>;
const OUTCOME = { replied: ['Replied', '#0f9f6f'], auto: ['Auto-reply', '#a16207'], bounced: ['Bounced', '#9f1239'] };

/** What the outreach agent logged for this email (its sheet rows) and the Gmail threads with it, newest first. */
function History({ email }) {
  const { state, outreach } = useStore();
  const [data, setData] = useState(null); // { rows, threads } | { error }
  useEffect(() => {
    let live = true;
    setData(null);
    if (!email) return undefined;
    const range = { from: '2000-01-01', to: localYmd(), search: email, limit: 25 };
    Promise.all([outreach.emails({ ...range, only: 'logged' }), outreach.threads({ ...range, only: 'sent' })]).then(([e, t]) => {
      if (!live) return;
      if (!e.ok) { setData({ error: e.error }); return; }
      setData({
        rows: (e.rows || []).filter((r) => String(r.contactEmail).toLowerCase() === email),
        threads: t.ok ? (t.rows || []).filter((r) => String(r.prospectEmail).toLowerCase() === email) : [],
      });
    });
    return () => { live = false; };
  }, [email, outreach]);
  const mailboxes = state.mailboxes || [];
  return (
    <section>
      <h3 className="font-bold">Contact history</h3>
      {!email ? <p className="mt-2 text-[13px] dimmer">No email.</p>
        : !data ? <p className="mt-2 inline-flex items-center gap-2 text-[13px] dimmer"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading</p>
          : data.error ? <p role="alert" className="mt-2 text-[13px] text-amber-200">{data.error}</p>
            : !data.rows.length && !data.threads.length ? <p className="mt-2 text-[13px] dimmer">Not contacted yet.</p> : (
              <ul className="mt-2 flex flex-col gap-1">
                {data.rows.map((r) => {
                  const gmail = gmailThreadUrl(r.sender, r.threadId);
                  return (
                    <li key={r.id} className="rounded-xl px-2 py-2 hover:bg-white/5">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                        <span className="tnum dim">{shortDate(r.sentOn || r.dateLogged)}</span>
                        <span className="font-semibold">{statusLabel(r.status)}</span>
                        <span className="dimmer">{mailboxName(mailboxes, r.mailbox)}</span>
                        {r.replyStatus && <span className="pill !inline-flex !h-6 !px-2 !text-[11.5px]" style={{ backgroundColor: replyColor(r.replyStatus) }}>{replyLabel(r.replyStatus)}</span>}
                        {r.bounced && <Pill className="bg-rose-700/80">Bounced</Pill>}
                        {r.meetingOn && <Pill className="bg-violet-500/70">Meeting {shortDate(r.meetingOn)}</Pill>}
                        {gmail && <a href={gmail} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12.5px] dim">Gmail<ExternalLink className="h-3 w-3" aria-hidden="true" /></a>}
                      </div>
                      {r.subject && <div className="mt-0.5 truncate text-[12.5px] dim">{r.subject}</div>}
                      {r.replySummary && <div className="mt-0.5 text-[12.5px]">{r.replySummary}</div>}
                    </li>
                  );
                })}
                {data.threads.map((t) => {
                  const o = OUTCOME[gmailOutcome(t)];
                  return (
                    <li key={t.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl px-2 py-2 text-[13px] hover:bg-white/5">
                      <span className="tnum dim">{shortDate(t.firstDay)}</span>
                      <span className="font-semibold">Gmail thread</span>
                      <span className="dimmer">{mailboxName(mailboxes, t.mailbox)}</span>
                      {o && <span className="pill !inline-flex !h-6 !px-2 !text-[11.5px]" style={{ backgroundColor: o[1] }}>{o[0]}</span>}
                      {t.subject && <span className="w-full truncate text-[12.5px] dim">{t.subject}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
    </section>
  );
}

export default function LeadProfile({ leadId, onClose }) {
  const { state, actions, missing } = useStore();
  const access = useAccess();
  const editable = access.canEdit('outreach');
  const canConvert = editable && access.canEdit('pipeline') && !missing.includes('accounts');
  const lead = leadId ? (state.leads || []).find((l) => l.id === leadId) : null;
  const [note, setNote] = useState('');
  const [withDeal, setWithDeal] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => { setNote(lead?.note || ''); setWithDeal(false); }, [leadId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!lead) return <Drawer open={false} onClose={onClose} title="" />;
  const why = suppressedBy(state, lead);
  const { account, person } = crmMatch(state, lead);
  const repeats = duplicatesOf(state, lead);
  const email = emailOf(lead.email);
  const domain = leadDomain(lead);
  const linkedin = safeUrl(lead.linkedin);
  const listName = (id) => (state.leadLists || []).find((l) => l.id === id)?.name || '';
  const suppressed = (kind, value) => (state.suppressions || []).some((x) => x.kind === kind && x.value === value);
  const crmHref = person ? `#/pipeline?person=${person.id}` : account ? `#/pipeline?account=${account.id}` : '';
  return (
    <Drawer open onClose={onClose} title={lead.name || lead.email} width={560}>
      <div className="flex flex-col gap-7">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {editable ? (
            <select className="field !h-9 !w-auto !rounded-full !py-0 text-[13px]" aria-label="Status" value={lead.status}
              onChange={(e) => actions.updateLead(lead.id, { status: e.target.value })}>
              {Object.entries(LEAD_STATUSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          ) : <StatusPill value={lead.status} />}
          <TheirTime timezone={lead.timezone} />
          <span className="ml-auto inline-flex items-center gap-2 text-[12.5px] dim">
            Owner<PersonPicker value={lead.owner} size={26} readOnly={!editable} onChange={(owner) => actions.updateLead(lead.id, { owner })} />
          </span>
        </div>
        {why && <p role="status" className="flex items-center gap-2 rounded-2xl bg-rose-700/40 px-4 py-2.5 text-[13px]"><Ban className="h-4 w-4 shrink-0" aria-hidden="true" />{why}</p>}

        <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px]">
          <Detail label="Company">{lead.company}</Detail>
          <Detail label="Title">{lead.title}</Detail>
          <Detail label="Website">{domain}</Detail>
          <Detail label="Sector">{lead.sector}</Detail>
          <Detail label="Location">{[lead.region, lead.country].filter(Boolean).join(', ')}</Detail>
          <Detail label="Size">{lead.size}</Detail>
          <Detail label="List">{listName(lead.listId)}</Detail>
          <Detail label="Also on">{repeats.length ? [...new Set(repeats.map((r) => listName(r.listId)))].join(', ') : ''}</Detail>
        </dl>
        <div className="flex flex-wrap gap-2">
          {lead.email && <a href={`mailto:${lead.email}`} className={SMALL_BTN}><Mail className="h-3.5 w-3.5" aria-hidden="true" />{lead.email}</a>}
          {lead.phone && <a href={`tel:${lead.phone.replace(/[^\d+]/g, '')}`} className={SMALL_BTN}><Phone className="h-3.5 w-3.5" aria-hidden="true" />{lead.phone}</a>}
          {linkedin && <a href={linkedin} target="_blank" rel="noopener noreferrer" className={SMALL_BTN}>LinkedIn<ExternalLink className="h-3 w-3 dimmer" aria-hidden="true" /></a>}
        </div>

        <section>
          <h3 className="font-bold">CRM</h3>
          {crmHref ? (
            <a href={crmHref} className={cn(SMALL_BTN, 'mt-2')}>
              {[person?.name || person?.email, account?.name].filter(Boolean).join(' · ')}<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          ) : <p className="mt-2 text-[13px] dimmer">Not in the CRM.</p>}
          {canConvert && lead.status !== 'converted' && (account || lead.company) && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" className="btn-primary inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold"
                onClick={() => actions.convertLead(lead.id, { deal: withDeal })}>
                Convert to CRM
              </button>
              <label className="inline-flex items-center gap-2 text-[13px]">
                <input type="checkbox" className="h-4 w-4 accent-white" checked={withDeal} onChange={(e) => setWithDeal(e.target.checked)} />With a deal
              </label>
            </div>
          )}
        </section>

        <History email={email} />
        {person && <Timeline target={{ contactId: person.id }} />}

        {editable ? (
          <label className="flex flex-col gap-1.5"><span className="font-bold">Note</span>
            <textarea className="field min-h-[80px]" value={note} onChange={(e) => setNote(e.target.value)}
              onBlur={() => { if (note !== lead.note) actions.updateLead(lead.id, { note }); }} />
          </label>
        ) : lead.note && <section><h3 className="font-bold">Note</h3><p className="mt-2 whitespace-pre-wrap text-[13.5px]">{lead.note}</p></section>}

        {editable && (
          <div className="flex flex-wrap gap-2 border-t rowline pt-5">
            {email && !suppressed('email', email) && (
              <button type="button" className={SMALL_BTN} onClick={() => actions.addSuppression({ kind: 'email', value: email })}>
                <Ban className="h-3.5 w-3.5" aria-hidden="true" />Suppress email
              </button>
            )}
            {domain && !suppressed('domain', domain) && (
              <button type="button" className={SMALL_BTN} onClick={() => actions.addSuppression({ kind: 'domain', value: domain })}>
                <Ban className="h-3.5 w-3.5" aria-hidden="true" />Suppress {domain}
              </button>
            )}
            <button type="button" className={cn(SMALL_BTN, 'ml-auto text-rose-200')} onClick={() => setRemoving(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Remove lead
            </button>
          </div>
        )}
      </div>
      <ConfirmModal open={removing} onClose={() => setRemoving(false)} title={`Remove ${lead.name || lead.email}?`} action="Remove"
        onConfirm={() => { actions.removeLeads([lead.id]); onClose(); }} />
    </Drawer>
  );
}
