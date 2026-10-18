import { useState } from 'react';
import { Briefcase, Clock, FileUp, Mail, Repeat, Users } from 'lucide-react';
import { PageHeader, Segmented } from '@/components/ui';
import { useAccess } from '@/lib/access';
import { hashParam } from '@/lib/router';
import Team from '@/components/settings/Team';
import Routines from '@/components/settings/Routines';
import Timesheets from '@/components/settings/Timesheets';
import Business from '@/components/settings/Business';
import OutreachSettings from '@/components/settings/Outreach';
import Import from '@/components/settings/Import';

// Icons only below sm, so all six fit a phone.
const SECTIONS = [
  { id: 'team', label: 'Team', icon: Users, Component: Team },
  { id: 'routines', label: 'Routines', icon: Repeat, Component: Routines },
  { id: 'timesheets', label: 'Timesheets', icon: Clock, Component: Timesheets },
  { id: 'business', label: 'Business', icon: Briefcase, Component: Business },
  { id: 'outreach', label: 'Outreach', icon: Mail, Component: OutreachSettings },
  { id: 'import', label: 'Import', icon: FileUp, Component: Import },
];

// Admins only. Inside, roles, active flags and module access are the SuperAdmin's (Team is read-only for admins).
export default function Settings() {
  const { isAdmin } = useAccess();
  const [section, setSection] = useState(() => (SECTIONS.some((s) => s.id === hashParam('tab')) ? hashParam('tab') : 'team')); // #/settings?tab=import
  // The route guard in App keeps staff out; this covers a render before it applies.
  if (!isAdmin) return <PageHeader title="Settings" />;
  const { Component } = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="mt-6"><Segmented label="Settings sections" value={section} onChange={setSection} options={SECTIONS} /></div>
      <div className="mt-6 max-w-[920px]"><Component /></div>
    </div>
  );
}
