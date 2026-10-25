import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, ListFilter, User } from 'lucide-react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { BOARD_SCHEMAS } from '@/data/boards';
import { findBoard } from '@/lib/boards';
import {
  CLIENT_KINDS, KINDS, archiveMonths, collectEntries, earliestDate, entriesByDay, filterEntries, inMonth, lastOf, nextMonths, placeAt,
} from '@/lib/calendar';
import { localYmd } from '@/lib/format';
import { hashParam } from '@/lib/router';
import { Avatar, IconButton, Modal, PageHeader, Popover } from '@/components/ui';
import MonthBlock, { EntryChip, dayName } from '@/components/calendar/MonthBlock';
import EventModal from '@/components/calendar/EventModal';
import GoogleCalendar from '@/components/calendar/GoogleCalendar';
import ItemDrawer from '@/components/board/ItemDrawer';
import { cn } from '@/lib/cn';

const STALE = 10 * 60e3; // opening the Calendar syncs Google when the last sync is older than this
// Back from Google (#/calendar?google=connected, or google=error&reason=…).
const GOOGLE_ERRORS = {
  denied: 'Google sign-in was cancelled',
  wrong_account: 'Connect the Google account for your own Cortex email',
  calendar_scope: 'Allow Cortex to see your Google Calendar to connect it',
  no_refresh_token: 'Google didn’t finish connecting. Try again.',
  client: 'Google didn’t accept Cortex’s Google key. An admin needs to check the Google setup.',
  exchange: 'Google didn’t finish connecting. Try again.',
  save: 'Couldn’t save your Google connection. Try again.',
  share: 'Couldn’t turn on sharing. Try again.',
};

/** A Google meeting: whose, when, and its title (Busy for a Private one). */
function MeetingModal({ entry, onClose }) {
  const { state } = useStore();
  const m = entry.meeting;
  const who = state.users.find((u) => u.id === m.user_id);
  const end = m.all_day ? m.end_date : placeAt(m.end_at).date;
  const when = m.all_day
    ? (m.end_date > m.start_date ? `${dayName(m.start_date)} – ${dayName(m.end_date)}` : `${dayName(m.start_date)}, all day`)
    : `${dayName(entry.date)}, ${entry.time} – ${end !== entry.date ? `${dayName(end)} ` : ''}${entry.endTime}`;
  return (
    <Modal open onClose={onClose} title={entry.title}>
      <div className="flex items-center gap-2.5">
        {who && <Avatar userId={who.id} size={26} ring={false} />}<span className="font-semibold">{who?.name || 'Someone'}</span>
      </div>
      <p className="mt-3 dim">{when}</p>
      <p className="mt-1 text-[12.5px] dimmer">Google Calendar</p>
    </Modal>
  );
}

/**
 * The team Calendar (docs/PHASE2.md §15): everything dated in Cortex that you may see (board tasks and posts, the team's
 * events, invoice and contract dates with Clients access) and the team's Google Calendar meetings. Twelve months from
 * this one, each opening and closing, a row per week from Monday; finished months move to the Archive at the bottom.
 */
export default function Calendar() {
  const { state, actions, calendar, google } = useStore();
  const access = useAccess();
  const today = localYmd();
  const months = useMemo(() => nextMonths(today, 12), [today]);
  const [openMonths, setOpenMonths] = useState(() => new Set(months.slice(0, 1))); // this month; the rest open on a click
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [openArchived, setOpenArchived] = useState(() => new Set());
  const [person, setPerson] = useState('');
  const [kinds, setKinds] = useState(() => new Set());
  const [popover, setPopover] = useState(null); // 'person' | 'kinds'
  const [personAnchor, setPersonAnchor] = useState(null);
  const [kindsAnchor, setKindsAnchor] = useState(null);
  const [form, setForm] = useState(null); // { eventId } | { day }
  const [item, setItem] = useState(null); // { boardId, itemId }
  const [meeting, setMeeting] = useState(null);
  const [day, setDay] = useState(''); // the day "+N more" lists
  const [meetings, setMeetings] = useState([]);
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState(null); // { ok, text }

  const entries = useMemo(() => collectEntries(state, { meetings }), [state, meetings]);
  const shown = useMemo(() => filterEntries(entries, { person, kinds }), [entries, person, kinds]);
  const earliest = [earliestDate(entries), status?.earliest].filter(Boolean).sort()[0] || '';
  const archive = useMemo(() => archiveMonths(today, earliest), [today, earliest]);

  // Google meetings for the months on screen: these twelve, and the Archive's once it's open.
  const from = archiveOpen && archive.length ? `${archive.at(-1)}-01` : `${months[0]}-01`;
  const to = lastOf(months.at(-1));
  // Only the newest request's answer is shown (opening the Archive mid-sync widens the range; an older, narrower answer
  // arriving later must not replace it).
  const asked = useRef(0);
  const loadMeetings = useCallback(async () => {
    const n = ++asked.current;
    const res = await calendar.meetings(from, to);
    if (res.ok && n === asked.current) setMeetings(res.rows);
  }, [calendar, from, to]);
  const loadRef = useRef(loadMeetings);
  loadRef.current = loadMeetings;
  const loadStatus = useCallback(async () => {
    const res = await calendar.status();
    if (res.ok) setStatus(res);
    return res;
  }, [calendar]);
  useEffect(() => { loadMeetings(); }, [loadMeetings]);

  const sync = useCallback(async (force = false) => {
    setSyncing(true);
    const res = await calendar.sync({ force });
    setSyncing(false);
    if (!res.ok) setNote({ ok: false, text: res.error || 'Couldn’t sync Google Calendar' });
    else if (res.failed) setNote({ ok: false, text: `${res.failed} calendar${res.failed === 1 ? '' : 's'} couldn’t sync` });
    await Promise.all([loadStatus(), loadRef.current()]); // the range on screen now, not when the sync started
  }, [calendar, loadStatus]);

  // Opening the Calendar syncs everyone's Google Calendar when the last sync is over 10 minutes old (live mode; the
  // google function also spaces each person's syncs out, so several people opening it at once sync once).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const back = hashParam('google');
    if (back) {
      const reason = back === 'error' ? hashParam('reason') : back;
      setNote(back === 'connected' ? { ok: true, text: 'Google Calendar connected' }
        : { ok: false, text: GOOGLE_ERRORS[reason] || 'Couldn’t connect Google Calendar. Try again.' });
      window.history.replaceState(window.history.state, '', '#/calendar'); // a reload doesn't repeat it (no hashchange)
      if (back === 'connected') { actions.refreshGoogle(); sync(true); return; }
    }
    loadStatus().then((res) => {
      if (!calendar.live || !res?.ok) return;
      const stale = !res.syncedAt || Date.now() - new Date(res.syncedAt).getTime() > STALE;
      if (stale && res.people.some((p) => p.connected)) sync(false);
    });
  }, [actions, calendar, loadStatus, sync]);

  const connect = async () => {
    const res = await actions.connectCalendar();
    if (res.ok) window.location.assign(res.url); // to Google, which comes back here
    else setNote({ ok: false, text: res.error || 'Couldn’t connect Google Calendar. Try again.' });
  };
  const stop = async () => {
    const ok = await actions.stopCalendar();
    setNote(ok ? { ok: true, text: 'Your calendar is no longer shared' } : { ok: false, text: 'Couldn’t stop sharing. Try again.' });
    await Promise.all([loadStatus(), loadRef.current()]);
  };

  const openEntry = (e) => {
    if (e.itemId) setItem({ boardId: e.boardId, itemId: e.itemId });
    else if (e.eventId) setForm({ eventId: e.eventId });
    else if (e.meeting) setMeeting(e);
    else if (e.href) window.location.hash = e.href.replace(/^#/, '');
  };
  const toggle = (set, setSet, key) => setSet(() => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const block = (m, open, onToggle, className) => {
    const list = inMonth(shown, m);
    return (
      <MonthBlock key={m} month={m} days={entriesByDay(list, m)} count={list.length} open={open} onToggle={onToggle} today={today}
        onOpen={openEntry} onMore={setDay} className={className} />
    );
  };

  const board = item ? findBoard(state, item.boardId) : null;
  const kindList = Object.keys(KINDS).filter((k) => !CLIENT_KINDS.includes(k) || access.canView('clients'));
  const people = state.users.filter((u) => u.active !== false);

  return (
    <div>
      <PageHeader title="Calendar" action="New event" onAction={() => setForm({ day: today })} />
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span ref={setPersonAnchor}>
          <IconButton icon={User} label={person ? 'Person filter on' : 'Filter by person'} active={!!person} onClick={() => setPopover(popover === 'person' ? null : 'person')} />
        </span>
        <span ref={setKindsAnchor}>
          <IconButton icon={ListFilter} label={kinds.size ? 'Kind filter on' : 'Filter by kind'} active={kinds.size > 0} onClick={() => setPopover(popover === 'kinds' ? null : 'kinds')} />
        </span>
        <div className="ml-auto"><GoogleCalendar status={status} syncing={syncing} onSync={() => sync(true)} onConnect={connect} onStop={stop} /></div>
      </div>
      <p role="status" className={cn('text-[12.5px]', note && 'mt-2', note?.ok ? 'text-emerald-200' : 'text-amber-200')}>{note?.text}</p>

      <Popover anchor={personAnchor} open={popover === 'person'} onClose={() => setPopover(null)} width={190} align="left">
        {[{ id: '', name: 'Everyone' }, ...people].map((u) => (
          <button key={u.id || 'all'} type="button" aria-pressed={person === u.id} onClick={() => { setPerson(u.id); setPopover(null); }}
            className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/10', person === u.id && 'bg-white/15')}>
            {u.id ? <Avatar userId={u.id} size={22} ring={false} /> : <span className="w-[22px]" />}{u.name}
          </button>
        ))}
      </Popover>
      <Popover anchor={kindsAnchor} open={popover === 'kinds'} onClose={() => setPopover(null)} width={200} align="left">
        <div className="flex flex-col gap-1.5">
          {kindList.map((k) => (
            <button key={k} type="button" aria-pressed={kinds.has(k)} onClick={() => toggle(kinds, setKinds, k)}
              className={cn('pill', kinds.has(k) && 'ring-2 ring-white')} style={{ backgroundColor: KINDS[k].color }}>{KINDS[k].label}</button>
          ))}
          <button type="button" aria-pressed={!kinds.size} className="pill pill-empty" onClick={() => { setKinds(new Set()); setPopover(null); }}>Everything</button>
        </div>
      </Popover>

      {months.map((m) => block(m, openMonths.has(m), () => toggle(openMonths, setOpenMonths, m)))}

      {archive.length > 0 && (
        <section className="mt-14 border-t rowline pt-6">
          <button type="button" onClick={() => setArchiveOpen((o) => !o)} aria-expanded={archiveOpen} className="flex items-center gap-2 text-[17px] font-extrabold">
            <ChevronDown className={cn('h-5 w-5 shrink-0 transition-transform', !archiveOpen && '-rotate-90')} />
            <Archive className="h-5 w-5 dim" />Archive<span className="text-[12px] font-semibold dimmer">{archive.length}</span>
          </button>
          {archiveOpen && archive.map((m) => block(m, openArchived.has(m), () => toggle(openArchived, setOpenArchived, m), 'ml-2 md:ml-7 !mt-5'))}
        </section>
      )}

      {form && <EventModal key={form.eventId || 'new'} eventId={form.eventId} day={form.day} onClose={() => setForm(null)} />}
      {meeting && <MeetingModal entry={meeting} onClose={() => setMeeting(null)} />}
      <Modal open={Boolean(day)} onClose={() => setDay('')} title={day ? dayName(day) : ''}>
        <div className="flex flex-col gap-1.5">
          {(day ? entriesByDay(inMonth(shown, day.slice(0, 7)), day.slice(0, 7)).get(day) || [] : []).map((e) => (
            <EntryChip key={e.key} entry={e} onOpen={(x) => { setDay(''); openEntry(x); }} />
          ))}
        </div>
      </Modal>
      {/* A task or post opens here, read only unless you can edit its board. */}
      <ItemDrawer key={item?.itemId ?? 'closed'} boardId={item?.boardId} schema={BOARD_SCHEMAS[board?.module] || BOARD_SCHEMAS.projects}
        itemId={board ? item.itemId : null} onClose={() => setItem(null)} readOnly={!board || !access.canEditBoard(board)} />
    </div>
  );
}
