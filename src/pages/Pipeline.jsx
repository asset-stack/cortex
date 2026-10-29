// Pipeline (docs/PHASE2.md §14, §22): the CRM. Opportunities (the deals by stage, or as a table), Accounts (the
// organisations), Contacts (the people at them), each opening its profile, and Reports; Work in Progress (and any other Pipeline
// board) under the deals. Pipeline view reads it all; Pipeline edit changes it; Make client also needs Clients edit.
// Accounts and Contacts arrive with 0014: until it has run they're hidden and the deals work as before.
import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Building2, Target, Users } from 'lucide-react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { PageHeader, Segmented } from '@/components/ui';
import { hashParam } from '@/lib/router';
import { teamBoards } from '@/lib/boards';
import { isOpenDeal } from '@/lib/accounts';
import Board from '@/components/board/Board';
import DealProfile from '@/components/crm/DealProfile';
import DealForm, { ConfirmMakeClient } from '@/components/crm/DealForm';
import Opportunities from '@/components/crm/Opportunities';
import { AccountForm, AccountProfile, AccountsTab } from '@/components/crm/Accounts';
import { PeopleTab, PersonForm, PersonProfile } from '@/components/crm/People';
import Reports from '@/components/crm/Reports';

const TABS = [
  { id: 'deals', label: 'Opportunities', icon: Target },
  { id: 'accounts', label: 'Accounts', icon: Building2, crm: true },
  { id: 'people', label: 'Contacts', icon: Users, crm: true },
  { id: 'reports', label: 'Reports', icon: BarChart3, crm: true },
];
const ACTIONS = { deals: 'New deal', accounts: 'New account', people: 'New contact' };

// After a dialog closes, keyboard focus goes back to the deal's Edit button (its card may have moved column), else to
// the page's title.
function refocus(dealId) {
  window.setTimeout(() => {
    const edit = dealId && document.querySelector(`[data-deal="${CSS.escape(dealId)}"] button[data-edit]`);
    (edit || document.querySelector('main h1'))?.focus({ preventScroll: true });
  }, 0);
}

export default function Pipeline() {
  const { state, actions, missing } = useStore();
  const access = useAccess();
  const crm = !missing.includes('accounts');
  const editable = access.canEdit('pipeline'); // view: no drag, stage select, Edit, New or Make client
  const canConvert = editable && access.canEdit('clients'); // convertDeal needs both
  const tabs = TABS.filter((t) => crm || !t.crm);
  const [picked, setPicked] = useState(() => hashParam('tab') || 'deals'); // #/pipeline?tab=accounts
  const tab = tabs.some((t) => t.id === picked) ? picked : 'deals';
  // What's open: a profile ({ kind: 'deal' | 'account' | 'person', id }) and, on top of it, a form. A link can open one:
  // #/pipeline?deal=<id> (the Dashboard's My deals), ?account=<id>, ?person=<id>.
  const [open, setOpen] = useState(() => {
    const kind = ['deal', 'account', 'person'].find((k) => hashParam(k));
    return kind ? { kind, id: hashParam(kind) } : null;
  });
  const [form, setForm] = useState(null); // { kind, record?, accountId? }
  const [making, setMaking] = useState(null); // id of the deal Make client asks about
  const onOpen = useCallback((kind, id) => setOpen({ kind, id }), []);
  // Closed: drop the link's ?deal= (…) so a reload or Back doesn't reopen it (replaceState fires no hashchange).
  useEffect(() => {
    if (open || !['deal', 'account', 'person'].some((k) => hashParam(k))) return;
    window.history.replaceState(window.history.state, '', `#/pipeline${tab === 'deals' ? '' : `?tab=${tab}`}`);
  }, [open, tab]);
  const closeForm = useCallback(() => setForm(null), []);
  // Work in Progress (and any other Pipeline board) under the deals, for whoever can see Pipeline.
  const lists = teamBoards(state, 'pipeline').filter(access.canViewBoard);
  const makingDeal = making ? state.deals.find((d) => d.id === making && isOpenDeal(d)) : null;
  useEffect(() => { if (making && !makingDeal) { setMaking(null); refocus(null); } }, [making, makingDeal]);
  const add = () => setForm({ kind: { deals: 'deal', accounts: 'account', people: 'person' }[tab] });

  return (
    <div>
      <PageHeader title="Pipeline" action={editable ? ACTIONS[tab] : undefined} onAction={add} />
      {tabs.length > 1 && (
        <div className="mt-6">
          <Segmented label="Pipeline sections" value={tab} onChange={setPicked} options={tabs} />
        </div>
      )}
      {tab === 'deals' && (
        <>
          <Opportunities editable={editable} canConvert={canConvert} onOpen={onOpen} onEdit={(d) => setForm({ kind: 'deal', record: d })}
            onMakeClient={setMaking} />
          {lists.map((b) => (
            <section key={b.id} className="mt-12">
              <Board board={b} embedded />
            </section>
          ))}
        </>
      )}
      {tab === 'accounts' && <AccountsTab onOpen={onOpen} />}
      {tab === 'people' && <PeopleTab onOpen={onOpen} />}
      {tab === 'reports' && <Reports />}

      <DealProfile dealId={open?.kind === 'deal' ? open.id : null} onClose={() => setOpen(null)} onOpen={onOpen}
        onEdit={(d) => setForm({ kind: 'deal', record: d })} />
      {crm && (
        <>
          <AccountProfile accountId={open?.kind === 'account' ? open.id : null} onClose={() => setOpen(null)} onOpen={onOpen}
            onEdit={(a) => setForm({ kind: 'account', record: a })} onNewDeal={(accountId) => setForm({ kind: 'deal', accountId })}
            onNewPerson={(accountId) => setForm({ kind: 'person', accountId })} />
          <PersonProfile personId={open?.kind === 'person' ? open.id : null} onClose={() => setOpen(null)} onOpen={onOpen}
            onEdit={(p) => setForm({ kind: 'person', record: p })} />
        </>
      )}
      {editable && form?.kind === 'deal' && (
        <DealForm key={form.record?.id || `new:${form.accountId || ''}`} deal={form.record || null} presetAccount={form.accountId || ''}
          canConvert={canConvert} onClose={closeForm} onDone={refocus} />
      )}
      {editable && crm && form?.kind === 'account' && (
        <AccountForm key={form.record?.id || 'new'} account={form.record || null} onClose={closeForm} onSaved={(id) => onOpen('account', id)} />
      )}
      {editable && crm && form?.kind === 'person' && (
        <PersonForm key={form.record?.id || `new:${form.accountId || ''}`} person={form.record || null} accountId={form.accountId || ''}
          onClose={closeForm} onSaved={(id) => { if (!form.accountId) onOpen('person', id); }} />
      )}
      {makingDeal && (
        <ConfirmMakeClient name={makingDeal.name} open onClose={() => setMaking(null)}
          onConfirm={() => { actions.convertDeal(makingDeal.id); refocus(null); }} />
      )}
    </div>
  );
}
