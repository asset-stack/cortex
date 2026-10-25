// Who owns a board task and what comes first (docs/PHASE2.md §17): a task's owner, handing it over, My Work →
// Priorities, the admins' Needs attention list, @mentions in task updates and a client's linked tasks. Pure, with
// relative imports, so scripts/test-sync.mjs runs it in Node.
import { canViewBoard } from './access.js';
import { mentionedUserIds } from './mentionText.js';
import { BOARD_SCHEMAS, PRIORITY, withPeople } from '../data/boards.js';

// A task handed to someone by someone else shows as New in their Priorities for this long.
export const NEW_FOR = 2 * 864e5;
// The team rule Priorities reminds people of: one Urgent task at a time, and at most two In progress.
export const MAX_URGENT = 1;
export const MAX_IN_PROGRESS = 2;
// Why a task is on Needs attention, most pressing first.
export const ATTENTION = ['Overdue', 'Stuck', 'No owner', 'Several people', 'No priority'];

const PRIORITIES = Object.keys(PRIORITY);
const ymd = (v) => { const s = String(v ?? ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; };
const columns = (board) => BOARD_SCHEMAS[board?.module]?.columns || [];
/** Whether a board's tasks have one owner (an `owner` column) rather than a list of people. */
export const hasOwner = (board) => columns(board).some((c) => c.type === 'owner');
const hasPriority = (board) => columns(board).some((c) => c.key === 'priority');
const dateKey = (board) => columns(board).find((c) => c.type === 'date')?.key || 'due';

/** A task's owner: the first of its people ('' for none). */
export const ownerOf = (item) => (Array.isArray(item?.values?.people) ? item.values.people[0] || '' : '');

/**
 * A task's values after an edit (`patch`: the changed values; `owner` sets a single owner). Handing the task to someone
 * else records who did it and when (`assignedBy`, `assignedAt`: Priorities shows it as New); taking it yourself or
 * leaving it with no one clears them. Only this sets them, so a patch can't.
 */
export function nextValues(prev, patch, { me = '', now = new Date().toISOString() } = {}) {
  const next = { ...patch };
  if ('owner' in next && !('people' in next)) next.people = next.owner ? [next.owner] : []; // a single-person picker
  delete next.owner;
  delete next.assignedBy;
  delete next.assignedAt;
  const before = ownerOf({ values: withPeople(prev) });
  const values = withPeople({ ...prev, ...next });
  const after = ownerOf({ values });
  if (after === before) return values;
  const { assignedBy: _by, assignedAt: _at, ...rest } = values;
  return after && after !== me ? { ...rest, assignedBy: me, assignedAt: now } : rest;
}

// The boards `personId` sees that the signed-in user (`viewer`) sees too, in state order: an admin looking at someone's
// My Work gets what that person sees.
const boardsFor = (state, personId, viewer = state?.me) => (state?.boards || [])
  .filter((b) => canViewBoard(state, b, viewer) && (personId === viewer || canViewBoard(state, b, personId)));
const clientOf = (state, item) => {
  const id = item?.values?.client;
  return (id && (state?.clients || []).find((c) => c.id === id)) || null;
};
const rank = (p) => { const k = PRIORITIES.indexOf(p); return k < 0 ? PRIORITIES.length : k; };

/**
 * My Work → Priorities: the open tasks `personId` is on (their owner, or among the people of a task that still has
 * several), on every board they see, Urgent first, then High, Medium, Low and none; ties by the soonest due (none last),
 * then board order. Each row: { item, board, priority, due, overdue (due before `today`), client, isNew, from (who
 * handed it over) }.
 */
export function prioritiesFor(state, personId, { today = '', now = Date.now(), viewer = state?.me } = {}) {
  if (!personId) return [];
  const rows = boardsFor(state, personId, viewer).flatMap((board) => board.groups.flatMap((g) => g.items
    .filter((item) => !item.done && (item.values?.people || []).includes(personId))
    .map((item) => {
      const v = item.values || {};
      const due = ymd(v[dateKey(board)]);
      const at = Date.parse(v.assignedAt || '');
      const isNew = Boolean(v.assignedBy) && v.assignedBy !== personId && ownerOf(item) === personId
        && Number.isFinite(at) && now - at < NEW_FOR;
      return {
        item, board, priority: PRIORITIES.includes(v.priority) ? v.priority : '', due, overdue: Boolean(due && today && due < today),
        client: clientOf(state, item), isNew, from: isNew ? v.assignedBy : '',
      };
    })));
  const byDue = (a, b) => (a.due === b.due ? 0 : !a.due ? 1 : !b.due ? -1 : a.due < b.due ? -1 : 1);
  return rows.map((r, n) => [r, n]).sort(([a, x], [b, y]) => rank(a.priority) - rank(b.priority) || byDue(a, b) || x - y).map(([r]) => r);
}

/** How many of Priorities' tasks are Urgent and In progress (the team rule: MAX_URGENT, MAX_IN_PROGRESS). Only boards
 *  with an owner column count: Work in Progress' rows are clients someone looks after, not tasks. */
export function workload(rows) {
  const tasks = (rows || []).filter((r) => hasOwner(r.board));
  return {
    urgent: tasks.filter((r) => r.priority === 'Urgent').length,
    inProgress: tasks.filter((r) => r.item.values?.status === 'In progress').length,
  };
}

/**
 * Needs attention (admins, My Work): open tasks on the team boards with an owner column (Projects, Marketing, Outreach,
 * Clients) that are overdue (due before `today`), Stuck, have no owner or several people, or no priority. The ones with
 * the most pressing reason first, then board order. Each row: { item, board, reasons (in ATTENTION's order), client }.
 */
export function needsAttention(state, { today = '', viewer = state?.me } = {}) {
  const rows = (state?.boards || []).filter((b) => !b.owner && hasOwner(b) && canViewBoard(state, b, viewer)).flatMap((board) => board.groups
    .flatMap((g) => g.items.filter((item) => !item.done).map((item) => {
      const v = item.values || {};
      const people = Array.isArray(v.people) ? v.people : [];
      const due = ymd(v[dateKey(board)]);
      const reasons = [
        due && today && due < today && 'Overdue',
        v.status === 'Stuck' && 'Stuck',
        !people.length && 'No owner',
        people.length > 1 && 'Several people',
        hasPriority(board) && !PRIORITIES.includes(v.priority) && 'No priority',
      ].filter(Boolean);
      return { item, board, reasons, client: clientOf(state, item) };
    })))
    .filter((r) => r.reasons.length);
  const worst = (r) => ATTENTION.indexOf(r.reasons[0]);
  return rows.map((r, n) => [r, n]).sort(([a, x], [b, y]) => worst(a) - worst(b) || x - y).map(([r]) => r);
}

/**
 * Task updates that @name `person` (by name; "@here" names no one), by someone else, on the boards they see (and the
 * viewer sees), newest first: { id, kind: 'task', user, text, ts, board, item }. My Work → Mentions lists them with the
 * chat mentions.
 */
export function taskMentions(state, person, { viewer = state?.me } = {}) {
  if (!person?.id) return [];
  return boardsFor(state, person.id, viewer).flatMap((board) => board.groups.flatMap((g) => g.items.flatMap((item) => (item.updates || [])
    .filter((u) => u.user !== person.id && mentionedUserIds(u.text, state.users).includes(person.id))
    .map((u) => ({ id: `task:${u.id}`, kind: 'task', user: u.user, text: u.text, ts: u.ts, board, item })))))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/** A client's open linked tasks (`values.client`) on the boards the viewer sees, in board order: { item, board }. */
export function clientTasks(state, clientId, { viewer = state?.me } = {}) {
  if (!clientId) return [];
  return (state?.boards || []).filter((b) => canViewBoard(state, b, viewer)).flatMap((board) => board.groups
    .flatMap((g) => g.items.filter((item) => !item.done && item.values?.client === clientId).map((item) => ({ item, board }))));
}
