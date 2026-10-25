import { AtSign, Hash, SquareCheckBig } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { Avatar } from '@/components/ui';
import { openChat } from '@/components/chat/ChatDock';
import { useAccess } from '@/lib/access';
import { boardHref } from '@/lib/boards';
import { MessageText, mentionsUser } from '@/lib/mentions';
import { taskMentions } from '@/lib/work';
import { ago, invoiceTotals } from '@/lib/format';

// Chat messages that @mention `person` (or @here) in channels they're in, and task updates that @name them on the boards
// they see (src/lib/work.js), newest first.
export function mentionsOf(state, person) {
  if (!person?.name) return [];
  const chat = state.messages
    .filter((m) => m.user !== person.id && mentionsUser(m.text, person) && state.channels.find((c) => c.id === m.channel)?.members.includes(person.id));
  return [...chat, ...taskMentions(state, person)].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/** The latest five mentions (the KPI counts them all), and overdue invoices for those who can see Clients. */
export default function Mentions({ mentions, person }) {
  const { state } = useStore();
  const users = useUsers();
  const access = useAccess();
  const latest = mentions.slice(0, 5);
  const overdue = access.canView('clients') ? state.clients.flatMap((c) => c.invoices).filter((i) => i.status === 'Overdue') : [];

  return (
    <section className="glass glass-rim self-start rounded-[24px] p-5" aria-label="Mentions">
      <h2 className="flex items-center gap-2 font-extrabold text-[16px]"><AtSign className="h-4 w-4" aria-hidden="true" />Mentions</h2>
      {latest.length === 0 && <p className="mt-3 dimmer">No one has tagged {person?.id === state.me ? 'you' : person?.name} yet.</p>}
      <ol className="mt-3 flex flex-col gap-2">
        {latest.map((m) => {
          const body = (where) => (
            <>
              <Avatar userId={m.user} size={30} ring={false} />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] dimmer">
                  <span className="shrink-0 font-semibold text-white">{users[m.user]?.name}</span>{where}<span className="shrink-0">· {ago(m.ts)}</span>
                </div>
                <p className="line-clamp-2"><MessageText text={m.text} users={state.users} me={person} /></p>
              </div>
            </>
          );
          if (m.kind === 'task') {
            return (
              <li key={m.id}>
                <a href={boardHref(m.board, m.item.id)} className="flex w-full gap-3 rounded-2xl p-2 text-left hover:bg-white/10">
                  {body(<><SquareCheckBig className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{m.item.name.trim() || 'Untitled task'}</span></>)}
                </a>
              </li>
            );
          }
          const ch = state.channels.find((c) => c.id === m.channel);
          return (
            <li key={m.id}>
              <button type="button" onClick={() => openChat(m.channel)} className="flex w-full gap-3 rounded-2xl p-2 text-left hover:bg-white/10">
                {body(<><Hash className="h-3 w-3 shrink-0" /><span className="truncate">{ch?.name}</span></>)}
              </button>
            </li>
          );
        })}
      </ol>
      {overdue.length > 0 && (
        <p className="mt-4 rounded-2xl bg-rose-500/20 p-3 text-[13px]">
          {overdue.length} overdue invoice{overdue.length > 1 ? 's' : ''} totalling {overdue.reduce((t, i) => t + invoiceTotals(i).total, 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 })}. <a href="#/clients" className="font-semibold underline">Open Clients</a>
        </p>
      )}
    </section>
  );
}
