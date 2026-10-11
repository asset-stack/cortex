import { useState } from 'react';
import { CornerUpLeft, Eye, Inbox, ListChecks, Loader2, PlugZap, Repeat, Send, Sparkles, Users, WandSparkles } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { KpiRow, Modal, PageHeader, Segmented } from '@/components/ui';
import { draftOutreach, GOALS } from '@/integrations/claudeAgent';
import { GMAIL_CONNECTED, sendEmail } from '@/integrations/gmail';
import { ago } from '@/lib/format';
import { cn } from '@/lib/cn';

const STATUS_STYLE = { Replied: 'bg-emerald-400/35', Opened: 'bg-violet-400/35', Sent: 'bg-sky-400/35', New: 'bg-white/20', 'No reply': 'bg-white/15 dim' };
const FEED_ICON = { reply: [CornerUpLeft, 'bg-emerald-400/35'], open: [Eye, 'bg-violet-400/35'], sent: [Send, 'bg-sky-400/35'] };

function Agent() {
  const { state, actions } = useStore();
  const users = useUsers();
  const [to, setTo] = useState(state.contacts[0]?.id || '');
  const [goal, setGoal] = useState(GOALS[0]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const contact = state.contacts.find((c) => c.id === to);

  const draft = async () => {
    if (!contact) return;
    setBusy(true); setNote('');
    const d = await draftOutreach({ contact, goal, sender: users[state.me]?.name || 'AssetStack' });
    setSubject(d.subject); setBody(d.body); setBusy(false);
  };
  const send = async () => {
    if (!contact || !body.trim()) return;
    await sendEmail({ to: contact.email, subject, body });
    actions.logEmail({ kind: 'sent', contact: contact.name, subject: subject || goal, snippet: body.split('\n').filter(Boolean)[1] || '' });
    setNote('Added to the feed. Demo mode: no email was sent.');
    setBody(''); setSubject('');
  };
  const queue = () => {
    if (!contact || !body.trim()) return;
    actions.queueApproval({ contact: contact.name, subject: subject || goal, body });
    setNote('Queued for approval.');
    setBody(''); setSubject('');
  };

  return (
    <div className="glass-dark rounded-[26px] p-5">
      <div className="flex items-center gap-2 font-extrabold text-[16px]"><Sparkles className="h-5 w-5" />Claude agent</div>
      <div className="mt-4 grid gap-2">
        <select aria-label="Recipient" className="field !rounded-full" value={to} onChange={(e) => setTo(e.target.value)}>
          {state.contacts.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.org}</option>)}
        </select>
        <select aria-label="Goal" className="field !rounded-full" value={goal} onChange={(e) => setGoal(e.target.value)}>
          {GOALS.map((g) => <option key={g}>{g}</option>)}
        </select>
      </div>
      <button type="button" onClick={draft} disabled={busy} className="mt-3 w-full rounded-full chip-on h-11 font-bold inline-flex items-center justify-center gap-2">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}{busy ? 'Drafting' : 'Draft'}
      </button>
      <input aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="field mt-3" />
      <textarea aria-label="Email body" rows={9} value={body} onChange={(e) => setBody(e.target.value)} className="field mt-2 resize-none !rounded-[18px] text-[13.5px]" />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={send} disabled={!body.trim()} className="btn-primary rounded-full h-10 font-semibold inline-flex items-center justify-center gap-1.5"><Send className="h-4 w-4" />Send</button>
        <button type="button" onClick={queue} disabled={!body.trim()} className="rounded-full chip h-10 font-semibold disabled:opacity-50">Queue</button>
      </div>
      {note && <p role="status" className="mt-2 text-[12.5px] text-emerald-200">{note}</p>}
    </div>
  );
}

export default function Outreach() {
  const { state, actions } = useStore();
  const [tab, setTab] = useState('contacts');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', org: '', email: '' });
  const sent = state.emails.filter((e) => e.kind === 'sent').length;
  const contacted = state.contacts.filter((c) => c.status !== 'New');
  const openRate = contacted.length ? Math.round((contacted.filter((c) => ['Opened', 'Replied'].includes(c.status)).length / contacted.length) * 100) : 0;
  const replies = state.contacts.filter((c) => c.status === 'Replied').length;

  return (
    <div>
      <PageHeader title="Outreach" action="Add contact" onAction={() => setAdding(true)} />
      <KpiRow items={[
        { value: sent, label: 'Emails sent', tint: '#334155' },
        { value: `${openRate}%`, label: 'Opened', tint: '#7c3aed' },
        { value: replies, label: 'Replies', tint: '#0f9f6f' },
        { value: state.approvals.length, label: 'To approve', tint: '#f59e0b' },
      ]} />
      <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 rounded-[26px] glass glass-rim self-start">
          <div className="flex flex-wrap items-center justify-between gap-2 p-3">
            <Segmented label="Outreach views" value={tab} onChange={setTab} options={[
              { id: 'contacts', label: 'Contacts', icon: Users }, { id: 'feed', label: 'Feed', icon: Inbox },
              { id: 'sequences', label: 'Sequences', icon: Repeat }, { id: 'approvals', label: 'Approvals', icon: ListChecks },
            ]} />
            <button type="button" disabled={!GMAIL_CONNECTED} title="Gmail connection needs the backend service"
              className="inline-flex items-center gap-1.5 rounded-full chip px-3 py-1.5 text-[12.5px] font-semibold">
              <PlugZap className="h-3.5 w-3.5" />{GMAIL_CONNECTED ? 'Gmail connected' : 'Connect Gmail'}
            </button>
          </div>

          {tab === 'contacts' && (
            <div className="overflow-x-auto scroll-thin"><table className="w-full min-w-[540px] text-[13.5px]"><tbody>
              {state.contacts.map((c) => (
                <tr key={c.id} className="border-t rowline hover:bg-white/5">
                  <td className="p-3.5 font-semibold">{c.name}</td><td className="p-3.5 dim">{c.org}</td>
                  <td className="p-3.5"><span className="rounded-full chip px-2.5 py-1 text-[12px]">{c.stage}</span></td>
                  <td className="p-3.5 dimmer tnum">{ago(c.last)}</td>
                  <td className="p-3.5 text-right"><span className={cn('rounded-full px-2.5 py-1 text-[12px] font-bold', STATUS_STYLE[c.status])}>{c.status}</span></td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          {tab === 'feed' && (
            <ol className="flex flex-col gap-4 border-t rowline p-5">
              {state.emails.map((e) => {
                const [Icon, bg] = FEED_ICON[e.kind];
                return (
                  <li key={e.id} className="flex items-center gap-3">
                    <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full', bg)}><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1"><div className="font-semibold truncate">{e.subject}</div><div className="text-[12.5px] dimmer truncate">{e.contact} · {e.snippet}</div></div>
                    <span className="text-[12px] dimmer tnum">{ago(e.ts)}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {tab === 'sequences' && (
            <ul className="border-t rowline">
              {state.sequences.map((s) => (
                <li key={s.id} className="flex items-center gap-4 border-b rowline p-4 last:border-b-0">
                  <div className="min-w-0 flex-1 font-semibold">{s.name}</div>
                  <span className="dimmer tnum text-[13px]">{s.steps} steps</span>
                  <span className="dimmer tnum text-[13px]">{s.enrolled} enrolled</span>
                  <span className="w-24"><span className="block h-1.5 rounded-full bg-white/15"><span className="block h-full rounded-full bg-emerald-300" style={{ width: `${s.replyRate * 100}%` }} /></span></span>
                  <span className="tnum text-[13px] font-bold w-10 text-right">{Math.round(s.replyRate * 100)}%</span>
                </li>
              ))}
            </ul>
          )}
          {tab === 'approvals' && (
            <div className="border-t rowline p-5">
              {state.approvals.length === 0 ? <p className="dimmer">Nothing waiting. Drafts you queue from the Claude agent appear here.</p> : (
                <ul className="flex flex-col gap-3">
                  {state.approvals.map((a) => (
                    <li key={a.id} className="rounded-2xl chip p-3"><div className="font-semibold">{a.subject}</div><div className="text-[12.5px] dimmer">To {a.contact} · {ago(a.ts)}</div>
                      <p className="mt-2 whitespace-pre-wrap text-[13px] dim line-clamp-4">{a.body}</p></li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <aside className="min-w-0"><Agent /></aside>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add contact">
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (!f.name.trim()) return; actions.addContact({ ...f, name: f.name.trim() }); setF({ name: '', org: '', email: '' }); setAdding(false); }}>
          <input className="field" placeholder="Name" aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          <input className="field" placeholder="Organisation" aria-label="Organisation" value={f.org} onChange={(e) => setF({ ...f, org: e.target.value })} />
          <input className="field" placeholder="Email" aria-label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <button type="submit" className="btn-primary rounded-full h-11 font-semibold">Add contact</button>
        </form>
      </Modal>
    </div>
  );
}
