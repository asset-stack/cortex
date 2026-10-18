import { useState } from 'react';
import { PageHeader, Segmented } from '@/components/ui';
import { useAccess } from '@/lib/access';
import Emails from '@/components/outreach/Emails';
import Contacts from '@/components/outreach/Contacts';

const VIEWS = [{ id: 'emails', label: 'Emails' }, { id: 'contacts', label: 'Contacts' }];

// Emails: what the outreach agent sends from each mailbox (read from its Google Sheet). Contacts: the people the team
// works by hand; Replied or Meeting booked moves them into Pipeline.
export default function Outreach() {
  const editable = useAccess().canEdit('outreach');
  const [view, setView] = useState('emails');
  const [adding, setAdding] = useState(false);
  const contacts = view === 'contacts';
  return (
    <div>
      <PageHeader title="Outreach" action={contacts && editable ? 'Add contact' : undefined} onAction={() => setAdding(true)} />
      <div className="mt-6"><Segmented label="Outreach views" value={view} onChange={setView} options={VIEWS} /></div>
      {contacts ? <div className="mt-6"><Contacts adding={adding} onCloseAdd={() => setAdding(false)} /></div> : <Emails />}
    </div>
  );
}
