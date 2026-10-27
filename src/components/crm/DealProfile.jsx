import { Pencil } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { LOST, dealProbability, dealStage } from '@/data/boards';
import { Avatar, Drawer } from '@/components/ui';
import { useAccess } from '@/lib/access';
import { CONTACT_ROLES, accountOf, dealPeople } from '@/lib/accounts';
import { compactIn, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Links, NextSteps, Timeline } from './Profile';
import { DaysInStage, Detail, Guardrails, OpenLink, PRIORITY_BG, TheirTime, WaitingPill } from './bits';

/** A deal's profile (docs/PHASE2.md §19, §22): its stage, owner, value and priority (Edit for Pipeline editors), its
 *  account (with its guardrails) and the people on it, close date, probability, who it waits on and for how long, then its
 *  next steps, timeline and links. Pipeline view reads it; Pipeline edit adds to it. Made a client, it all carries to the
 *  client. */
export default function DealProfile({ dealId, onClose, onEdit, onOpen }) {
  const { state } = useStore();
  const users = useUsers();
  const access = useAccess();
  const deal = state.deals.find((d) => d.id === dealId && !d.clientId); // made a client (or deleted): the profile closes
  const account = deal && accountOf(state, deal);
  const people = deal ? dealPeople(state, deal) : [];
  const contact = deal?.contactId && access.canView('outreach') ? state.contacts.find((c) => c.id === deal.contactId) : null;
  const stage = deal && dealStage(deal);
  return (
    <Drawer open={Boolean(deal)} onClose={onClose} title={deal?.name || ''} width={600}>
      {deal && (
        <div className="flex flex-col gap-7">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="rounded-full chip px-3 py-1 text-[13px] font-semibold">{stage}</span>
            <span className={cn('rounded-full px-2 text-[12px] font-bold', PRIORITY_BG[deal.priority])}>{deal.priority}</span>
            <span className="font-extrabold tnum text-[17px]">{compactIn(deal.value, deal.currency)}</span>
            {deal.contact && <span className="flex items-center gap-1.5 text-[13px] dim"><Avatar userId={deal.contact} size={24} ring={false} />{users[deal.contact]?.name}</span>}
            {access.canEdit('pipeline') && (
              <button type="button" onClick={() => onEdit(deal)} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full chip px-3.5 text-[13px] font-semibold">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit deal
              </button>
            )}
          </div>
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px]">
            <Detail label="Account">{account && <OpenLink onClick={() => onOpen('account', account.id)}>{account.name}</OpenLink>}</Detail>
            <Detail label="Probability">{stage === LOST ? null : `${dealProbability(deal)}%`}</Detail>
            <Detail label="Expected close">{deal.closeOn && shortDate(deal.closeOn)}</Detail>
            <Detail label="In this stage"><span className="flex flex-wrap items-center gap-1.5"><DaysInStage deal={deal} /><WaitingPill value={deal.waitingOn} /></span></Detail>
            <Detail label="Lost reason">{stage === LOST && deal.lostReason}</Detail>
            <Detail label="Sector">{deal.sector}</Detail>
            <Detail label="Next step">{deal.next}</Detail>
            <Detail label="From contact">{contact && `${contact.name}${contact.email ? ` · ${contact.email}` : ''}`}</Detail>
          </dl>
          <Guardrails text={account?.guardrails} />
          {people.length > 0 && (
            <section>
              <h3 className="font-bold">Contacts</h3>
              <ul className="mt-2 flex flex-col gap-1">
                {people.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-xl px-2 py-1.5 hover:bg-white/5">
                    <OpenLink onClick={() => onOpen('person', p.id)}>{p.name || p.email}</OpenLink>
                    <span className="text-[12.5px] dim">{[p.title, CONTACT_ROLES[p.role]].filter(Boolean).join(' · ')}</span>
                    <TheirTime timezone={p.timezone || account?.timezone} className="ml-auto" />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <NextSteps target={{ dealId: deal.id }} />
          <Timeline target={{ dealId: deal.id }} />
          <Links target={{ dealId: deal.id }} />
        </div>
      )}
    </Drawer>
  );
}
