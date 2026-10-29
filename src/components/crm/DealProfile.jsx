import { Pencil } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { LEADS, dealStage, leadOf } from '@/data/boards';
import { Avatar, Drawer } from '@/components/ui';
import { useAccess } from '@/lib/access';
import { compactMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import LeadIcon from '@/components/LeadIcon';
import { Links, NextSteps, Timeline } from './Profile';

const PRIORITY_BG = { P1: 'bg-rose-500', P2: 'bg-amber-500', P3: 'bg-sky-500' };

/** A deal's profile (docs/PHASE2.md §19): its stage, Lead (§21), owner, value and priority (Edit for Pipeline editors), its next steps,
 *  timeline and links. Pipeline view reads it; Pipeline edit adds to it. Made a client, it all carries to the client. */
export default function DealProfile({ dealId, onClose, onEdit }) {
  const { state } = useStore();
  const users = useUsers();
  const access = useAccess();
  const deal = state.deals.find((d) => d.id === dealId && !d.clientId); // made a client (or deleted): the profile closes
  const contact = deal?.contactId && access.canView('outreach') ? state.contacts.find((c) => c.id === deal.contactId) : null;
  return (
    <Drawer open={Boolean(deal)} onClose={onClose} title={deal?.name || ''} width={600}>
      {deal && (
        <div className="flex flex-col gap-7">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="rounded-full chip px-3 py-1 text-[13px] font-semibold">{dealStage(deal)}</span>
            {leadOf(deal) && (
              <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                <LeadIcon lead={leadOf(deal)} size={18} decorative />{LEADS[leadOf(deal)].title}
              </span>
            )}
            <span className={cn('rounded-full px-2 text-[12px] font-bold', PRIORITY_BG[deal.priority])}>{deal.priority}</span>
            <span className="font-extrabold tnum text-[17px]">{compactMoney(deal.value)}</span>
            {deal.contact && <span className="flex items-center gap-1.5 text-[13px] dim"><Avatar userId={deal.contact} size={24} ring={false} />{users[deal.contact]?.name}</span>}
            {access.canEdit('pipeline') && (
              <button type="button" onClick={() => onEdit(deal)} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full chip px-3.5 text-[13px] font-semibold">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit deal
              </button>
            )}
          </div>
          {(deal.sector || deal.next || contact) && (
            <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px]">
              {deal.sector && <><dt className="dimmer">Sector</dt><dd>{deal.sector}</dd></>}
              {deal.next && <><dt className="dimmer">Next step</dt><dd>{deal.next}</dd></>}
              {contact && <><dt className="dimmer">From contact</dt><dd className="break-words">{contact.name}{contact.email ? ` · ${contact.email}` : ''}</dd></>}
            </dl>
          )}
          <NextSteps target={{ dealId: deal.id }} />
          <Timeline target={{ dealId: deal.id }} />
          <Links target={{ dealId: deal.id }} />
        </div>
      )}
    </Drawer>
  );
}
