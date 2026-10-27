// Pipeline → Opportunities (docs/PHASE2.md §22): open deals on a board by stage (drag, or the stage select, to move one)
// or as a table, with search, owner and quick filters (waiting on us, stalled, lost), and the numbers: open deals, the
// pipeline and its weighted value per currency, and deals made clients.
import { useState } from 'react';
import { ArrowRight, Columns3, Pencil, Rows3 } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { DEAL_STAGES, LOST, STALE_DAYS, dealProbability, dealStage, daysInStage } from '@/data/boards';
import { accountOf, dealPeople, isOpenDeal } from '@/lib/accounts';
import { Avatar, KpiRow, SearchField, Segmented } from '@/components/ui';
import { compactIn, shortDate, totalsIn, totalsList } from '@/lib/format';
import { cn } from '@/lib/cn';
import { DaysInStage, OpenLink, PRIORITY_BG, Pill, WaitingPill } from './bits';

const LAST_STAGE = DEAL_STAGES[DEAL_STAGES.length - 1]; // Contract sent: Make client on its cards
const VIEWS = [{ id: 'board', label: 'Board', icon: Columns3 }, { id: 'table', label: 'Table', icon: Rows3 }];
const QUICK = [
  { id: '', label: 'All open' },
  { id: 'us', label: 'Waiting on us' },
  { id: 'stalled', label: `Stalled ${STALE_DAYS}d+` },
  { id: 'lost', label: 'Lost' },
];

const dealText = (state, d) => [d.name, accountOf(state, d)?.name, d.sector, d.next, ...dealPeople(state, d).map((p) => p.name)].join(' ').toLowerCase();

export default function Opportunities({ editable, canConvert, onOpen, onEdit, onMakeClient }) {
  const { state, actions } = useStore();
  const users = useUsers();
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState(''); // '' everyone, or a user id
  const [quick, setQuick] = useState('');
  const [view, setView] = useState('board');
  const [over, setOver] = useState(null);

  const matches = (d) => (!q.trim() || dealText(state, d).includes(q.trim().toLowerCase())) && (!owner || d.contact === owner);
  const open = state.deals.filter((d) => isOpenDeal(d) && matches(d));
  const lost = state.deals.filter((d) => !d.clientId && dealStage(d) === LOST && matches(d));
  const shown = quick === 'lost' ? lost
    : quick === 'us' ? open.filter((d) => d.waitingOn === 'us')
      : quick === 'stalled' ? open.filter((d) => (daysInStage(d) ?? 0) >= STALE_DAYS) : open;
  const owners = [...new Set(state.deals.filter((d) => !d.clientId).map((d) => d.contact).filter(Boolean))];
  // A deal moved by its stage select lands in another column: keep focus on its select there.
  const refocusStage = (dealId) => window.setTimeout(() => {
    document.querySelector(`[data-deal="${CSS.escape(dealId)}"] select`)?.focus({ preventScroll: true });
  }, 0);
  const drop = (stage) => (editable ? {
    onDragOver: (e) => { e.preventDefault(); setOver(stage); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); },
    onDrop: (e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/plain'); if (id) actions.moveDeal(id, stage); },
  } : {});
  const stop = { draggable: false, onMouseDown: (e) => e.stopPropagation() };

  const card = (d, stage) => {
    const account = accountOf(state, d);
    return (
      <div key={d.id} data-deal={d.id} draggable={editable} onDragStart={editable ? (e) => e.dataTransfer.setData('text/plain', d.id) : undefined}
        className={cn('float rounded-[18px] chip p-3.5', editable && 'cursor-grab active:cursor-grabbing')}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <OpenLink onClick={() => onOpen('deal', d.id)} label={`Open ${d.name}`} className="block w-full whitespace-normal font-bold [overflow-wrap:anywhere] hyphens-auto" {...stop}>{d.name}</OpenLink>
            {account && account.name !== d.name && <div className="truncate text-[12px] dimmer">{account.name}</div>}
          </div>
          {editable && (
            <button type="button" data-edit onClick={() => onEdit(d)} aria-label={`Edit ${d.name}`} title="Edit" {...stop}
              className="-mr-1.5 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><Pencil className="h-3.5 w-3.5" /></button>
          )}
        </div>
        {d.next && <div className="mt-1 text-[12.5px] dim">{d.next}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Pill className={PRIORITY_BG[d.priority]}><span className="sr-only">Priority </span>{d.priority}</Pill>
          <WaitingPill value={d.waitingOn} />
          <DaysInStage deal={d} />
          {d.closeOn && <Pill className="chip" title="Expected close">{shortDate(d.closeOn)}</Pill>}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-extrabold tnum text-[16px]">{compactIn(d.value, d.currency)}</span>
            {d.contact && <Avatar userId={d.contact} size={22} />}
          </div>
          {stage === LAST_STAGE && canConvert && (
            <button type="button" onClick={() => onMakeClient(d.id)} className="inline-flex items-center gap-1 rounded-full chip-on px-2.5 py-1 text-[12px] font-semibold">
              Make client<ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* Keyboard path for moving a deal; drag and drop stays as the mouse shortcut. */}
        {editable && (
          <select className="field mt-2 !rounded-full !py-1 !px-2.5 text-[12px]" aria-label={`Stage for ${d.name}`} value={stage} {...stop}
            onChange={(e) => { if (actions.moveDeal(d.id, e.target.value)) refocusStage(d.id); }}>
            {DEAL_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
      </div>
    );
  };

  const weighted = (list) => list.map((d) => ({ currency: d.currency, value: ((d.value || 0) * dealProbability(d)) / 100 }));
  const allOpen = state.deals.filter(isOpenDeal);
  // The first currency large, any others under it (currencies aren't converted into each other).
  const kpi = (label, items) => { const [first, ...more] = totalsList(items); return { value: first, label: [label, ...more].join(' · ') }; };
  return (
    <div>
      <KpiRow items={[
        { value: allOpen.length, label: 'Open deals', tint: '#334155' },
        { ...kpi('Pipeline', allOpen), tint: '#7c3aed' },
        { ...kpi('Weighted', weighted(allOpen)), tint: '#0f9f8f' },
        { value: state.deals.filter((d) => d.clientId).length, label: 'Made clients', tint: '#f59e0b' },
      ]} />
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Search deals" />
        <select className="field !h-10 !w-auto !rounded-full !py-0" aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Everyone</option>
          {owners.map((id) => <option key={id} value={id}>{id === state.me ? 'Mine' : users[id]?.name || 'Someone'}</option>)}
        </select>
        <Segmented label="View" value={quick === 'lost' ? 'table' : view} onChange={(v) => { setView(v); if (quick === 'lost') setQuick(''); }} options={VIEWS} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {QUICK.map((x) => (
          <button key={x.id} type="button" aria-pressed={quick === x.id} onClick={() => setQuick(x.id)}
            className={cn('rounded-full px-3 h-8 text-[12.5px]', quick === x.id ? 'chip-on font-semibold' : 'chip dim')}>
            {x.label}{x.id === 'lost' ? ` ${lost.length}` : ''}
          </button>
        ))}
      </div>

      {view === 'board' && quick !== 'lost' ? (
        <div className="mt-5 overflow-x-auto scroll-thin pb-2">
          <div className="grid gap-4 min-w-[1260px]" style={{ gridTemplateColumns: `repeat(${DEAL_STAGES.length}, minmax(0, 1fr))` }}>
            {DEAL_STAGES.map((stage) => {
              const items = shown.filter((d) => dealStage(d) === stage);
              return (
                <div key={stage} className={cn('rounded-[24px] glass p-3', over === stage && 'drag-over')} {...drop(stage)}>
                  <div className="mb-1 flex items-center justify-between px-2 pt-1 font-bold">
                    {stage}<span className="rounded-full chip px-2 text-[12px] tnum">{items.length}</span>
                  </div>
                  <div className="mb-3 px-2 text-[12px] dimmer tnum">{totalsIn(items)}</div>
                  <div className="flex flex-col gap-2 min-h-[90px]">{items.map((d) => card(d, stage))}</div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <DealTable deals={shown} lost={quick === 'lost'} onOpen={onOpen} />
      )}
    </div>
  );
}

/** Deals as rows: desktop a table, phones a card each. */
function DealTable({ deals, lost, onOpen }) {
  const { state } = useStore();
  const users = useUsers();
  const rows = [...deals].sort((a, b) => DEAL_STAGES.indexOf(dealStage(a)) - DEAL_STAGES.indexOf(dealStage(b)) || (daysInStage(b) ?? 0) - (daysInStage(a) ?? 0));
  if (!rows.length) return <p className="mt-6 dimmer">{lost ? 'No lost deals.' : 'No deals here.'}</p>;
  return (
    <div className="mt-5 rounded-[24px] glass">
      <div className="hidden overflow-x-auto scroll-thin md:block">
        <table className="w-full min-w-[980px] text-[13px]">
          <thead>
            <tr className="text-left text-[12px] dimmer">
              <th className="px-3 py-2.5 pl-5 font-medium">Deal</th>
              <th className="px-3 py-2.5 font-medium">Stage</th>
              <th className="px-3 py-2.5 font-medium">Value</th>
              <th className="px-3 py-2.5 font-medium">{lost ? 'Reason' : 'Probability'}</th>
              <th className="px-3 py-2.5 font-medium">Close</th>
              <th className="px-3 py-2.5 font-medium">Owner</th>
              <th className="px-3 py-2.5 font-medium">Waiting</th>
              <th className="px-3 py-2.5 font-medium">In stage</th>
              <th className="px-3 py-2.5 pr-5 font-medium">Next step</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const account = accountOf(state, d);
              return (
                <tr key={d.id} className="border-t rowline align-middle hover:bg-white/5">
                  <td className="max-w-[240px] px-3 py-2.5 pl-5">
                    <OpenLink onClick={() => onOpen('deal', d.id)} className="block">{d.name}</OpenLink>
                    {account && account.name !== d.name && <div className="truncate text-[12px] dimmer">{account.name}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 dim">{dealStage(d)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold tnum">{compactIn(d.value, d.currency)}</td>
                  <td className="max-w-[160px] truncate px-3 py-2.5 dim tnum">{lost ? d.lostReason || '—' : `${dealProbability(d)}%`}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 dim">{d.closeOn ? shortDate(d.closeOn) : '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 dim">{users[d.contact]?.name?.split(' ')[0] || '—'}</td>
                  <td className="px-3 py-2.5"><WaitingPill value={d.waitingOn} /></td>
                  <td className="px-3 py-2.5"><DaysInStage deal={d} /></td>
                  <td className="max-w-[260px] truncate px-3 py-2.5 pr-5 dim">{d.next || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col md:hidden">
        {rows.map((d) => (
          <li key={d.id} className="border-t rowline px-4 py-3 first:border-t-0">
            <div className="flex items-start justify-between gap-2">
              <OpenLink onClick={() => onOpen('deal', d.id)}>{d.name}</OpenLink>
              <span className="shrink-0 font-semibold tnum">{compactIn(d.value, d.currency)}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] dim">
              <span>{dealStage(d)}</span>
              {lost && d.lostReason && <span>· {d.lostReason}</span>}
              <WaitingPill value={d.waitingOn} />
              <DaysInStage deal={d} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
