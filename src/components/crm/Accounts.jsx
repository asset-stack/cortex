// Pipeline → Accounts (docs/PHASE2.md §22): every organisation (prospects, customers, partners, suppliers) with search
// and filters by kind, lifecycle and owner; an account's profile (details, guardrails, prep pack, its people and deals,
// and one timeline across them) and the account form. Pipeline view reads them; Pipeline edit changes them.
import { useState } from 'react';
import { ExternalLink, Pencil, Plus } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import {
  ACCOUNT_KINDS, CONTACT_ROLES, LIFECYCLES, accountById, accountText, dealsOfAccount, isOpenDeal, peopleOf, similarAccounts,
} from '@/lib/accounts';
import { dealStage } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { Avatar, ConfirmModal, Drawer, Modal, PersonPicker, SearchField } from '@/components/ui';
import { compactIn, safeUrl, shortDate, totalsIn } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Links, Timeline } from './Profile';
import { Detail, Guardrails, KindPill, LifecyclePill, OpenLink, TheirTime, ZoneSelect } from './bits';

const SMALL_BTN = 'inline-flex h-9 items-center gap-1.5 rounded-full chip px-3.5 text-[13px] font-semibold';
const ASIDE = ['nurture', 'rfp', 'not_now', 'suppressed'];

export function AccountsTab({ onOpen }) {
  const { state } = useStore();
  const users = useUsers();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [life, setLife] = useState(''); // '' everything but set aside, 'all', or a lifecycle
  const [owner, setOwner] = useState('');
  const term = q.trim().toLowerCase();
  const rows = (state.accounts || [])
    .filter((a) => (!term || accountText(a).includes(term)) && (!kind || a.kind === kind) && (!owner || a.owner === owner)
      && (life === 'all' || (life ? a.lifecycle === life : !ASIDE.includes(a.lifecycle))))
    .sort((a, b) => a.name.localeCompare(b.name));
  const owners = [...new Set((state.accounts || []).map((a) => a.owner).filter(Boolean))];
  const select = 'field !h-10 !w-auto !rounded-full !py-0';
  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Search accounts" />
        <select className={select} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {Object.entries(ACCOUNT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className={select} aria-label="Lifecycle" value={life} onChange={(e) => setLife(e.target.value)}>
          <option value="">Active</option>
          <option value="all">Everything</option>
          {Object.entries(LIFECYCLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className={select} aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Everyone</option>
          {owners.map((id) => <option key={id} value={id}>{id === state.me ? 'Mine' : users[id]?.name || 'Someone'}</option>)}
        </select>
      </div>
      {!rows.length ? <p className="mt-6 dimmer">{term || kind || life || owner ? 'No matches.' : 'No accounts yet.'}</p> : (
        <div className="mt-5 rounded-[24px] glass">
          <div className="hidden overflow-x-auto scroll-thin md:block">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead>
                <tr className="text-left text-[12px] dimmer">
                  <th className="px-3 py-2.5 pl-5 font-medium">Account</th>
                  <th className="px-3 py-2.5 font-medium">Lifecycle</th>
                  <th className="px-3 py-2.5 font-medium">Sector</th>
                  <th className="px-3 py-2.5 font-medium">Country</th>
                  <th className="px-3 py-2.5 font-medium">Open deals</th>
                  <th className="px-3 py-2.5 font-medium">Contacts</th>
                  <th className="px-3 py-2.5 font-medium">Owner</th>
                  <th className="px-3 py-2.5 pr-5 font-medium">Their time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const open = dealsOfAccount(state, a.id, { open: true });
                  return (
                    <tr key={a.id} className="border-t rowline align-middle hover:bg-white/5">
                      <td className="max-w-[260px] px-3 py-2.5 pl-5">
                        <div className="flex items-center gap-2">
                          <OpenLink onClick={() => onOpen('account', a.id)}>{a.name}</OpenLink>
                          {a.kind !== 'prospect' && <KindPill value={a.kind} />}
                        </div>
                      </td>
                      <td className="px-3 py-2.5"><LifecyclePill value={a.lifecycle} /></td>
                      <td className="max-w-[160px] truncate px-3 py-2.5 dim">{a.sector || '—'}</td>
                      <td className="max-w-[160px] truncate px-3 py-2.5 dim">{[a.country, a.region].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 tnum">{open.length ? `${open.length} · ${totalsIn(open)}` : <span className="dimmer">—</span>}</td>
                      <td className="px-3 py-2.5 tnum dim">{peopleOf(state, a.id).length || '—'}</td>
                      <td className="px-3 py-2.5">{a.owner ? <Avatar userId={a.owner} size={24} /> : <span className="dimmer">—</span>}</td>
                      <td className="px-3 py-2.5 pr-5"><TheirTime timezone={a.timezone} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col md:hidden">
            {rows.map((a) => (
              <li key={a.id} className="border-t rowline px-4 py-3 first:border-t-0">
                <div className="flex items-start justify-between gap-2">
                  <OpenLink onClick={() => onOpen('account', a.id)}>{a.name}</OpenLink>
                  <LifecyclePill value={a.lifecycle} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] dim">
                  {[a.sector, a.country].filter(Boolean).join(' · ')}
                  <TheirTime timezone={a.timezone} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** An account's profile: kind and lifecycle, owner, Edit; its details, guardrails and prep pack; its people (Add
 *  contact) and deals (New deal); one timeline across the account, its people and its deals; its links. */
export function AccountProfile({ accountId, onClose, onOpen, onEdit, onNewDeal, onNewPerson }) {
  const { state } = useStore();
  const users = useUsers();
  const access = useAccess();
  const a = accountById(state, accountId);
  const editable = access.canEdit('pipeline');
  const people = a ? peopleOf(state, a.id) : [];
  const deals = a ? dealsOfAccount(state, a.id) : [];
  const referrer = a && accountById(state, a.referredBy);
  const referred = a ? (state.accounts || []).filter((x) => x.referredBy === a.id) : [];
  const client = a?.clientId && state.clients.find((c) => c.id === a.clientId);
  const prep = a && safeUrl(a.prepUrl);
  const site = a && safeUrl(a.website);
  return (
    <Drawer open={Boolean(a)} onClose={onClose} title={a?.name || ''} width={640}>
      {a && (
        <div className="flex flex-col gap-7">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <KindPill value={a.kind} />
            <LifecyclePill value={a.lifecycle} />
            {a.owner && <span className="flex items-center gap-1.5 text-[13px] dim"><Avatar userId={a.owner} size={24} ring={false} />{users[a.owner]?.name}</span>}
            <TheirTime timezone={a.timezone} />
            {editable && (
              <button type="button" onClick={() => onEdit(a)} className={cn(SMALL_BTN, 'ml-auto')}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit account</button>
            )}
          </div>
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px]">
            <Detail label="Why">{a.lifecycleNote}</Detail>
            <Detail label="Revisit on">{a.revisitOn && shortDate(a.revisitOn)}</Detail>
            <Detail label="Sector">{a.sector}</Detail>
            <Detail label="Where">{[a.region, a.country].filter(Boolean).join(', ')}</Detail>
            <Detail label="Size">{a.size}</Detail>
            <Detail label="Website">{site && <a href={site} target="_blank" rel="noopener noreferrer" className="hover:underline">{a.domain || site}</a>}</Detail>
            <Detail label="Domain">{!site && a.domain}</Detail>
            <Detail label="Referred by">{referrer && <OpenLink onClick={() => onOpen('account', referrer.id)}>{referrer.name}</OpenLink>}</Detail>
            <Detail label="Referred">{referred.length > 0 && referred.map((x, i) => (
              <span key={x.id}>{i ? ', ' : ''}<OpenLink onClick={() => onOpen('account', x.id)}>{x.name}</OpenLink></span>
            ))}</Detail>
            <Detail label="Client">{client && <a href="#/clients" className="font-semibold hover:underline">{client.name}</a>}</Detail>
          </dl>
          <Guardrails text={a.guardrails} />
          {prep && (
            <a href={prep} target="_blank" rel="noopener noreferrer" className={cn(SMALL_BTN, 'self-start')}>
              Prep pack<ExternalLink className="h-3 w-3 dimmer" aria-hidden="true" />
            </a>
          )}
          <section>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-bold">Contacts</h3>
              {editable && <button type="button" onClick={() => onNewPerson(a.id)} className={SMALL_BTN}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add contact</button>}
            </div>
            {!people.length ? <p className="mt-1 dimmer">None yet.</p> : (
              <ul className="mt-2 flex flex-col gap-1">
                {people.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-xl px-2 py-1.5 hover:bg-white/5">
                    <OpenLink onClick={() => onOpen('person', p.id)} className={cn(p.status !== 'active' && 'line-through opacity-70')}>{p.name || p.email}</OpenLink>
                    <span className="text-[12.5px] dim">{[p.title, CONTACT_ROLES[p.role]].filter(Boolean).join(' · ')}</span>
                    <TheirTime timezone={p.timezone || a.timezone} className="ml-auto" />
                  </li>
                ))}
              </ul>
            )}
            {client?.contacts?.length > 0 && (
              <>
                <h4 className="mt-3 text-[12.5px] font-semibold dimmer">On {client.name}’s client record</h4>
                <ul className="mt-1 flex flex-col gap-1">
                  {client.contacts.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-xl px-2 py-1.5 text-[13px]">
                      <span className="font-semibold">{p.name || p.email}</span>
                      <span className="dim">{[p.role, p.name && p.email].filter(Boolean).join(' · ')}</span>
                      {p.billing && <span className="rounded-full chip px-2 text-[11px] font-semibold">Billing</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-bold">Deals</h3>
              {editable && <button type="button" onClick={() => onNewDeal(a.id)} className={SMALL_BTN}><Plus className="h-3.5 w-3.5" aria-hidden="true" />New deal</button>}
            </div>
            {!deals.length ? <p className="mt-1 dimmer">None yet.</p> : (
              <ul className="mt-2 flex flex-col gap-1">
                {deals.map((d) => (
                  <li key={d.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-white/5">
                    {isOpenDeal(d) ? <OpenLink onClick={() => onOpen('deal', d.id)}>{d.name}</OpenLink> : <span className="min-w-0 truncate font-semibold dim">{d.name}</span>}
                    <span className="text-[12.5px] dim">{d.clientId ? 'Won' : dealStage(d)}</span>
                    <span className="ml-auto font-semibold tnum">{compactIn(d.value, d.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <Timeline target={{ accountId: a.id }} />
          <Links target={{ accountId: a.id }} />
        </div>
      )}
    </Drawer>
  );
}

const ACCOUNT_FIELDS = ['name', 'kind', 'lifecycle', 'lifecycleNote', 'revisitOn', 'sector', 'country', 'region', 'timezone', 'domain', 'website',
  'size', 'guardrails', 'prepUrl', 'referredBy', 'owner'];
const blankAccount = (me) => Object.fromEntries(ACCOUNT_FIELDS.map((k) => [k, { kind: 'prospect', lifecycle: 'new', owner: me }[k] ?? '']));

/** New account or Edit account (saves only what changed); Delete account (asks: its contacts and their notes go, its
 *  deals stay without an account). → calls onSaved(id) with the new account's id. */
export function AccountForm({ account, onClose, onSaved }) {
  const { state, actions } = useStore();
  const editing = Boolean(account);
  const [start] = useState(() => (editing ? Object.fromEntries(ACCOUNT_FIELDS.map((k) => [k, account[k] ?? ''])) : blankAccount(state.me)));
  const [f, setF] = useState(start);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const set = (k) => (e) => { setErr(''); setF((x) => ({ ...x, [k]: e.target.value })); };
  const others = (state.accounts || []).filter((x) => x.id !== account?.id && (x.kind === 'partner' || x.id === f.referredBy));
  const dupes = similarAccounts(state, f, account?.id); // a warning only: the same name or domain
  const submit = (e) => {
    e.preventDefault();
    if (!f.name.trim()) { setErr('Add the account’s name'); return; }
    if (editing) {
      const patch = Object.fromEntries(ACCOUNT_FIELDS.filter((k) => f[k] !== start[k]).map((k) => [k, f[k]]));
      if (Object.keys(patch).length) actions.updateAccount(account.id, patch);
      onClose();
      return;
    }
    const id = actions.addAccount(f);
    if (!id) { setErr('Couldn’t add this account'); return; }
    onClose();
    onSaved?.(id);
  };
  const aside = ['nurture', 'rfp', 'not_now', 'suppressed'].includes(f.lifecycle);
  return (
    <>
      <Modal open onClose={onClose} title={editing ? 'Edit account' : 'New account'} width={560}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <input className="field" placeholder="Name" aria-label="Name" value={f.name} onChange={set('name')} autoFocus />
          {dupes.length > 0 && (
            <div role="status" className="-mt-1.5 text-[12.5px] text-amber-200">Already in Cortex: {dupes.map((x) => x.name).join(', ')}</div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <select className="field" aria-label="Kind" value={f.kind} onChange={set('kind')}>
              {Object.entries(ACCOUNT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select className="field" aria-label="Lifecycle" value={f.lifecycle} onChange={set('lifecycle')}>
              {Object.entries(LIFECYCLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {aside && <input className="field col-span-2" placeholder="Why (e.g. renewed their system)" aria-label="Why" value={f.lifecycleNote} onChange={set('lifecycleNote')} />}
            {aside && <input className="field" type="date" aria-label="Revisit on" title="Revisit on" value={f.revisitOn} onChange={set('revisitOn')} />}
            <input className="field" placeholder="Sector" aria-label="Sector" value={f.sector} onChange={set('sector')} />
            <input className="field" placeholder="Country" aria-label="Country" value={f.country} onChange={set('country')} />
            <input className="field" placeholder="State / region" aria-label="State or region" value={f.region} onChange={set('region')} />
            <ZoneSelect value={f.timezone} onChange={(v) => setF((x) => ({ ...x, timezone: v }))} />
            <input className="field" placeholder="Size" aria-label="Size" value={f.size} onChange={set('size')} />
            <input className="field" placeholder="Website" aria-label="Website" inputMode="url" value={f.website} onChange={set('website')} />
            <input className="field" placeholder="Email domain" aria-label="Email domain" value={f.domain} onChange={set('domain')} />
            <select className="field" aria-label="Referred by" value={f.referredBy} onChange={set('referredBy')}>
              <option value="">Referred by</option>
              {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <div className="field flex items-center gap-2 !py-1"><span className="dimmer">Owner</span>
              <PersonPicker value={f.owner} onChange={(v) => setF((x) => ({ ...x, owner: v }))} size={26} />
            </div>
          </div>
          <textarea className="field resize-y !rounded-[18px]" rows={3} placeholder="Guardrails: what not to say" aria-label="Guardrails" value={f.guardrails} onChange={set('guardrails')} />
          <input className="field" placeholder="Prep pack link" aria-label="Prep pack link" inputMode="url" value={f.prepUrl} onChange={set('prepUrl')} />
          {err && <div role="alert" className="text-[12.5px] text-rose-200">{err}</div>}
          <button type="submit" className="btn-primary rounded-full h-11 font-semibold">{editing ? 'Save' : 'Add account'}</button>
          {editing && (
            <button type="button" onClick={() => setConfirm(true)} className="self-start rounded-full px-3 h-9 font-semibold text-rose-200 hover:bg-white/10">Delete account</button>
          )}
        </form>
      </Modal>
      {editing && (
        <ConfirmModal open={confirm} onClose={() => setConfirm(false)} title={`Delete ${account.name}?`}
          onConfirm={() => { actions.removeAccount(account.id); onClose(); }}>
          Its contacts and their notes go too. Its deals stay, without an account.
        </ConfirmModal>
      )}
    </>
  );
}
