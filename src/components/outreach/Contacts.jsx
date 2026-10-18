import { useState } from 'react';
import { useStore } from '@/data/store';
import { CONTACT_STATUSES } from '@/data/boards';
import { LabelPicker, Modal, PersonPicker } from '@/components/ui';
import { useAccess } from '@/lib/access';
import { ago } from '@/lib/format';

/** Outreach contacts: owner and status (Replied or Meeting booked moves the contact into Pipeline). `adding` /
 *  `onCloseAdd`: the page header's Add contact. */
export default function Contacts({ adding, onCloseAdd }) {
  const { state, actions } = useStore();
  const editable = useAccess().canEdit('outreach'); // view: no adding, status or owner changes
  const [f, setF] = useState({ name: '', org: '', email: '' });

  return (
    <>
      <div className="min-w-0 overflow-x-auto scroll-thin rounded-[26px] glass glass-rim">
        <table className="w-full min-w-[640px] text-[13.5px]"><tbody>
          {state.contacts.map((c) => (
            <tr key={c.id} className="border-t rowline first:border-t-0 hover:bg-white/5">
              <td className="p-3.5 font-semibold">{c.name}</td><td className="p-3.5 dim">{c.org}</td>
              <td className="p-3.5"><span className="rounded-full chip px-2.5 py-1 text-[12px]">{c.stage}</span></td>
              <td className="p-3.5 dimmer tnum">{ago(c.last)}</td>
              <td className="w-12 px-1.5 text-center">
                <PersonPicker value={c.owner || ''} size={26} readOnly={!editable} onChange={(v) => actions.updateContact(c.id, { owner: v })} />
              </td>
              {/* Replied or Meeting booked creates (or advances) a deal in Pipeline and a follow-up for the owner. */}
              <td className="w-[150px] py-2 pl-1.5 pr-3.5">
                <LabelPicker label={`Status for ${c.name}`} value={c.status || ''} options={CONTACT_STATUSES} allowEmpty={false} readOnly={!editable}
                  onChange={(v) => actions.updateContact(c.id, { status: v })} />
              </td>
            </tr>
          ))}
        </tbody></table>
      </div>

      <Modal open={editable && adding} onClose={onCloseAdd} title="Add contact">
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (!f.name.trim()) return; actions.addContact({ name: f.name.trim(), org: f.org.trim(), email: f.email.trim() }); setF({ name: '', org: '', email: '' }); onCloseAdd(); }}>
          <input className="field" placeholder="Name" aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          <input className="field" placeholder="Organisation" aria-label="Organisation" value={f.org} onChange={(e) => setF({ ...f, org: e.target.value })} />
          <input className="field" placeholder="Email" aria-label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <button type="submit" className="btn-primary rounded-full h-11 font-semibold">Add contact</button>
        </form>
      </Modal>
    </>
  );
}
