import { useMemo } from 'react';
import { AtSign, Hash } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { BOARD_SCHEMAS, STATUS } from '@/data/boards';
import { Avatar, KpiRow, PageHeader } from '@/components/ui';
import { NAV } from '@/components/layout/Sidebar';
import { openChat } from '@/components/chat/ChatDock';
import { MessageText, mentionsUser } from '@/lib/mentions';
import { ago, invoiceTotals, shortDate } from '@/lib/format';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function MyWork() {
  const { state } = useStore();
  const users = useUsers();
  const me = users[state.me];

  const mine = useMemo(() => Object.entries(state.boards).flatMap(([key, b]) =>
    b.groups.flatMap((g) => g.items.filter((i) => i.values.owner === state.me && !i.done).map((i) => ({ ...i, board: key }))))
    .sort((a, b) => (a.values.due || '9999').localeCompare(b.values.due || '9999')), [state.boards, state.me]);

  const mentions = useMemo(() => state.messages
    .filter((m) => m.user !== state.me && mentionsUser(m.text, me) && state.channels.find((c) => c.id === m.channel)?.members.includes(state.me))
    .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 5), [state.messages, state.channels, state.me, me]);

  const overdue = state.clients.flatMap((c) => c.invoices).filter((i) => i.status === 'Overdue');

  return (
    <div>
      <PageHeader title={`${greeting()}, ${me?.name}`} />
      <KpiRow items={[
        { value: mine.length, label: 'My open tasks', tint: '#334155' },
        { value: mine.filter((i) => i.values.status === 'Stuck').length, label: 'Stuck', tint: '#e2445c' },
        { value: mentions.length, label: 'Mentions', tint: '#0f9f6f' },
        { value: overdue.length, label: overdue.length === 1 ? 'Overdue invoice' : 'Overdue invoices', tint: '#f59e0b' },
      ]} />

      <div className="mt-7 grid grid-cols-2 gap-4 md:grid-cols-3">
        {NAV.slice(1).map(({ id, label, icon: Icon }) => (
          <a key={id} href={`#/${id}`} className="glass glass-rim float flex items-center gap-3 rounded-[24px] p-5">
            <span className="grid h-10 w-10 place-items-center rounded-2xl chip"><Icon className="h-5 w-5" /></span>
            <span className="font-extrabold text-[15px]">{label}</span>
          </a>
        ))}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 overflow-x-auto scroll-thin rounded-[24px] glass">
          <table className="w-full min-w-[520px] text-[13.5px]">
            <tbody>
              {mine.length === 0 && <tr><td className="p-5 dimmer">Nothing assigned to you. Nice.</td></tr>}
              {mine.map((i, k) => (
                <tr key={i.id} className={k ? 'border-t rowline' : ''}>
                  <td className="p-3.5 font-semibold"><a href={`#/${i.board}`} className="hover:underline">{i.name}</a></td>
                  <td className="p-3.5 dimmer">{BOARD_SCHEMAS[i.board].title}</td>
                  <td className="w-[130px] px-2"><span className="pill" style={{ backgroundColor: STATUS[i.values.status] }}>{i.values.status}</span></td>
                  <td className="p-3.5 text-right dim tnum">{shortDate(i.values.due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <section className="glass glass-rim rounded-[24px] p-5" aria-label="Mentions">
          <h2 className="flex items-center gap-2 font-extrabold text-[16px]"><AtSign className="h-4 w-4" />Mentions</h2>
          {mentions.length === 0 && <p className="mt-3 dimmer">No one has tagged you yet.</p>}
          <ol className="mt-3 flex flex-col gap-2">
            {mentions.map((m) => {
              const ch = state.channels.find((c) => c.id === m.channel);
              return (
                <li key={m.id}>
                  <button type="button" onClick={() => openChat(m.channel)} className="flex w-full gap-3 rounded-2xl p-2 text-left hover:bg-white/10">
                    <Avatar userId={m.user} size={30} ring={false} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[12.5px] dimmer"><span className="font-semibold text-white">{users[m.user]?.name}</span><Hash className="h-3 w-3" />{ch?.name} · {ago(m.ts)}</div>
                      <p className="line-clamp-2"><MessageText text={m.text} users={state.users} me={me} /></p>
                    </div>
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
      </div>
    </div>
  );
}
