// Pipeline → Deal notes (docs/PHASE2.md §31): every open deal (or the lost ones) with its product type, owner, contacts,
// latest note or meeting and next step, newest note first (or oldest, to find the quiet ones); search, product type
// and owner filters. A deal opens its profile, where notes, meetings and contacts are added.
import { useState } from 'react';
import { useStore, useUsers } from '@/data/store';
import { LOST, PRODUCT_TYPES, dealStage } from '@/data/boards';
import { accountOf, dealPeople, isOpenDeal } from '@/lib/accounts';
import { latestNote } from '@/lib/crm';
import { localYmd, shortDate } from '@/lib/format';
import { Avatar, SearchField, Segmented } from '@/components/ui';
import { OpenLink, Pill } from './bits';

const SHOW = [{ id: 'open', label: 'Open' }, { id: 'lost', label: 'Lost' }];
const SORTS = { newest: 'Latest note first', oldest: 'Oldest note first' };
const SELECT = 'field !h-10 !w-auto !rounded-full !py-0';
// The day a note or meeting belongs to: a meeting's date, else the day it was added.
const dayOf = (e) => (e.kind === 'meeting' && e.happenedOn) || (e.createdAt ? localYmd(new Date(e.createdAt)) : '');

export default function DealNotes({ onOpen }) {
  const { state } = useStore();
  const users = useUsers();
  const [show, setShow] = useState('open');
  const [q, setQ] = useState('');
  const [product, setProduct] = useState('');
  const [owner, setOwner] = useState('');
  const [sort, setSort] = useState('newest');
  const term = q.trim().toLowerCase();

  const deals = state.deals.filter((d) => (show === 'lost' ? !d.clientId && dealStage(d) === LOST : isOpenDeal(d)));
  const rows = deals.map((d) => {
    const note = latestNote(state, d.id);
    return { d, account: accountOf(state, d), people: dealPeople(state, d), note, day: note ? dayOf(note) : '' };
  }).filter(({ d, account, people, note }) => (!product || (product === '-' ? !d.productType : d.productType === product))
    && (!owner || d.contact === owner)
    && (!term || [d.name, account?.name, d.productType, d.next, note?.title, note?.body, ...people.map((p) => p.name)]
      .join(' ').toLowerCase().includes(term)))
    .sort((a, b) => {
      // Deals with no note go last either way.
      if (!a.day !== !b.day) return a.day ? -1 : 1;
      const c = sort === 'oldest' ? a.day.localeCompare(b.day) : b.day.localeCompare(a.day);
      return c || a.d.name.localeCompare(b.d.name);
    });
  const owners = [...new Set(deals.map((d) => d.contact).filter(Boolean))];

  const contacts = (people) => (people.length
    ? <span className="dim">{people.slice(0, 2).map((p) => p.name || p.email).join(', ')}{people.length > 2 ? ` +${people.length - 2}` : ''}</span>
    : <span className="dimmer">—</span>);
  const noteText = (note) => (note
    ? <>
        <span className="text-[12px] dimmer tnum">{shortDate(note.kind === 'meeting' && note.happenedOn ? note.happenedOn : note.createdAt)}{note.kind === 'meeting' ? ' · Meeting' : ''}</span>
        <span className="mt-0.5 line-clamp-2 block whitespace-pre-line">{note.kind === 'meeting' ? [note.title, note.body].filter(Boolean).join(': ') : note.body}</span>
      </>
    : <span className="dimmer">No notes yet</span>);

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Search notes" />
        <select className={SELECT} aria-label="Product type" value={product} onChange={(e) => setProduct(e.target.value)}>
          <option value="">All products</option>
          {PRODUCT_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
          <option value="-">Not set</option>
        </select>
        <select className={SELECT} aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Everyone</option>
          {owners.map((id) => <option key={id} value={id}>{id === state.me ? 'Mine' : users[id]?.name || 'Someone'}</option>)}
        </select>
        <select className={SELECT} aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
          {Object.entries(SORTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <Segmented label="Show" value={show} onChange={setShow} options={SHOW} />
      </div>

      {!rows.length ? <p className="mt-6 dimmer">{deals.length ? 'No matches.' : 'No deals yet.'}</p> : (
        <div className="mt-5 rounded-[24px] glass">
          <div className="hidden overflow-x-auto scroll-thin lg:block">
            <table className="w-full min-w-[1080px] table-fixed text-[13px]">
              <colgroup>
                <col className="w-[19%]" /><col className="w-[13%]" /><col className="w-[10%]" /><col className="w-[13%]" /><col className="w-[30%]" /><col className="w-[15%]" />
              </colgroup>
              <thead>
                <tr className="text-left text-[12px] dimmer">
                  <th className="px-3 py-2.5 pl-5 font-medium">Deal</th>
                  <th className="px-3 py-2.5 font-medium">Product</th>
                  <th className="px-3 py-2.5 font-medium">Owner</th>
                  <th className="px-3 py-2.5 font-medium">Contacts</th>
                  <th className="px-3 py-2.5 font-medium">Latest note</th>
                  <th className="px-3 py-2.5 pr-5 font-medium">Next step</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ d, account, people, note }) => (
                  <tr key={d.id} className="border-t rowline align-top hover:bg-white/5">
                    <td className="px-3 py-3 pl-5">
                      <OpenLink onClick={() => onOpen('deal', d.id)} className="block whitespace-normal [overflow-wrap:anywhere]">{d.name}</OpenLink>
                      <div className="mt-0.5 truncate text-[12px] dimmer">{[account && account.name !== d.name ? account.name : '', dealStage(d)].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="px-3 py-3 dim">{d.productType || <span className="dimmer">—</span>}</td>
                    <td className="px-3 py-3">
                      {d.contact ? <span className="flex items-center gap-1.5 dim"><Avatar userId={d.contact} size={22} ring={false} /><span className="truncate">{users[d.contact]?.name?.split(' ')[0]}</span></span> : <span className="dimmer">—</span>}
                    </td>
                    <td className="px-3 py-3">{contacts(people)}</td>
                    <td className="px-3 py-3">{noteText(note)}</td>
                    <td className="px-3 py-3 pr-5 dim">{d.next || <span className="dimmer">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col lg:hidden">
            {rows.map(({ d, people, note }) => (
              <li key={d.id} className="border-t rowline px-4 py-3.5 first:border-t-0">
                <div className="flex items-start justify-between gap-2">
                  <OpenLink onClick={() => onOpen('deal', d.id)} className="min-w-0 whitespace-normal">{d.name}</OpenLink>
                  {d.contact && <Avatar userId={d.contact} size={22} ring={false} />}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px]">
                  <Pill className="chip">{dealStage(d)}</Pill>
                  {d.productType && <Pill className="chip max-w-full"><span className="truncate">{d.productType}</span></Pill>}
                  {people.length > 0 && contacts(people)}
                </div>
                <div className="mt-2 text-[13px]">{noteText(note)}</div>
                {d.next && <div className="mt-1.5 text-[12.5px] dim">Next: {d.next}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
