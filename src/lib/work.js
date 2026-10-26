// Who owns a board task and what comes first (docs/PHASE2.md §17, §18): a task's owner, handing it over and accepting
// it, the Dashboard's task lists, the Team pages, the admins' Needs attention list, @mentions in task updates, where a
// task lives, a client's linked tasks and Do today. Pure, with relative imports, so scripts/test-sync.mjs runs it in Node.
import { canEditBoard, canViewBoard } from './access.js';
import { MODULE_LABELS, boardTitle } from './boards.js';
import { mentionedUserIds } from './mentionText.js';
import { BOARD_SCHEMAS, PRIORITY, withPeople } from '../data/boards.js';

// A task handed to someone that they haven't accepted this long after goes on Needs attention.
export const ACCEPT_WITHIN = 864e5;
// The team rule My tasks reminds people of: one Urgent task at a time, and at most two In progress.
export const MAX_URGENT = 1;
export const MAX_IN_PROGRESS = 2;
// Why a task is on Needs attention, most pressing first.
export const ATTENTION = ['Overdue', 'Stuck', 'Not accepted', 'No owner', 'Several people', 'No priority'];
// The sections of someone's task list, in order: what's blocked, what they're on, what's next, and what still needs a
// priority (docs/PHASE2.md §18).
export const STAGES = ['Stuck', 'In progress', 'Up next', 'No priority'];

const PRIORITIES = Object.keys(PRIORITY);
const ymd = (v) => { const s = String(v ?? ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; };
const columns = (board) => BOARD_SCHEMAS[board?.module]?.columns || [];
/** Whether a board's tasks have one owner (an `owner` column) rather than a list of people. */
export const hasOwner = (board) => columns(board).some((c) => c.type === 'owner');
/** Whether a board's tasks have a priority (a Priority column; not Work in Progress). */
export const hasPriority = (board) => columns(board).some((c) => c.key === 'priority');
/** Whether a board's tasks can be linked to a client (a `client` column: the Clients boards). */
export const hasClient = (board) => columns(board).some((c) => c.type === 'client');
/** Whether a board's tasks can be linked to a deal (a `deal` column: the Outreach boards). */
export const hasDeal = (board) => columns(board).some((c) => c.type === 'deal');
const dateKey = (board) => columns(board).find((c) => c.type === 'date')?.key || 'due';

/** A task's owner: the first of its people ('' for none). */
export const ownerOf = (item) => (Array.isArray(item?.values?.people) ? item.values.people[0] || '' : '');

/** Whether a task waits on its owner to accept it: someone else handed it to them and they haven't accepted it yet. */
export function isWaiting(item) {
  const v = item?.values || {};
  const owner = ownerOf(item);
  return Boolean(owner && v.assignedBy && v.assignedBy !== owner && !v.acceptedAt);
}

/**
 * A task's values after an edit (`patch`: the changed values; `owner` sets a single owner), by `me` at `now`. Handing
 * the task to someone else records who did it and when (`assignedBy`, `assignedAt`): it then waits on them to accept it
 * (`acceptedAt`, set by acceptedValues(), or here when they change its status: starting it accepts it). Taking it
 * yourself or leaving it with no one clears all three. Only this and acceptedValues() set them, so a patch can't.
 */
export function nextValues(prev, patch, { me = '', now = new Date().toISOString() } = {}) {
  const next = { ...patch };
  if ('owner' in next && !('people' in next)) next.people = next.owner ? [next.owner] : []; // a single-person picker
  delete next.owner;
  delete next.assignedBy;
  delete next.assignedAt;
  delete next.acceptedAt;
  const before = ownerOf({ values: withPeople(prev) });
  const values = withPeople({ ...prev, ...next });
  const after = ownerOf({ values });
  if (after === before) {
    return 'status' in next && me === after && isWaiting({ values }) ? { ...values, acceptedAt: now } : values;
  }
  const { assignedBy: _by, assignedAt: _at, acceptedAt: _ok, ...rest } = values;
  return after && after !== me ? { ...rest, assignedBy: me, assignedAt: now } : rest;
}

/** A waiting task's values once `me`, its owner, accepts it; null when it isn't waiting on `me`. */
export const acceptedValues = (values, { me = '', now = new Date().toISOString() } = {}) => (
  isWaiting({ values }) && ownerOf({ values }) === me ? { ...values, acceptedAt: now } : null);

/** A new task's values: it starts Not started with `me` as its owner, then `values` apply as an edit would (so a task
 *  made for someone else waits on them to accept it). */
export const newTaskValues = (values = {}, { me = '', now = new Date().toISOString() } = {}) => nextValues(
  withPeople({ status: 'Not started', people: me ? [me] : [] }), values, { me, now });

/** Where a task lives, for its breadcrumb: its department (the menu it's under: Operations, Marketing …) and board
 *  ("David’s notes" alone for a personal page), then its client when linked. */
export function whereOf(state, board, item) {
  if (!board) return [];
  const client = clientOf(state, item);
  return [...(board.owner ? [] : [MODULE_LABELS[board.module] || '']), boardTitle(state, board), ...(client ? [client.name] : [])].filter(Boolean);
}

// The boards `personId` sees that the signed-in user (`viewer`) sees too, in state order: an admin looking at someone's
// Dashboard gets what that person sees. `teamOnly`: no personal pages (the Team pages; notes stay private).
const boardsFor = (state, personId, viewer = state?.me, teamOnly = false) => (state?.boards || [])
  .filter((b) => (!teamOnly || !b.owner) && canViewBoard(state, b, viewer) && (personId === viewer || canViewBoard(state, b, personId)));
function clientOf(state, item) {
  const id = item?.values?.client;
  return (id && (state?.clients || []).find((c) => c.id === id)) || null;
}
const rank = (p) => { const k = PRIORITIES.indexOf(p); return k < 0 ? PRIORITIES.length : k; };

/**
 * The Dashboard's task lists (and a Team page's): the open tasks `personId` is on (their owner, or among the people of a
 * task that still has several), on every board they see (`teamOnly`: team boards only), Urgent first, then High,
 * Medium, Low and none; ties by the soonest due (none last), then board order. Each row: { item, board, priority, due,
 * overdue (due before `today`), client, waiting (waits on them to accept it), from (who handed it to them) }.
 */
export function prioritiesFor(state, personId, { today = '', viewer = state?.me, teamOnly = false } = {}) {
  if (!personId) return [];
  const rows = boardsFor(state, personId, viewer, teamOnly).flatMap((board) => board.groups.flatMap((g) => g.items
    .filter((item) => !item.done && (item.values?.people || []).includes(personId))
    .map((item) => {
      const v = item.values || {};
      const due = ymd(v[dateKey(board)]);
      const waiting = hasOwner(board) && isWaiting(item) && ownerOf(item) === personId; // Work in Progress' rows aren't tasks
      return {
        item, board, priority: PRIORITIES.includes(v.priority) ? v.priority : '', due, overdue: Boolean(due && today && due < today),
        client: clientOf(state, item), waiting, from: waiting ? v.assignedBy : '',
      };
    })));
  const byDue = (a, b) => (a.due === b.due ? 0 : !a.due ? 1 : !b.due ? -1 : a.due < b.due ? -1 : 1);
  return rows.map((r, n) => [r, n]).sort(([a, x], [b, y]) => rank(a.priority) - rank(b.priority) || byDue(a, b) || x - y).map(([r]) => r);
}

/** Which section of the task list a row (prioritiesFor) goes in: its status when Stuck or In progress, else Up next with
 *  a priority and No priority without one. */
export function stageOf(row) {
  const status = row?.item?.values?.status;
  if (status === 'Stuck' || status === 'In progress') return status;
  return row?.priority ? 'Up next' : 'No priority';
}

/** Rows grouped by stage, in STAGES order, empty stages left out; each keeps the rows' order (Urgent first, then due
 *  date, then board order: prioritiesFor's). → [{ stage, rows }] */
export function byStage(rows) {
  const list = rows || [];
  return STAGES.map((stage) => ({ stage, rows: list.filter((r) => stageOf(r) === stage) })).filter((g) => g.rows.length);
}

/** How many of someone's tasks wait on them, are Urgent, In progress or overdue, and are open (the Dashboard's numbers,
 *  the Team cards and the team rule: MAX_URGENT, MAX_IN_PROGRESS). Only boards with an owner column count: Work in
 *  Progress' rows are clients someone looks after, not tasks. */
export function workload(rows) {
  const tasks = (rows || []).filter((r) => hasOwner(r.board));
  return {
    waiting: tasks.filter((r) => r.waiting).length,
    urgent: tasks.filter((r) => r.priority === 'Urgent').length,
    inProgress: tasks.filter((r) => r.item.values?.status === 'In progress').length,
    overdue: tasks.filter((r) => r.overdue).length,
    open: tasks.length,
  };
}

/**
 * Needs attention (admins, Dashboard): open tasks on the team boards with an owner column (Operations, Marketing,
 * Outreach, Clients) that are overdue (due before `today`), Stuck, not accepted ACCEPT_WITHIN after being handed over
 * (by `now`), have no owner (nobody, or only people who can't edit the board: deactivated, or without access, so nobody
 * can take it on) or several people, or no priority. The ones with the most pressing reason first, then board order.
 * Each row: { item, board, reasons (in ATTENTION's order), client }.
 */
export function needsAttention(state, { today = '', now = Date.now(), viewer = state?.me } = {}) {
  const rows = (state?.boards || []).filter((b) => !b.owner && hasOwner(b) && canViewBoard(state, b, viewer)).flatMap((board) => board.groups
    .flatMap((g) => g.items.filter((item) => !item.done).map((item) => {
      const v = item.values || {};
      const people = Array.isArray(v.people) ? v.people : [];
      const due = ymd(v[dateKey(board)]);
      const reasons = [
        due && today && due < today && 'Overdue',
        v.status === 'Stuck' && 'Stuck',
        isWaiting(item) && now - Date.parse(v.assignedAt || '') > ACCEPT_WITHIN && 'Not accepted',
        !people.some((id) => canEditBoard(state, board, id)) && 'No owner',
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

/** A client's open next steps on the boards the viewer sees, in board order: tasks linked to it (`values.client`, Clients
 *  boards) and to the deal it came from (`values.deal`, Outreach boards). → [{ item, board }] */
export function clientTasks(state, clientId, { viewer = state?.me } = {}) {
  if (!clientId) return [];
  const dealId = (state?.deals || []).find((d) => d.clientId === clientId)?.id || '';
  return (state?.boards || []).filter((b) => (hasClient(b) || (dealId && hasDeal(b))) && canViewBoard(state, b, viewer))
    .flatMap((board) => board.groups.flatMap((g) => g.items
      .filter((item) => !item.done && ((hasClient(board) && item.values?.client === clientId) || (dealId && hasDeal(board) && item.values?.deal === dealId)))
      .map((item) => ({ item, board }))));
}

/** A deal's open next steps (`values.deal`, Outreach boards) on the boards the viewer sees, in board order:
 *  [{ item, board }]. */
export function dealTasks(state, dealId, { viewer = state?.me } = {}) {
  if (!dealId) return [];
  return (state?.boards || []).filter((b) => hasDeal(b) && canViewBoard(state, b, viewer)).flatMap((board) => board.groups
    .flatMap((g) => g.items.filter((item) => !item.done && item.values?.deal === dealId).map((item) => ({ item, board }))));
}

// ── Do today: a to-do on someone's day for a board task (source 'manual', ref 'item:<id>'; no migration) ──
const ITEM_REF = 'item:';
export const itemRef = (itemId) => `${ITEM_REF}${itemId}`;
/** The task id a to-do was made for ('' for any other to-do). */
export const todoItemId = (todo) => (String(todo?.ref || '').startsWith(ITEM_REF) ? String(todo.ref).slice(ITEM_REF.length) : '');
/** The to-do already on `assignee`'s `day` for task `itemId`, if any (one per task, person and day). */
export const todoForItem = (todos, itemId, assignee, day) => (todos || [])
  .find((t) => t.assignee === assignee && t.day === day && todoItemId(t) === itemId) || null;
/** The board and task a to-do was made for, while the viewer can still see it: { board, item } or null. */
export function itemOfTodo(state, todo, { viewer = state?.me } = {}) {
  const id = todoItemId(todo);
  if (!id) return null;
  for (const board of state?.boards || []) {
    const item = board.groups.flatMap((g) => g.items).find((i) => i.id === id);
    if (item) return canViewBoard(state, board, viewer) ? { board, item } : null;
  }
  return null;
}
