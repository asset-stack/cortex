// The team Calendar and the boards' 3-month calendar (docs/PHASE2.md §15): what goes on them and on which day. Pure,
// with relative imports, so scripts/test-sync.mjs runs it in Node. Dates are 'YYYY-MM-DD'; a week starts on Monday.
import { addDays, addMonths, isoDow, isYmd, mondayOf } from './automations.js';
import { canView, canViewBoard } from './access.js';
import { ymdIn } from './format.js';
import { BOARD_SCHEMAS, hasDates } from '../data/boards.js';

// What an entry is, its colour and its filter label.
export const KINDS = {
  task: { label: 'Tasks', color: '#579bfc' },
  post: { label: 'Posts', color: '#a25ddc' },
  meeting: { label: 'Meetings', color: '#00c875' },
  event: { label: 'Events', color: '#fdab3d' },
  reminder: { label: 'Reminders', color: '#ff7575' },
  google: { label: 'Google', color: '#0f9f8f' },
  invoice: { label: 'Invoices', color: '#e2445c' },
  contract: { label: 'Contracts', color: '#7e8799' },
};
// The kinds of event someone adds on the Calendar (calendar_events.kind).
export const EVENT_KINDS = { meeting: 'Meeting', event: 'Event', reminder: 'Reminder' };
// Kinds only someone who can see Clients gets.
export const CLIENT_KINDS = ['invoice', 'contract'];
// Things at a time or on a day (meetings and events) rather than due dates.
const SCHEDULED = ['meeting', 'event', 'reminder', 'google'];

export const monthKey = (ymd) => String(ymd || '').slice(0, 7);
const firstOf = (month) => `${month}-01`;
export const lastOf = (month) => addDays(addMonths(firstOf(month), 1), -1);
const dayNumber = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };

// ISO 8601 week number: the week of the year its Thursday falls in (29 Dec 2026 is week 53, 4 Jan 2027 week 1).
export function isoWeek(ymd) {
  const thursday = addDays(ymd, 4 - isoDow(ymd));
  return 1 + Math.floor((dayNumber(thursday) - dayNumber(`${thursday.slice(0, 4)}-01-01`)) / 7);
}

// A month ('YYYY-MM') as its weeks: each from its Monday, with its seven days (some in the months either side).
export function monthWeeks(month) {
  const last = lastOf(month);
  const weeks = [];
  for (let monday = mondayOf(firstOf(month)); monday <= last; monday = addDays(monday, 7)) {
    weeks.push({ monday, week: isoWeek(monday), days: Array.from({ length: 7 }, (_, i) => addDays(monday, i)) });
  }
  return weeks;
}

// `n` months from today's ('YYYY-MM' each).
export const nextMonths = (today, n = 12) => Array.from({ length: n }, (_, i) => monthKey(addMonths(firstOf(monthKey(today)), i)));

// The Archive: finished months, newest first, from last month back to `earliest`'s (at most `cap` of them).
export function archiveMonths(today, earliest, cap = 60) {
  const out = [];
  if (!isYmd(earliest)) return out;
  const stop = monthKey(earliest);
  for (let m = monthKey(addMonths(firstOf(monthKey(today)), -1)); m >= stop && out.length < cap; m = monthKey(addMonths(firstOf(m), -1))) out.push(m);
  return out;
}

// An instant ('2026-10-20T23:00:00Z') as a date and 'HH:MM' in a time zone (the browser's when none or unknown).
export function placeAt(iso, tz) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return { date: '', time: '' };
  let time = '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const part = (type) => parts.find((p) => p.type === type)?.value || '00';
    time = `${part('hour')}:${part('minute')}`;
  } catch {
    time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return { date: tz ? ymdIn(tz, d) : ymdIn(undefined, d), time };
}

const entry = (kind, fields) => ({ kind, color: KINDS[kind].color, time: '', endTime: '', people: [], done: false, ...fields });

/**
 * Everything dated that `userId` (default: the signed-in user) may see, as calendar entries:
 * `{ key, kind, date, endDate, time, endTime, title, people, color, done, … }` plus how to open it (`boardId` / `itemId`,
 * `eventId`, `meeting`, or `href`). Each source keeps its own access rule, as RLS does in live mode (demo state holds
 * everyone's data): board tasks on boards they can see (a board showing its calendar makes them posts); the team's
 * events and Google meetings for everyone; invoice due dates and contract dates only with Clients access. Timed
 * events and meetings sit on their start day in `tz` (the viewer's zone).
 */
export function collectEntries(state, { meetings = [], tz, userId = state?.me } = {}) {
  const out = [];
  (state?.boards || []).forEach((b) => {
    if (!hasDates(BOARD_SCHEMAS[b.module]) || !canViewBoard(state, b, userId)) return;
    const kind = b.calendar && !b.owner ? 'post' : 'task';
    (b.groups || []).forEach((g) => (g.items || []).forEach((it) => {
      const due = it.values?.due;
      if (!isYmd(due)) return;
      out.push(entry(kind, {
        key: `item:${it.id}`, date: due, endDate: due, title: String(it.name || '').trim() || 'Untitled', people: it.values.people || [],
        done: Boolean(it.done) || it.values.status === 'Done', status: it.values.status || '', boardId: b.id, itemId: it.id,
      }));
    }));
  });
  (state?.calendarEvents || []).forEach((x) => {
    if (!isYmd(x.day) || !EVENT_KINDS[x.kind]) return;
    const start = x.startsAt ? placeAt(x.startsAt, tz) : null;
    const date = start?.date || x.day;
    out.push(entry(x.kind, {
      key: `event:${x.id}`, date, endDate: start ? date : (isYmd(x.endDay) && x.endDay > x.day ? x.endDay : x.day), time: start?.time || '',
      endTime: x.endsAt ? placeAt(x.endsAt, tz).time : '', title: String(x.title || '').trim() || EVENT_KINDS[x.kind], people: x.people || [],
      eventId: x.id,
    }));
  });
  meetings.forEach((m) => {
    if (m.all_day ? !isYmd(m.start_date) : !m.start_at) return;
    const start = m.all_day ? null : placeAt(m.start_at, tz);
    const date = start?.date || m.start_date;
    out.push(entry('google', {
      key: `meeting:${m.id}`, date, endDate: start ? date : (isYmd(m.end_date) && m.end_date > m.start_date ? m.end_date : m.start_date),
      time: start?.time || '', endTime: m.end_at && !m.all_day ? placeAt(m.end_at, tz).time : '',
      title: m.busy ? 'Busy' : String(m.title || '').trim() || 'Untitled', people: m.user_id ? [m.user_id] : [], busy: Boolean(m.busy), meeting: m,
    }));
  });
  if (canView(state, 'clients', userId)) {
    (state?.clients || []).forEach((c) => {
      (c.invoices || []).forEach((inv) => {
        if (!isYmd(inv.due) || inv.status === 'Void') return;
        out.push(entry('invoice', {
          key: `invoice:${inv.id}`, date: inv.due, endDate: inv.due, title: `${inv.number || 'Invoice'} due · ${c.name}`,
          done: inv.status === 'Paid', status: inv.status, href: '#/clients?tab=invoices',
        }));
      });
      (c.contracts || []).forEach((k) => {
        if (k.status === 'Cancelled') return;
        const what = String(k.title || '').trim() || 'Contract';
        [['startDate', 'starts'], ['endDate', 'ends']].forEach(([field, word]) => {
          if (!isYmd(k[field])) return;
          out.push(entry('contract', {
            key: `contract:${k.id}:${field}`, date: k[field], endDate: k[field], title: `${c.name}: ${what} ${word}`, status: k.status,
            href: '#/clients',
          }));
        });
      });
    });
  }
  // By day; on a day, meetings and events first (all-day ones, then by time), then tasks, posts and Clients dates by title,
  // so a busy day's "+N more" hides tasks rather than meetings.
  const rank = (e) => (SCHEDULED.includes(e.kind) ? 0 : 1);
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || rank(a) - rank(b)
    || (a.time ? 1 : 0) - (b.time ? 1 : 0) || a.time.localeCompare(b.time) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
}

// Entries for each day of a month ('YYYY-MM' → Map of 'YYYY-MM-DD' → entries). A multi-day all-day entry is on every
// day it covers in that month; a timed one on its start day.
export function entriesByDay(entries, month) {
  const first = firstOf(month);
  const last = lastOf(month);
  const days = new Map();
  entries.forEach((e) => {
    const end = e.endDate && e.endDate > e.date ? e.endDate : e.date;
    if (end < first || e.date > last) return;
    for (let d = e.date < first ? first : e.date; d <= end && d <= last; d = addDays(d, 1)) {
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(e);
    }
  });
  return days;
}

// Entries touching a month.
export const inMonth = (entries, month) => entries.filter((e) => (e.endDate || e.date) >= firstOf(month) && e.date <= lastOf(month));

// The person filter (their tasks, events and meetings) and the kind filter (an empty set shows every kind).
export const filterEntries = (entries, { person = '', kinds } = {}) => entries.filter((e) => (!person || e.people.includes(person))
  && (!kinds || !kinds.size || kinds.has(e.kind)));

// The earliest date among entries ('' for none): where the Archive starts.
export const earliestDate = (entries) => entries.reduce((min, e) => (!min || e.date < min ? e.date : min), '');

const validIso = (v) => Boolean(v) && !Number.isNaN(new Date(v).getTime());

/**
 * A team event's fields, cleaned (calendar_events' checks): a known kind, a title (≤ 200), a day; an all-day event may
 * end on a later day; a timed one has a start and an end no earlier than it (ISO instants; both or neither); people are
 * known users, once each. → the cleaned fields, or null when they can't be saved.
 */
export function cleanCalendarEvent(fields = {}, userIds = []) {
  const title = String(fields.title ?? '').trim().slice(0, 200);
  if (!EVENT_KINDS[fields.kind] || !title || !isYmd(fields.day)) return null;
  const timed = validIso(fields.startsAt);
  if (timed && (!validIso(fields.endsAt) || new Date(fields.endsAt) < new Date(fields.startsAt))) return null;
  if (!timed && fields.endsAt) return null;
  const endDay = !timed && isYmd(fields.endDay) && fields.endDay > fields.day ? fields.endDay : '';
  if (!timed && isYmd(fields.endDay) && fields.endDay < fields.day) return null;
  const known = new Set(userIds);
  return {
    kind: fields.kind, title, day: fields.day, endDay,
    startsAt: timed ? new Date(fields.startsAt).toISOString() : '', endsAt: timed ? new Date(fields.endsAt).toISOString() : '',
    people: [...new Set((fields.people || []).filter((u) => known.has(u)))],
  };
}

// A day and 'HH:MM' in this browser's zone → an ISO instant ('' when either is missing), as the event form saves times.
export function localInstant(day, hm) {
  if (!isYmd(day) || !/^\d{2}:\d{2}$/.test(String(hm || ''))) return '';
  const d = new Date(`${day}T${hm}:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
