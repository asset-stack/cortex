// Pipeline → Contacts (docs/PHASE2.md §22): the people at every account, with search and filters by role and status; a
// contact's profile (details, the time where they are, their deals and their own timeline) and the contact form.
import { useState } from 'react';
import { ExternalLink, Mail, Pencil, Phone } from 'lucide-react';
import { useStore } from '@/data/store';
import { CONTACT_ROLES, PERSON_STATUSES, accountById, dealsOfPerson, personText } from '@/lib/accounts';
import { dealStage } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { ConfirmModal, Drawer, Modal, PersonPicker, SearchField } from '@/components/ui';
import { safeUrl } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Links, Timeline } from './Profile';
import { Detail, OpenLink, Pill, TheirTime, ZoneSelect } from './bits';

const SMALL_BTN = 'inline-flex h-9 items-center gap-1.5 rounded-full chip px-3.5 text-[13px] font-semibold';
const zoneOf = (state, p) => p.timezone || accountById(state, p.accountId)?.timezone || '';

export function PeopleTab({ onOpen }) {
  const { state } = useStore();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('active');
  const term = q.trim().toLowerCase();
  const rows = (state.crmContacts || [])
    .filter((p) => (!term || personText(state, p).includes(term)) && (!role || p.role === role) && (!status || p.status === status))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  const select = 'field !h-10 !w-auto !rounded-full !py-0';
  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Search contacts" />
        <select className={select} aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">All roles</option>
          {Object.entries(CONTACT_ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className={select} aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {Object.entries(PERSON_STATUSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {!rows.length ? <p className="mt-6 dimmer">{term || role ? 'No matches.' : 'No contacts yet.'}</p> : (
        <div className="mt-5 rounded-[24px] glass">
          <div className="hidden overflow-x-auto scroll-thin md:block">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead>
                <tr className="text-left text-[12px] dimmer">
                  <th className="px-3 py-2.5 pl-5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">Account</th>
                  <th className="px-3 py-2.5 font-medium">Role</th>
                  <th className="px-3 py-2.5 font-medium">Email</th>
                  <th className="px-3 py-2.5 font-medium">Phone</th>
                  <th className="px-3 py-2.5 pr-5 font-medium">Their time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const a = accountById(state, p.accountId);
                  return (
                    <tr key={p.id} className="border-t rowline align-middle hover:bg-white/5">
                      <td className="max-w-[240px] px-3 py-2.5 pl-5">
                        <OpenLink onClick={() => onOpen('person', p.id)} className="block">{p.name || p.email}</OpenLink>
                        {p.title && <div className="truncate text-[12px] dimmer">{p.title}</div>}
                      </td>
                      <td className="max-w-[200px] px-3 py-2.5">{a ? <OpenLink onClick={() => onOpen('account', a.id)} className="block font-normal">{a.name}</OpenLink> : '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 dim">{CONTACT_ROLES[p.role] || '—'}</td>
                      <td className="max-w-[220px] truncate px-3 py-2.5 dim">{p.email || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 dim">{p.phone || '—'}</td>
                      <td className="px-3 py-2.5 pr-5"><TheirTime timezone={zoneOf(state, p)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col md:hidden">
            {rows.map((p) => {
              const a = accountById(state, p.accountId);
              return (
                <li key={p.id} className="border-t rowline px-4 py-3 first:border-t-0">
                  <OpenLink onClick={() => onOpen('person', p.id)}>{p.name || p.email}</OpenLink>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] dim">
                    {[p.title, a?.name].filter(Boolean).join(' · ')}
                    <TheirTime timezone={zoneOf(state, p)} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A contact's profile: their account, role and status, how to reach them and the time where they are; the deals
 *  they're on; their own timeline and links. */
export function PersonProfile({ personId, onClose, onOpen, onEdit }) {
  const { state } = useStore();
  const access = useAccess();
  const p = personId ? (state.crmContacts || []).find((x) => x.id === personId) : null;
  const a = p && accountById(state, p.accountId);
  const deals = p ? dealsOfPerson(state, p.id) : [];
  const linkedin = p && safeUrl(p.linkedin);
  return (
    <Drawer open={Boolean(p)} onClose={onClose} title={p ? p.name || p.email : ''} width={560}>
      {p && (
        <div className="flex flex-col gap-7">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {p.role && <Pill className="chip">{CONTACT_ROLES[p.role]}</Pill>}
            {p.status !== 'active' && <Pill className="bg-rose-700/70">{PERSON_STATUSES[p.status]}</Pill>}
            <TheirTime timezone={zoneOf(state, p)} />
            {access.canEdit('pipeline') && (
              <button type="button" onClick={() => onEdit(p)} className={cn(SMALL_BTN, 'ml-auto')}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit contact</button>
            )}
          </div>
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px]">
            <Detail label="Account">{a && <OpenLink onClick={() => onOpen('account', a.id)}>{a.name}</OpenLink>}</Detail>
            <Detail label="Title">{p.title}</Detail>
          </dl>
          <div className="flex flex-wrap gap-2">
            {p.email && <a href={`mailto:${p.email}`} className={SMALL_BTN}><Mail className="h-3.5 w-3.5" aria-hidden="true" />{p.email}</a>}
            {p.phone && <a href={`tel:${p.phone.replace(/[^\d+]/g, '')}`} className={SMALL_BTN}><Phone className="h-3.5 w-3.5" aria-hidden="true" />{p.phone}</a>}
            {linkedin && <a href={linkedin} target="_blank" rel="noopener noreferrer" className={SMALL_BTN}>LinkedIn<ExternalLink className="h-3 w-3 dimmer" aria-hidden="true" /></a>}
          </div>
          {deals.length > 0 && (
            <section>
              <h3 className="font-bold">Deals</h3>
              <ul className="mt-2 flex flex-col gap-1">
                {deals.map((d) => (
                  <li key={d.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-white/5">
                    {d.clientId ? <span className="min-w-0 truncate font-semibold dim">{d.name}</span> : <OpenLink onClick={() => onOpen('deal', d.id)}>{d.name}</OpenLink>}
                    <span className="text-[12.5px] dim">{d.clientId ? 'Won' : dealStage(d)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Timeline target={{ contactId: p.id }} />
          <Links target={{ contactId: p.id }} />
        </div>
      )}
    </Drawer>
  );
}

const PERSON_FIELDS = ['accountId', 'name', 'title', 'email', 'phone', 'linkedin', 'timezone', 'role', 'status', 'owner'];

/** New contact (at `accountId`, or picked) or Edit contact (saves only what changed); Delete contact (asks: their notes
 *  go; they come off their deals). */
export function PersonForm({ person, accountId = '', onClose, onSaved }) {
  const { state, actions } = useStore();
  const editing = Boolean(person);
  const [start] = useState(() => (editing
    ? Object.fromEntries(PERSON_FIELDS.map((k) => [k, person[k] ?? '']))
    : { accountId, name: '', title: '', email: '', phone: '', linkedin: '', timezone: '', role: '', status: 'active', owner: state.me }));
  const [f, setF] = useState(start);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const set = (k) => (e) => { setErr(''); setF((x) => ({ ...x, [k]: e.target.value })); };
  const accounts = [...(state.accounts || [])].sort((x, y) => x.name.localeCompare(y.name));
  const submit = (e) => {
    e.preventDefault();
    if (!f.accountId) { setErr('Pick the account'); return; }
    if (!f.name.trim() && !f.email.trim()) { setErr('Add a name or an email'); return; }
    if (editing) {
      const patch = Object.fromEntries(PERSON_FIELDS.filter((k) => f[k] !== start[k]).map((k) => [k, f[k]]));
      if (Object.keys(patch).length) actions.updatePerson(person.id, patch);
      onClose();
      return;
    }
    const id = actions.addPerson(f);
    if (!id) { setErr('Couldn’t add this contact'); return; }
    onClose();
    onSaved?.(id);
  };
  return (
    <>
      <Modal open onClose={onClose} title={editing ? 'Edit contact' : 'New contact'} width={520}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <select className="field" aria-label="Account" value={f.accountId} onChange={set('accountId')} autoFocus={!f.accountId}>
            <option value="">Account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <input className="field" placeholder="Name" aria-label="Name" value={f.name} onChange={set('name')} autoFocus={Boolean(f.accountId)} />
            <input className="field" placeholder="Title" aria-label="Title" value={f.title} onChange={set('title')} />
            <input className="field" type="email" placeholder="Email" aria-label="Email" value={f.email} onChange={set('email')} />
            <input className="field" type="tel" placeholder="Phone" aria-label="Phone" value={f.phone} onChange={set('phone')} />
            <select className="field" aria-label="Role in the deal" value={f.role} onChange={set('role')}>
              <option value="">Role in the deal</option>
              {Object.entries(CONTACT_ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <ZoneSelect value={f.timezone} onChange={(v) => setF((x) => ({ ...x, timezone: v }))} label="Time zone (else the account’s)" />
            <select className="field" aria-label="Status" value={f.status} onChange={set('status')}>
              {Object.entries(PERSON_STATUSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <div className="field flex items-center gap-2 !py-1"><span className="dimmer">Owner</span>
              <PersonPicker value={f.owner} onChange={(v) => setF((x) => ({ ...x, owner: v }))} size={26} />
            </div>
          </div>
          <input className="field" placeholder="LinkedIn" aria-label="LinkedIn" inputMode="url" value={f.linkedin} onChange={set('linkedin')} />
          {err && <div role="alert" className="text-[12.5px] text-rose-200">{err}</div>}
          <button type="submit" className="btn-primary rounded-full h-11 font-semibold">{editing ? 'Save' : 'Add contact'}</button>
          {editing && (
            <button type="button" onClick={() => setConfirm(true)} className="self-start rounded-full px-3 h-9 font-semibold text-rose-200 hover:bg-white/10">Delete contact</button>
          )}
        </form>
      </Modal>
      {editing && (
        <ConfirmModal open={confirm} onClose={() => setConfirm(false)} title={`Delete ${person.name || person.email}?`}
          onConfirm={() => { actions.removePerson(person.id); onClose(); }}>
          Their notes go too, and they come off their deals.
        </ConfirmModal>
      )}
    </>
  );
}
