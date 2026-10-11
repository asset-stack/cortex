// Slack-style team chat docked at the bottom of the workspace: groups, messages, @mentions.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AtSign, ChevronDown, ChevronUp, Hash, MessageSquare, Plus, SendHorizontal, UserPlus } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { Avatar, Modal } from '@/components/ui';
import { MessageText, mentionsUser } from '@/lib/mentions';
import { chatTime } from '@/lib/format';
import { cn } from '@/lib/cn';

export const openChat = (channelId) => window.dispatchEvent(new CustomEvent('ops:open-chat', { detail: { channelId } }));

export function useChatCounts() {
  const { state } = useStore();
  const me = state.users.find((u) => u.id === state.me);
  return useMemo(() => {
    const per = {};
    let unread = 0, mentions = 0;
    state.channels.filter((c) => c.members.includes(state.me)).forEach((c) => {
      const since = state.lastRead[state.me]?.[c.id] || '';
      const fresh = state.messages.filter((m) => m.channel === c.id && m.user !== state.me && m.ts > since);
      const ment = fresh.filter((m) => mentionsUser(m.text, me)).length;
      per[c.id] = { unread: fresh.length, mentions: ment };
      unread += fresh.length; mentions += ment;
    });
    return { per, unread, mentions };
  }, [state.channels, state.messages, state.lastRead, state.me, me]);
}

function GroupModal({ open, onClose, onCreate }) {
  const { state } = useStore();
  const [name, setName] = useState('');
  const [members, setMembers] = useState([]);
  const toggle = (id) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  return (
    <Modal open={open} onClose={onClose} title="New group">
      <form className="flex flex-col gap-4" onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreate(name, members);
        setName(''); setMembers([]);
      }}>
        <label className="flex items-center gap-2 field">
          <Hash className="h-4 w-4 dimmer" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="group-name" aria-label="Group name" className="w-full bg-transparent outline-none" autoFocus />
        </label>
        <fieldset>
          <legend className="text-[12px] dimmer mb-2">Members</legend>
          <div className="grid grid-cols-2 gap-1.5">
            {state.users.filter((u) => u.id !== state.me).map((u) => (
              <label key={u.id} className={cn('relative flex items-center gap-2 rounded-xl px-2.5 py-2 cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white', members.includes(u.id) ? 'bg-white/20' : 'hover:bg-white/10')}>
                <input type="checkbox" className="sr-only" checked={members.includes(u.id)} onChange={() => toggle(u.id)} />
                <Avatar userId={u.id} size={24} ring={false} />{u.name}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={!name.trim()} className="btn-primary rounded-full h-11 font-semibold">Create group</button>
      </form>
    </Modal>
  );
}

function AddMembersModal({ channel, onClose }) {
  const { state, actions } = useStore();
  const [picked, setPicked] = useState([]);
  if (!channel) return null;
  const others = state.users.filter((u) => !channel.members.includes(u.id));
  return (
    <Modal open onClose={onClose} title={`Add to #${channel.name}`}>
      {others.length === 0 ? <p className="dimmer">Everyone is already in this group.</p> : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-1.5">
            {others.map((u) => (
              <label key={u.id} className={cn('relative flex items-center gap-2 rounded-xl px-2.5 py-2 cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white', picked.includes(u.id) ? 'bg-white/20' : 'hover:bg-white/10')}>
                <input type="checkbox" className="sr-only" checked={picked.includes(u.id)} onChange={() => setPicked((p) => (p.includes(u.id) ? p.filter((x) => x !== u.id) : [...p, u.id]))} />
                <Avatar userId={u.id} size={24} ring={false} />{u.name}
              </label>
            ))}
          </div>
          <button type="button" disabled={!picked.length} onClick={() => { actions.addChannelMembers(channel.id, picked); onClose(); }} className="btn-primary rounded-full h-11 font-semibold">Add members</button>
        </div>
      )}
    </Modal>
  );
}

function Composer({ channel, onSend }) {
  const { state } = useStore();
  const [text, setText] = useState('');
  const [query, setQuery] = useState(null); // { start, q }
  const [hi, setHi] = useState(0);
  const ref = useRef(null);
  const caret = useRef(null); // caret position to restore right after the controlled value updates
  const listId = useId();

  useLayoutEffect(() => {
    if (caret.current == null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [text]);

  // Grow with the text so Shift+Enter lines stay visible (max-h-32 caps it, then it scrolls).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const candidates = useMemo(() => {
    if (!query) return [];
    const pool = [...state.users.filter((u) => u.id !== state.me), { id: 'here', name: 'here', initials: '@' }];
    return pool.filter((u) => u.name.toLowerCase().startsWith(query.q.toLowerCase())).slice(0, 6);
  }, [query, state.users, state.me]);

  const detect = (value, caret) => {
    const m = /(^|\s)@(\w*)$/.exec(value.slice(0, caret));
    setQuery(m ? { start: caret - m[2].length - 1, q: m[2] } : null);
    setHi(0);
  };

  const pick = (u) => {
    const end = ref.current.selectionStart;
    // A stale query (caret moved off the @word) only closes the list; never splice the wrong range.
    if (!query || end <= query.start || !/^@\w*$/.test(text.slice(query.start, end))) { setQuery(null); return; }
    caret.current = query.start + u.name.length + 2;
    setText(`${text.slice(0, query.start)}@${u.name} ${text.slice(end)}`);
    setQuery(null);
  };

  const submit = () => {
    if (!text.trim()) return;
    onSend(text.trim()); setText(''); setQuery(null);
  };

  const listOpen = !!(query && candidates.length);

  return (
    <div className="relative">
      {listOpen && (
        <ul id={listId} role="listbox" aria-label="Mention someone" className="glass-dark absolute bottom-full left-0 mb-2 w-60 rounded-2xl p-1.5">
          {candidates.map((u, i) => (
            <li key={u.id} id={`${listId}-${i}`} role="option" aria-selected={i === hi}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(u)}
              className={cn('flex w-full cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left', i === hi ? 'bg-white/20' : 'hover:bg-white/10')}>
              {u.id === 'here' ? <span className="grid h-6 w-6 place-items-center rounded-full bg-white/20"><AtSign className="h-3.5 w-3.5" /></span> : <Avatar userId={u.id} size={24} ring={false} />}
              <span className="font-semibold">{u.name}</span>{u.id === 'here' && <span className="dimmer text-[12px]">everyone in group</span>}
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only" aria-live="polite">{listOpen ? `${candidates.length} people to mention. Up and down to choose, Enter to insert, Escape to dismiss.` : ''}</span>
      <div className="flex items-end gap-2 rounded-[20px] chip p-1.5 pl-4">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={`Message #${channel.name}`}
          aria-label={`Message ${channel.name}`}
          aria-autocomplete="list"
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen ? `${listId}-${hi}` : undefined}
          onChange={(e) => { setText(e.target.value); detect(e.target.value, e.target.selectionStart); }}
          onSelect={(e) => detect(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            if (listOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => (h + 1) % candidates.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h - 1 + candidates.length) % candidates.length); return; }
              if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); pick(candidates[hi]); return; }
              if (e.key === 'Escape') { setQuery(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent py-2 outline-none"
        />
        <button type="button" onClick={() => { setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@`); ref.current.focus(); setQuery({ start: text.length + (text && !text.endsWith(' ') ? 1 : 0), q: '' }); }}
          aria-label="Mention someone" className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10"><AtSign className="h-4 w-4" /></button>
        <button type="button" onClick={submit} disabled={!text.trim()} aria-label="Send message" className="btn-primary grid h-9 w-9 place-items-center rounded-full"><SendHorizontal className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export default function ChatDock() {
  const { state, actions } = useStore();
  const users = useUsers();
  const me = users[state.me];
  const counts = useChatCounts();
  const myChannels = state.channels.filter((c) => c.members.includes(state.me));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(myChannels[0]?.id);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [onlyMentions, setOnlyMentions] = useState(false);
  const listRef = useRef(null);
  const barRef = useRef(null);
  const sectionRef = useRef(null);
  const prevOpen = useRef(open);
  // Every channel switch starts with the full conversation, not the "Me" filter.
  const switchTo = (id) => { setActive(id); setOnlyMentions(false); };

  const channel = myChannels.find((c) => c.id === active) || myChannels[0];
  const messages = state.messages.filter((m) => m.channel === channel?.id && (!onlyMentions || mentionsUser(m.text, me)));
  const latest = [...state.messages].filter((m) => myChannels.some((c) => c.id === m.channel)).sort((a, b) => b.ts.localeCompare(a.ts))[0];

  useEffect(() => {
    const on = (e) => { setOpen(true); if (e.detail?.channelId) { setActive(e.detail.channelId); setOnlyMentions(false); } };
    window.addEventListener('ops:open-chat', on);
    return () => window.removeEventListener('ops:open-chat', on);
  }, []);

  // Mark the visible channel read whenever new messages land while it is open.
  const activeId = channel?.id;
  const activeUnread = activeId ? counts.per[activeId]?.unread || 0 : 0;
  useEffect(() => {
    if (open && activeId && activeUnread) actions.markRead(activeId);
  }, [open, activeId, activeUnread, actions]);

  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, channel?.id, onlyMentions, messages.length]);

  // Keep keyboard focus with the chat: into the panel on open (the composer where there is a mouse,
  // so phones don't pop the keyboard), back to the bar on minimise. Not on first render.
  useEffect(() => {
    if (prevOpen.current === open) return;
    prevOpen.current = open;
    if (open) {
      const el = sectionRef.current;
      ((window.matchMedia?.('(pointer: fine)').matches && el?.querySelector('textarea')) || el)?.focus();
    } else barRef.current?.focus();
  }, [open]);

  if (!open) {
    const chatLabel = ['Open team chat', counts.unread > 0 && `${counts.unread} unread`,
      counts.mentions > 0 && `${counts.mentions} mention${counts.mentions === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    return (
      <button ref={barRef} type="button" onClick={() => setOpen(true)} aria-label={chatLabel}
        className="glass-solid flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-left">
        <MessageSquare className="h-5 w-5 shrink-0" />
        <span className="font-bold shrink-0">Team chat</span>
        {counts.unread > 0 && <span className="rounded-full bg-[#2337EE] px-2 text-[12px] font-bold tnum shrink-0">{counts.unread}</span>}
        {counts.mentions > 0 && <span className="inline-flex items-center gap-0.5 rounded-full bg-[#ff9a3c] px-2 text-[12px] font-bold text-[#1a1206] shrink-0"><AtSign className="h-3 w-3" />{counts.mentions}</span>}
        {latest && (
          <span className="hidden sm:flex min-w-0 flex-1 items-center gap-2 dim">
            <Avatar userId={latest.user} size={22} ring={false} />
            <span className="truncate"><span className="font-semibold text-white">{users[latest.user]?.name}</span> {latest.text}</span>
          </span>
        )}
        <ChevronUp className="ml-auto h-5 w-5 shrink-0" />
      </button>
    );
  }

  return (
    <section ref={sectionRef} tabIndex={-1} aria-label="Team chat" className="glass-solid flex h-[min(560px,72vh)] overflow-hidden rounded-[28px]">
      {/* Group list */}
      <div className="hidden w-[220px] shrink-0 flex-col border-r rowline sm:flex">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <span className="font-extrabold">Groups</span>
          <button type="button" onClick={() => setCreating(true)} aria-label="New group" title="New group" className="grid h-8 w-8 place-items-center rounded-full chip"><Plus className="h-4 w-4" /></button>
        </div>
        <nav className="flex-1 overflow-y-auto scroll-thin px-2 pb-3">
          {myChannels.map((c) => {
            const k = counts.per[c.id] || {};
            return (
              <button key={c.id} type="button" onClick={() => switchTo(c.id)}
                className={cn('flex w-full items-center gap-2 rounded-full px-3 py-2 text-left', c.id === channel?.id ? 'chip-on' : k.unread ? 'font-bold hover:bg-white/10' : 'dim hover:bg-white/10')}>
                <Hash className="h-4 w-4 shrink-0 opacity-70" /><span className="flex-1 truncate">{c.name}</span>
                {k.mentions > 0 && <span className="rounded-full bg-[#ff9a3c] px-1.5 text-[11px] font-bold text-[#1a1206]">@{k.mentions}</span>}
                {k.unread > 0 && !k.mentions && <span className="rounded-full bg-[#2337EE] px-1.5 text-[11px] font-bold text-white tnum">{k.unread}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Conversation */}
      {channel ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-w-0 items-center gap-2 border-b rowline px-4 py-3">
            <select aria-label="Group" value={channel.id} onChange={(e) => switchTo(e.target.value)} className="field !w-auto !py-1 min-w-0 flex-1 sm:hidden">
              {myChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
            <h2 className="hidden min-w-0 items-center gap-1 text-[16px] font-extrabold sm:flex"><Hash className="h-4 w-4 shrink-0 opacity-70" /><span className="truncate">{channel.name}</span></h2>
            <div className="ml-2 hidden shrink-0 -space-x-2 xl:flex">{channel.members.slice(0, 5).map((u) => <Avatar key={u} userId={u} size={24} />)}</div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={() => setOnlyMentions((v) => !v)} aria-pressed={onlyMentions} title="Show only messages that mention you"
                className={cn('inline-flex h-8 items-center gap-1 rounded-full px-3 text-[12.5px] font-semibold', onlyMentions ? 'chip-on' : 'chip')}><AtSign className="h-3.5 w-3.5" />Me</button>
              <button type="button" onClick={() => setAdding(true)} aria-label="Add members" title="Add members" className="grid h-8 w-8 place-items-center rounded-full chip"><UserPlus className="h-4 w-4" /></button>
              <button type="button" onClick={() => setCreating(true)} aria-label="New group" className="grid h-8 w-8 place-items-center rounded-full chip sm:hidden"><Plus className="h-4 w-4" /></button>
              <button type="button" onClick={() => setOpen(false)} aria-label="Minimise team chat" className="grid h-8 w-8 place-items-center rounded-full chip"><ChevronDown className="h-4 w-4" /></button>
            </div>
          </header>
          {/* Keyed per view so a channel switch mounts a fresh live region instead of reading the whole channel out. */}
          <ol key={`${channel.id}:${onlyMentions ? 'me' : 'all'}`} ref={listRef} className="flex-1 overflow-y-auto scroll-thin px-4 py-3 flex flex-col gap-3" aria-live="polite">
            {messages.length === 0 && <li className="m-auto dimmer">{onlyMentions ? 'No mentions of you here.' : 'No messages yet. Say hello.'}</li>}
            {messages.map((m) => {
              const mine = mentionsUser(m.text, me) && m.user !== state.me;
              return (
                <li key={m.id} className={cn('flex gap-3 rounded-2xl px-2 py-1.5', mine && 'bg-[#ff9a3c]/10')}>
                  <Avatar userId={m.user} size={32} ring={false} />
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2"><span className="font-bold">{users[m.user]?.name}</span><time dateTime={m.ts} className="text-[11.5px] dimmer tnum">{chatTime(m.ts)}</time></div>
                    <p className="whitespace-pre-wrap break-words leading-relaxed"><MessageText text={m.text} users={state.users} me={me} /></p>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="px-4 pb-4"><Composer key={`${state.me}:${channel.id}`} channel={channel} onSend={(t) => actions.sendMessage(channel.id, t)} /></div>
        </div>
      ) : (
        <div className="m-auto flex flex-col items-center gap-3 dim">
          No groups yet.
          <button type="button" onClick={() => setCreating(true)} className="btn-primary rounded-full px-4 h-10 font-semibold">Create a group</button>
        </div>
      )}

      {creating && <GroupModal open onClose={() => setCreating(false)} onCreate={(name, members) => { switchTo(actions.createChannel(name, members)); setCreating(false); }} />}
      {adding && <AddMembersModal channel={channel} onClose={() => setAdding(false)} />}
    </section>
  );
}
