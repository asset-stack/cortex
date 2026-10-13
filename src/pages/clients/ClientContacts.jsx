// A client's people (client.contacts, not the outreach contacts in state.contacts): name, role, email, phone and
// Billing (invoices go to the billing contacts; with none marked, to the first person with an email). Edited in
// place at edit access, read-only at view access.
import { useState } from 'react';
import { Mail, Phone, Plus, Trash2 } from 'lucide-react';
import { useStore } from '@/data/store';
import { isEmail } from '@/lib/taxInvoice';
import { cn } from '@/lib/cn';
import { Switch } from './shared';

const str = (v) => String(v ?? '').trim();
const badEmail = (v) => str(v) !== '' && !isEmail(v);
// A tel: link keeps only what a dialler uses.
const telHref = (v) => {
  const d = str(v).replace(/[^\d+]/g, '');
  return d ? `tel:${d}` : null;
};

/** A text box that keeps what is typed and saves on blur or Enter: the store trims as it saves, so saving every
 *  keystroke would eat the space between two words. `invalid(text)` outlines it. */
function TextCell({ value, onCommit, invalid, className, ...props }) {
  const saved = value ?? '';
  const [text, setText] = useState(null); // what is typed while focused; null shows the saved value
  const shown = text ?? saved;
  const bad = Boolean(invalid?.(shown));
  const commit = () => {
    if (text === null) return;
    setText(null);
    if (text !== saved) onCommit(text);
  };
  return (
    <input className={cn('field !py-1.5', bad && '!border-rose-400', className)} autoComplete="off" aria-invalid={bad || undefined}
      value={shown} onFocus={() => setText(saved)} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} {...props} />
  );
}

function PersonRow({ c, x }) {
  const { actions } = useStore();
  const set = (patch) => actions.updateClientContact(c.id, x.id, patch);
  const who = x.name || x.email || 'contact';
  return (
    <li className="flex flex-col gap-2 rounded-2xl chip p-3">
      <div className="flex items-center gap-2">
        <TextCell placeholder="Name" aria-label={`Name, ${who}`} value={x.name} onCommit={(name) => set({ name })} />
        <span className="text-[12px] dimmer" aria-hidden="true">Billing</span>
        <Switch checked={x.billing} label={`Billing, ${who}`} onChange={(billing) => set({ billing })} />
        <button type="button" aria-label={`Remove ${who}`} title="Remove" onClick={() => actions.removeClientContact(c.id, x.id)}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full dimmer hover:bg-white/10 hover:text-white"><Trash2 className="h-4 w-4" /></button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr_1fr]">
        <TextCell placeholder="Role" aria-label={`Role, ${who}`} value={x.role} onCommit={(role) => set({ role })} />
        <TextCell type="email" placeholder="Email" aria-label={`Email, ${who}`} value={x.email} invalid={badEmail} onCommit={(email) => set({ email })} />
        <TextCell type="tel" placeholder="Phone" aria-label={`Phone, ${who}`} value={x.phone} onCommit={(phone) => set({ phone })} />
      </div>
    </li>
  );
}

function PersonCard({ x }) {
  const tel = telHref(x.phone);
  return (
    <li className="flex items-start gap-3 rounded-2xl chip p-3">
      <div className="min-w-0 flex-1">
        <div className="font-semibold break-words">{x.name || x.email || '—'}</div>
        {x.role && <div className="text-[12px] dimmer break-words">{x.role}</div>}
        {(x.email || tel) && (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] dim">
            {x.email && (isEmail(x.email) ? (
              <a href={`mailto:${x.email}`} className="inline-flex min-w-0 items-center gap-1.5 hover:underline">
                <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 [overflow-wrap:anywhere]">{x.email}</span>
              </a>
            ) : <span className="[overflow-wrap:anywhere]">{x.email}</span>)}
            {tel && (
              <a href={tel} className="inline-flex items-center gap-1.5 hover:underline"><Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{x.phone}</a>
            )}
          </div>
        )}
      </div>
      {x.billing && <span className="shrink-0 rounded-full bg-emerald-500/60 px-2.5 py-0.5 text-[12px] font-bold">Billing</span>}
    </li>
  );
}

const BLANK = { name: '', role: '', email: '', phone: '' };

function AddPerson({ c }) {
  const { actions } = useStore();
  const [f, setF] = useState(BLANK);
  const bad = badEmail(f.email);
  const empty = !str(f.name) && !str(f.email);
  const submit = (e) => {
    e.preventDefault();
    if (empty || bad) return;
    // A client's first person gets the invoices.
    const billing = !(c.contacts || []).length;
    if (actions.addClientContact(c.id, { ...f, billing }) !== false) setF(BLANK);
  };
  const input = (k, label, props = {}) => (
    <input className={cn('field', k === 'email' && bad && '!border-rose-400', props.className)} placeholder={label} aria-label={label} autoComplete="off"
      aria-invalid={(k === 'email' && bad) || undefined} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} type={props.type} />
  );
  return (
    <form onSubmit={submit} noValidate className="mt-2 grid grid-cols-2 gap-2 rounded-2xl border border-dashed border-white/25 p-3">
      {input('name', 'Name')}
      {input('role', 'Role')}
      {input('email', 'Email', { type: 'email', className: 'col-span-2 sm:col-span-1' })}
      {input('phone', 'Phone', { type: 'tel', className: 'col-span-2 sm:col-span-1' })}
      <button type="submit" disabled={empty || bad} className="btn-primary col-span-2 justify-self-start inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold">
        <Plus className="h-4 w-4" />Add contact
      </button>
    </form>
  );
}

/** The Contacts section of a client's Overview. */
export default function ClientContacts({ c, editable }) {
  const people = c.contacts || [];
  return (
    <section>
      <h3 className="font-bold">Contacts</h3>
      {people.length === 0 && !editable && <p className="mt-1 dimmer">No contacts.</p>}
      {people.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {people.map((x) => (editable ? <PersonRow key={x.id} c={c} x={x} /> : <PersonCard key={x.id} x={x} />))}
        </ul>
      )}
      {editable && <AddPerson c={c} />}
    </section>
  );
}
