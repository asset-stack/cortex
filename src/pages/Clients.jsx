// Clients (docs/PHASE2.md §6): Clients · Invoices · Money in · Expenses · Usage. Money in and Expenses are for admins
// only, as is Software costs inside Usage. Staff with view access see the rest read-only. Admins also generate the
// invoices billing plans have due, once per session when Clients opens. The tabs live in src/pages/clients/.
import { useState } from 'react';
import { Building2, Gauge, Landmark, Receipt, Wallet } from 'lucide-react';
import { useAccess } from '@/lib/access';
import { PageHeader, Segmented } from '@/components/ui';
import { hashParam } from '@/lib/router';
import ClientsTab from '@/pages/clients/ClientsTab';
import InvoicesTab, { useAutoGenerate } from '@/pages/clients/InvoicesTab';
import MoneyInTab from '@/pages/clients/MoneyInTab';
import ExpensesTab from '@/pages/clients/ExpensesTab';
import UsageTab from '@/pages/clients/UsageTab';

const TABS = [
  { id: 'clients', label: 'Clients', icon: Building2 },
  { id: 'invoices', label: 'Invoices', icon: Receipt },
  { id: 'money', label: 'Money in', icon: Landmark, admin: true },
  { id: 'expenses', label: 'Expenses', icon: Wallet, admin: true },
  { id: 'usage', label: 'Usage', icon: Gauge },
];

export default function Clients() {
  const access = useAccess();
  useAutoGenerate();
  const tabs = TABS.filter((t) => !t.admin || access.isAdmin);
  const [picked, setPicked] = useState(() => hashParam('tab') || 'clients'); // #/clients?tab=invoices
  const tab = tabs.some((t) => t.id === picked) ? picked : 'clients';
  const [adding, setAdding] = useState(false);
  const action = { clients: access.canEdit('clients') ? 'Add client' : '', money: 'Upload screenshot', expenses: 'Add expense' }[tab] || undefined;
  const closeAdd = () => setAdding(false);

  return (
    <div>
      <PageHeader title="Clients" action={action} onAction={() => setAdding(true)} />
      <div className="mt-6">
        <Segmented label="Clients sections" value={tab} onChange={(id) => { setPicked(id); setAdding(false); }} options={tabs} />
      </div>
      {tab === 'clients' && <ClientsTab adding={adding} onCloseAdd={closeAdd} />}
      {tab === 'invoices' && <InvoicesTab />}
      {tab === 'money' && <MoneyInTab adding={adding} onCloseAdd={closeAdd} />}
      {tab === 'expenses' && <ExpensesTab adding={adding} onCloseAdd={closeAdd} />}
      {tab === 'usage' && <UsageTab />}
    </div>
  );
}
