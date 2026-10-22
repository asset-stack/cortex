import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { Drawer, SearchField, Segmented } from '@/components/ui';
import { gmailOutcome, gmailThreadUrl } from '@/lib/outreach';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { mailboxColor, mailboxName, replyColor, replyLabel, statusColor, statusLabel } from './shared';

const PAGE = 50;
const TABS = [{ id: 'sent', label: 'Sent' }, { id: 'replies', label: 'Replies' }, { id: 'logged', label: 'All logged' }];
// Mailboxes counted from Gmail: their prospect threads, and the agent's sheet as its own tab.
const GMAIL_TABS = [{ id: 'sent', label: 'Sent' }, { id: 'replies', label: 'Replies' }, { id: 'bounced', label: 'Bounced' }, { id: 'sheet', label: 'Sheet' }];
const dayOf = (e, only) => (only === 'replies' ? e.replyOn : only === 'logged' ? e.dateLogged : e.sentOn);
const threadDay = (t, only) => (only === 'replies' ? t.replyDay : only === 'bounced' ? t.bounceDay : t.firstDay);
const OUTCOME = { replied: ['Replied', '#0f9f6f'], auto: ['Auto-reply', '#a16207'], bounced: ['Bounced', '#9f1239'] };

function MailboxTag({ id, mailboxes }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: mailboxColor(mailboxes, id) }} />
      <span className="truncate">{mailboxName(mailboxes, id)}</span>
    </span>
  );
}

function StatusPill({ value, className }) {
  return <span className={cn('pill !inline-flex !h-6 !px-2 !text-[11.5px]', className)} style={{ backgroundColor: statusColor(value) }}>{statusLabel(value)}</span>;
}

// The reply, else a bounce, else nothing.
function ReplyPill({ e, className }) {
  if (e.replyStatus) return <span className={cn('pill !inline-flex !h-6 !px-2 !text-[11.5px]', className)} style={{ backgroundColor: replyColor(e.replyStatus) }}>{replyLabel(e.replyStatus)}</span>;
  if (e.bounced) return <span className={cn('pill !inline-flex !h-6 !px-2 !text-[11.5px]', className)} style={{ backgroundColor: '#9f1239' }}>Bounced</span>;
  return <span className="dimmer">—</span>;
}

// Replied, an auto-reply or bounced; nothing while we wait.
function OutcomePill({ t, className }) {
  const o = OUTCOME[gmailOutcome(t)];
  if (!o) return <span className="dimmer">—</span>;
  return <span className={cn('pill !inline-flex !h-6 !px-2 !text-[11.5px]', className)} style={{ backgroundColor: o[1] }}>{o[0]}</span>;
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 border-t rowline py-2 first:border-t-0">
      <dt className="text-[12.5px] dimmer">{label}</dt>
      <dd className="min-w-0 break-words text-[13.5px]">{children || <span className="dimmer">—</span>}</dd>
    </div>
  );
}

/** Everything the sheet holds for one contact, and its Gmail thread. `others`: the loaded rows for the same email
 *  (one email can go to two people at an organisation). */
function Detail({ e, mailboxes, others, onOpen }) {
  const gmail = gmailThreadUrl(e.sender, e.threadId);
  const day = (v) => (v ? shortDate(v) : '');
  return (
    <div>
      {gmail && (
        <a href={gmail} target="_blank" rel="noopener noreferrer" className="btn-primary inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold">
          <ExternalLink className="h-4 w-4" aria-hidden="true" />Open in Gmail
        </a>
      )}
      <h3 className={cn('font-extrabold text-[14px]', gmail && 'mt-5')}>Contact</h3>
      <dl className="mt-1">
        <Row label="Name">{e.contactName}</Row>
        <Row label="Role">{e.contactRole}</Row>
        <Row label="Email">{e.contactEmail}</Row>
        <Row label="Organisation">{e.organisation}</Row>
        <Row label="Domain">{e.domain}</Row>
        <Row label="Location">{e.location}</Row>
        <Row label="Vertical">{e.vertical}</Row>
        <Row label="Tier">{e.tier}</Row>
        <Row label="Signal">{e.signal}</Row>
      </dl>
      <h3 className="mt-5 font-extrabold text-[14px]">Email</h3>
      <dl className="mt-1">
        {others.length > 0 && (
          <Row label="Also to">
            <span className="flex flex-col items-start gap-0.5">
              {others.map((o) => (
                <button key={o.id} type="button" onClick={() => onOpen(o)} className="text-left hover:underline">
                  {o.contactName || o.contactEmail || 'Contact'}{o.contactRole && <span className="dimmer"> · {o.contactRole}</span>}
                </button>
              ))}
            </span>
          </Row>
        )}
        <Row label="Mailbox"><MailboxTag id={e.mailbox} mailboxes={mailboxes} /></Row>
        <Row label="Sender">{e.sender}</Row>
        <Row label="Subject">{e.subject}</Row>
        <Row label="Variant">{e.variant}</Row>
        <Row label="Status"><StatusPill value={e.status} /></Row>
        <Row label="Logged">{day(e.dateLogged)}</Row>
        <Row label="Sent">{day(e.sentOn)}</Row>
        <Row label="Sequence">{e.sequenceStatus}</Row>
        <Row label="Follow-up stage">{e.sentOn ? String(e.followupStage) : ''}</Row>
        <Row label="Next follow-up">{day(e.nextFollowup)}</Row>
        <Row label="Bounced">{e.bounced ? 'Yes' : ''}</Row>
      </dl>
      <h3 className="mt-5 font-extrabold text-[14px]">Reply</h3>
      <dl className="mt-1">
        <Row label="Reply">{e.replyStatus ? <ReplyPill e={e} /> : ''}</Row>
        <Row label="Replied">{day(e.replyOn)}</Row>
        <Row label="Summary">{e.replySummary}</Row>
        <Row label="Meeting">{day(e.meetingOn)}</Row>
        <Row label="Note">{e.note}</Row>
      </dl>
    </div>
  );
}

/** One prospect thread read from Gmail (headers only), with the sheet's details when a row matches. */
function ThreadDetail({ t, mailboxes }) {
  const gmail = gmailThreadUrl(t.sender, t.threadId);
  const day = (v) => (v ? shortDate(v) : '');
  return (
    <div>
      {gmail && (
        <a href={gmail} target="_blank" rel="noopener noreferrer" className="btn-primary inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold">
          <ExternalLink className="h-4 w-4" aria-hidden="true" />Open in Gmail
        </a>
      )}
      <h3 className={cn('font-extrabold text-[14px]', gmail && 'mt-5')}>Prospect</h3>
      <dl className="mt-1">
        <Row label="Name">{t.prospectName}</Row>
        <Row label="Email">{t.prospectEmail}</Row>
        <Row label="Organisation">{t.organisation}</Row>
        <Row label="Role">{t.contactRole}</Row>
        <Row label="Tier">{t.tier}</Row>
      </dl>
      <h3 className="mt-5 font-extrabold text-[14px]">Emails</h3>
      <dl className="mt-1">
        <Row label="Mailbox"><MailboxTag id={t.mailbox} mailboxes={mailboxes} /></Row>
        <Row label="Sender">{t.sender}</Row>
        <Row label="Subject">{t.subject}</Row>
        <Row label="People">{t.recipients > 1 ? String(t.recipients) : ''}</Row>
        <Row label="First sent">{day(t.firstDay)}</Row>
        <Row label="Emails sent">{String(t.sentCount)}</Row>
        <Row label="Last sent">{t.sentCount > 1 ? day(t.lastSentAt) : ''}</Row>
      </dl>
      <h3 className="mt-5 font-extrabold text-[14px]">Reply</h3>
      <dl className="mt-1">
        <Row label="Outcome">{gmailOutcome(t) === 'waiting' ? '' : <OutcomePill t={t} />}</Row>
        <Row label="Replied">{day(t.replyDay)}</Row>
        <Row label="Auto-reply">{day(t.autoDay)}</Row>
        <Row label="Bounced">{day(t.bounceDay)}</Row>
        <Row label="Sheet">{t.sheetReplyStatus ? replyLabel(t.sheetReplyStatus) : ''}</Row>
      </dl>
    </div>
  );
}

/**
 * The emails list, newest first, 50 at a time. For the agent's sheet: Sent (sent in the period), Replies (replied in it)
 * or All logged, a row per contact. When the mailbox shown is counted from Gmail (`gmail`, a Set of mailbox ids; for
 * all, `allGmail`: every mailbox All shows is, none is part-way through its first read, and nothing is Unassigned): Sent (prospects first emailed in the period), Replies, Bounced, a row per
 * prospect thread, and the sheet as its own tab. `mailbox`: null for all, '' Unassigned, or an id. `version` changes when the data may have
 * (a sync, the demo reset).
 */
export default function EmailList({ mailbox, from, to, mailboxes, gmail, allGmail = false, version }) {
  const { outreach } = useStore();
  const api = useRef(outreach);
  api.current = outreach;
  const gmailOn = mailbox === null ? allGmail : Boolean(gmail?.has(mailbox));
  const tabs = gmailOn ? GMAIL_TABS : TABS;
  const [picked, setOnly] = useState('sent');
  // The same tab in the other list where there is one (the sheet's All logged ⇄ Sheet), else Sent.
  const only = tabs.some((t) => t.id === picked) ? picked : picked === 'sheet' ? 'logged' : picked === 'logged' ? 'sheet' : 'sent';
  const threads = gmailOn && only !== 'sheet';
  const sheetOnly = only === 'sheet' ? 'logged' : only; // the sheet list's mode
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const [list, setList] = useState({ rows: [], more: false, loading: true, error: '' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState(null);
  const seq = useRef(0); // a later request wins
  const query = useMemo(() => ({ mailbox, from, to, search: q, only: threads ? only : sheetOnly, threads }), [mailbox, from, to, q, only, sheetOnly, threads]);
  const fetchPage = (qy, offset) => (qy.threads ? api.current.threads : api.current.emails)({ ...qy, limit: PAGE, offset });

  useEffect(() => {
    const n = ++seq.current;
    setLoadingMore(false);
    setList((l) => ({ ...l, rows: l.threads === query.threads ? l.rows : [], loading: true }));
    fetchPage(query, 0).then((res) => {
      if (n !== seq.current) return;
      setList(res?.ok ? { rows: res.rows, more: res.more, threads: query.threads, loading: false, error: '' }
        : { rows: [], more: false, threads: query.threads, loading: false, error: res?.error || 'Couldn’t load the emails' });
    });
  }, [query, version]);

  const loadMore = () => {
    const n = ++seq.current;
    setLoadingMore(true);
    fetchPage(query, list.rows.length).then((res) => {
      if (n !== seq.current) return;
      setLoadingMore(false);
      if (!res?.ok) { setList((l) => ({ ...l, error: res?.error || 'Couldn’t load more' })); return; }
      setList((l) => {
        const seen = new Set(l.rows.map((r) => r.id));
        return { ...l, rows: [...l.rows, ...res.rows.filter((r) => !seen.has(r.id))], more: res.more, error: '' };
      });
    });
  };

  const rows = list.threads === threads ? list.rows : [];
  const empty = !list.loading && !rows.length && !list.error;
  const title = (e) => e.organisation || e.contactName || e.contactEmail || 'Contact';
  const threadTitle = (t) => t.organisation || t.prospectName || t.prospectEmail || 'Prospect';

  return (
    <section className="min-w-0 rounded-[26px] glass glass-rim">
      <div className="flex flex-wrap items-center gap-2 p-4 sm:p-5">
        <h2 className="mr-2 font-extrabold text-[16px]">Emails</h2>
        <Segmented label="Emails shown" value={only} onChange={setOnly} options={tabs} />
        <div className="flex min-w-0 basis-full sm:ml-auto sm:basis-[260px]"><SearchField value={search} onChange={setSearch} placeholder="Search emails" /></div>
      </div>
      {list.error && <p role="alert" className="border-t rowline px-5 py-3 text-[13px] text-amber-200">{list.error}</p>}
      {empty && <p className="border-t rowline px-5 py-6 text-center text-[13px] dimmer">{q ? 'No matches' : 'None in this period'}</p>}

      {rows.length > 0 && threads && (
        <div className={cn('transition-opacity', list.loading && 'opacity-60')} aria-busy={list.loading}>
          <div className="hidden overflow-x-auto scroll-thin md:block">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead>
                <tr className="text-left text-[12px] dimmer">
                  <th className="px-3 py-2 pl-5 font-medium">{only === 'replies' ? 'Replied' : only === 'bounced' ? 'Bounced' : 'Sent'}</th>
                  <th className="px-3 py-2 font-medium">Mailbox</th>
                  <th className="px-3 py-2 font-medium">Prospect</th>
                  <th className="px-3 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Subject</th>
                  <th className="px-3 py-2 font-medium" title="Emails sent">Emails</th>
                  <th className="px-3 py-2 pr-5 font-medium">Reply</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} onClick={() => setOpen(t)} className="cursor-pointer border-t rowline align-middle hover:bg-white/5">
                    <td className="whitespace-nowrap px-3 py-2.5 pl-5 dim tnum">{shortDate(threadDay(t, only))}</td>
                    <td className="max-w-[120px] px-3 py-2.5"><MailboxTag id={t.mailbox} mailboxes={mailboxes} /></td>
                    <td className="max-w-[200px] px-3 py-2.5">
                      <button type="button" onClick={(ev) => { ev.stopPropagation(); setOpen(t); }} className="block max-w-full truncate text-left font-semibold hover:underline">{threadTitle(t)}</button>
                    </td>
                    <td className="max-w-[220px] px-3 py-2.5">
                      <div className="truncate">{t.prospectName || t.prospectEmail || '—'}</div>
                      {t.prospectName && <div className="truncate text-[12px] dimmer">{t.prospectEmail}</div>}
                    </td>
                    <td className="max-w-[260px] px-3 py-2.5"><div className="truncate dim">{t.subject || '—'}</div></td>
                    <td className="px-3 py-2.5 text-center tnum dim">{t.sentCount}</td>
                    <td className="px-3 py-2.5 pr-5"><OutcomePill t={t} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="md:hidden">
            {rows.map((t) => (
              <li key={t.id} className="border-t rowline">
                <button type="button" onClick={() => setOpen(t)} className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-white/5">
                  <span className="flex w-full items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-semibold">{threadTitle(t)}</span>
                    <span className="shrink-0 text-[12px] dimmer tnum">{shortDate(threadDay(t, only))}</span>
                  </span>
                  <span className="truncate text-[12.5px] dim">{t.subject || '—'}</span>
                  <span className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span className="dim"><MailboxTag id={t.mailbox} mailboxes={mailboxes} /></span>
                    <span className="dimmer tnum">{t.sentCount === 1 ? '1 email' : `${t.sentCount} emails`}</span>
                    {gmailOutcome(t) !== 'waiting' && <OutcomePill t={t} />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && !threads && (
        <div className={cn('transition-opacity', list.loading && 'opacity-60')} aria-busy={list.loading}>
          {/* Wide screens: the table */}
          <div className="hidden overflow-x-auto scroll-thin md:block">
            <table className="w-full min-w-[980px] text-[13px]">
              <thead>
                <tr className="text-left text-[12px] dimmer">
                  <th className="px-3 py-2 pl-5 font-medium">{sheetOnly === 'replies' ? 'Replied' : sheetOnly === 'logged' ? 'Logged' : 'Sent'}</th>
                  <th className="px-3 py-2 font-medium">Mailbox</th>
                  <th className="px-3 py-2 font-medium">Organisation</th>
                  <th className="px-3 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Subject</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium" title="Follow-up stage">Stage</th>
                  <th className="px-3 py-2 pr-5 font-medium">Reply</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} onClick={() => setOpen(e)} className="cursor-pointer border-t rowline align-middle hover:bg-white/5">
                    <td className="whitespace-nowrap px-3 py-2.5 pl-5 dim tnum">{shortDate(dayOf(e, sheetOnly))}</td>
                    <td className="max-w-[120px] px-3 py-2.5"><MailboxTag id={e.mailbox} mailboxes={mailboxes} /></td>
                    <td className="max-w-[200px] px-3 py-2.5">
                      <button type="button" onClick={(ev) => { ev.stopPropagation(); setOpen(e); }} className="block max-w-full truncate text-left font-semibold hover:underline">{title(e)}</button>
                    </td>
                    <td className="max-w-[200px] px-3 py-2.5">
                      <div className="truncate">{e.contactName || '—'}</div>
                      {e.contactRole && <div className="truncate text-[12px] dimmer">{e.contactRole}</div>}
                    </td>
                    <td className="max-w-[240px] px-3 py-2.5"><div className="truncate dim">{e.subject || '—'}</div></td>
                    <td className="px-3 py-2.5 text-center font-semibold">{e.tier || '—'}</td>
                    <td className="px-3 py-2.5"><StatusPill value={e.status} /></td>
                    <td className="px-3 py-2.5 text-center tnum dim">{e.sentOn ? e.followupStage : '—'}</td>
                    <td className="px-3 py-2.5 pr-5"><ReplyPill e={e} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Phones: a compact list */}
          <ul className="md:hidden">
            {rows.map((e) => (
              <li key={e.id} className="border-t rowline">
                <button type="button" onClick={() => setOpen(e)} className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-white/5">
                  <span className="flex w-full items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-semibold">{title(e)}</span>
                    <span className="shrink-0 text-[12px] dimmer tnum">{shortDate(dayOf(e, sheetOnly))}</span>
                  </span>
                  <span className="truncate text-[12.5px] dim">{[e.contactName, e.contactRole].filter(Boolean).join(' · ') || '—'}</span>
                  <span className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span className="dim"><MailboxTag id={e.mailbox} mailboxes={mailboxes} /></span>
                    <StatusPill value={e.status} />
                    {(e.replyStatus || e.bounced) && <ReplyPill e={e} />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {list.loading && !rows.length && <p className="border-t rowline px-5 py-6 text-center text-[13px] dimmer"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden="true" />Loading</p>}
      {list.more && (
        <div className="border-t rowline p-3 text-center">
          <button type="button" onClick={loadMore} disabled={loadingMore || list.loading}
            className="inline-flex h-9 items-center gap-2 rounded-full chip px-4 font-semibold disabled:opacity-60">
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Load more
          </button>
        </div>
      )}
      <div className="h-2" />

      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? (open.prospectEmail !== undefined ? threadTitle(open) : title(open)) : ''} width={560}>
        {open && open.prospectEmail !== undefined && <ThreadDetail t={open} mailboxes={mailboxes} />}
        {open && open.prospectEmail === undefined && <Detail e={open} mailboxes={mailboxes} onOpen={setOpen}
          others={open.messageId ? rows.filter((r) => r.messageId === open.messageId && r.id !== open.id) : []} />}
      </Drawer>
    </section>
  );
}
