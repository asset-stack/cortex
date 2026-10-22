import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail } from 'lucide-react';
import { useStore } from '@/data/store';
import { Avatar, Segmented } from '@/components/ui';
import { daysBetween, mergeDaily, outreachTotals, periodRange } from '@/lib/outreach';
import { localYmd, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import SyncStatus from './SyncStatus';
import SentChart from './SentChart';
import Notes from './Notes';
import EmailList from './EmailList';
import Breakdown from './Breakdown';
import { ALL, NONE, knownMailbox, mailboxArg, mailboxColor, pct } from './shared';

const PERIODS = [{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }];

function Kpis({ items }) {
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      {items.map(({ value, label, tint, muted }) => (
        <div key={label} className="glass glass-rim rounded-[22px] p-4" style={{ background: `linear-gradient(155deg, ${tint}99, ${tint}33)` }}>
          <div className={cn('font-black leading-none tracking-[-0.03em] tnum', muted ? 'text-[15px] leading-[26px] dim' : 'text-[26px]')}>{value}</div>
          <div className="mt-2 text-[12.5px] dim">{label}</div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="font-bold tnum truncate">{value}</div>
      <div className="text-[11.5px] dimmer truncate">{label}</div>
    </div>
  );
}

const GMAIL_MARK = { ready: 'Counted from Gmail', reading: 'Reading Gmail' };

/** One mailbox's period at a glance; picks it in the filter when it is one of the filter's options. */
function MailboxCard({ card, onPick }) {
  const body = (
    <>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: card.color }} />
        <span className="min-w-0 flex-1 truncate font-extrabold text-[15px]">{card.name}</span>
        {card.gmail && (
          <span title={GMAIL_MARK[card.gmail]} className={cn('inline-flex shrink-0 items-center', card.gmail === 'reading' ? 'dimmer' : 'dim')}>
            <Mail className="h-4 w-4" aria-hidden="true" /><span className="sr-only">{GMAIL_MARK[card.gmail]}</span>
          </span>
        )}
        {card.owner && <Avatar userId={card.owner} size={24} ring={false} />}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-[14px]">
        <Stat label="Sent" value={card.totals.sent} />
        <Stat label="Replies" value={card.totals.replies} />
        <Stat label="Reply rate" value={pct(card.totals.replyRate)} />
        <Stat label="Last sent" value={card.last ? shortDate(card.last) : '—'} />
      </div>
    </>
  );
  const cls = 'block w-full min-w-0 rounded-[22px] glass glass-rim p-4 text-left';
  return onPick
    ? <button type="button" onClick={onPick} title={`Show ${card.name}`} className={cn(cls, 'float')}>{body}</button>
    : <div className={cls}>{body}</div>;
}

/** The Emails view: cold emails sent, per mailbox and period, the team's notes and the list. A mailbox whose Gmail has been
 *  read counts from Gmail (emails sent, prospects, replies, bounces; meetings from the sheet); any other from the
 *  agent's sheet, where counts are emails (an email to two people counts once) and the list has a row per contact. */
export default function Emails() {
  const { state, outreach } = useStore();
  const mailboxes = useMemo(() => state.mailboxes || [], [state.mailboxes]);
  const [filter, setFilter] = useState(ALL);
  const [period, setPeriod] = useState('30');
  const [reload, setReload] = useState(0);
  const today = localYmd();
  const { from, to } = useMemo(() => periodRange(Number(period), today), [period, today]);
  const days = useMemo(() => daysBetween(from, to), [from, to]);

  // Demo data only changes with a reset; live data with a sync. Other state changes don't re-query.
  const rowsInDemo = state.outreachEmails;
  const source = outreach.live ? 'live' : `${rowsInDemo?.length || 0}|${rowsInDemo?.[0]?.id || ''}`;
  const version = `${source}|${reload}`;
  const api = useRef(outreach);
  api.current = outreach;

  const [data, setData] = useState({ period: '', daily: [], breakdown: [], gmail: [], gmailDaily: [], gmailBreakdown: [], error: '', loading: true });
  const seq = useRef(0); // a later request wins
  useEffect(() => {
    const n = ++seq.current;
    setData((d) => ({ ...d, loading: true }));
    const o = api.current;
    Promise.all([o.daily(from, to), o.breakdown(from, to), o.gmailStatus(), o.gmailDaily(from, to), o.gmailBreakdown(from, to)])
      .then(([a, b, gs, gd, gb]) => {
        if (n !== seq.current) return;
        // Gmail's numbers only count when all three came back; otherwise every mailbox counts from the sheet.
        const gmailOk = gs?.ok && gd?.ok && gb?.ok;
        const bad = [a, b, gs?.ok ? gd : null, gs?.ok ? gb : null].find((r) => r && !r.ok);
        setData({
          period: `${from}|${to}`, daily: a?.ok ? a.rows : [], breakdown: b?.ok ? b.rows : [], loading: false,
          gmail: gmailOk ? gs.mailboxes : [], gmailDaily: gmailOk ? gd.rows : [], gmailBreakdown: gmailOk ? gb.rows : [],
          error: bad ? bad.error || 'Couldn’t load the numbers' : '',
        });
      });
  }, [from, to, version]);

  // Mailboxes counted from Gmail: connected and through their first read (a mailbox switched off keeps counting so);
  // 'reading' while an active one's first read goes on.
  const gmailOf = useMemo(() => new Map(data.gmail.filter((g) => g.connected && (g.ready || g.active !== false))
    .map((g) => [g.mailbox, g.ready ? 'ready' : 'reading'])), [data.gmail]);
  const readyBoxes = useMemo(() => new Set([...gmailOf].filter(([, v]) => v === 'ready').map(([k]) => k)), [gmailOf]);
  // Every active mailbox counted from Gmail: then All lists prospect threads too, else the sheet's list (which has them all).
  const allGmail = useMemo(() => {
    const on = mailboxes.filter((m) => m.active !== false);
    return on.length > 0 && on.every((m) => readyBoxes.has(m.id));
  }, [mailboxes, readyBoxes]);
  const daily = useMemo(
    () => mergeDaily(knownMailbox(data.daily, mailboxes), knownMailbox(data.gmailDaily, mailboxes), readyBoxes),
    [data.daily, data.gmailDaily, mailboxes, readyBoxes],
  );
  const breakdown = useMemo(() => knownMailbox(data.breakdown, mailboxes), [data.breakdown, mailboxes]);
  const gmailBreakdown = useMemo(
    () => knownMailbox(data.gmailBreakdown, mailboxes).filter((r) => readyBoxes.has(r.mailbox)),
    [data.gmailBreakdown, mailboxes, readyBoxes],
  );
  const hasUnassigned = daily.some((r) => !r.mailbox) || breakdown.some((r) => !r.mailbox);

  const options = [
    { id: ALL, label: 'All' },
    ...mailboxes.filter((m) => m.active !== false).map((m) => ({ id: m.id, label: m.name })),
    ...(hasUnassigned ? [{ id: NONE, label: 'Unassigned' }] : []),
  ];
  const current = options.some((o) => o.id === filter) ? filter : ALL;
  const settled = !data.loading && data.period === `${from}|${to}`;
  useEffect(() => { if (settled && current !== filter) setFilter(ALL); }, [settled, current, filter]);
  const mb = mailboxArg(current);

  const totals = outreachTotals(daily, mb);
  const sentToday = daily.filter((r) => r.day === today && (mb === null || r.mailbox === mb)).reduce((t, r) => t + r.sent, 0);

  // Every mailbox's card when showing all: the active ones, any other that has numbers in the period, and Unassigned.
  const cards = current === ALL ? [
    ...mailboxes.filter((m) => m.active !== false || daily.some((r) => r.mailbox === m.id))
      .map((m) => ({ id: m.id, name: m.name, owner: m.owner, gmail: gmailOf.get(m.id) || '' })),
    ...(hasUnassigned ? [{ id: '', name: 'Unassigned', owner: '', gmail: '' }] : []),
  ].map((c) => ({
    ...c,
    color: mailboxColor(mailboxes, c.id),
    totals: outreachTotals(daily, c.id),
    last: daily.filter((r) => r.mailbox === c.id && r.sent).reduce((m, r) => (r.day > m ? r.day : m), ''),
    pick: c.id ? options.some((o) => o.id === c.id) && c.id : NONE,
  })) : [];

  const onSynced = useCallback(() => setReload((n) => n + 1), []);

  return (
    <div>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="max-w-full overflow-x-auto scroll-thin rounded-full">
          <Segmented label="Mailbox" value={current} onChange={setFilter} options={options} />
        </div>
        <Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS} />
        <SyncStatus autoSync onSynced={onSynced} className="lg:ml-auto" />
      </div>
      {data.error && <p role="alert" className="mt-3 text-[13px] text-amber-200">{data.error}</p>}

      <Kpis items={[
        { value: totals.sent, label: 'Sent', tint: '#334155' },
        { value: sentToday, label: 'Sent today', tint: '#2f6f86' },
        { value: totals.started, label: 'Prospects', tint: '#3157a4' },
        { value: totals.replies, label: 'Replies', tint: '#0f9f6f' },
        { value: pct(totals.replyRate), label: 'Reply rate', tint: '#0f766e' },
        { value: totals.bounces, label: 'Bounces', tint: '#9f1239' },
        { value: totals.meetings, label: 'Meetings', tint: '#7c3aed' },
        { value: 'Not tracked', label: 'Opens', tint: '#475569', muted: true },
      ]} />

      <section className={cn('mt-6 min-w-0 rounded-[26px] glass glass-rim p-5 transition-opacity', data.loading && 'opacity-80')}>
        <h2 className="mb-3 font-extrabold text-[16px]">Sent per day</h2>
        <SentChart daily={daily} days={days} mailbox={mb} mailboxes={mailboxes} />
      </section>

      {cards.length > 0 && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => <MailboxCard key={c.id || 'none'} card={c} onPick={c.pick ? () => setFilter(c.pick) : undefined} />)}
        </div>
      )}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <Notes filter={current} mailboxes={mailboxes} />
        <Breakdown rows={breakdown} gmailRows={gmailBreakdown} mailbox={mb} gmailOnly={mb === null ? allGmail && !hasUnassigned : readyBoxes.has(mb)} />
      </div>

      <div className="mt-6">
        <EmailList mailbox={mb} from={from} to={to} mailboxes={mailboxes} gmail={readyBoxes} allGmail={allGmail} version={version} />
      </div>
    </div>
  );
}
