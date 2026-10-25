// The boards under Projects, Marketing, Outreach and Clients, and on the Pipeline page (state.boards, docs/PHASE2.md
// §11): team boards (Landing Page, Posting schedule, Sales Tasks, Demos, Work in Progress …) and each person's own
// Projects page (`owner` set). Pure helpers; access rules are in src/lib/access.js.
// Relative imports with extensions, so scripts/test-sync.mjs can load this file in Node.

export const BOARD_MODULES = ['projects', 'marketing', 'outreach', 'clients', 'pipeline'];
// What each board module is called on screen (its menu, a task's breadcrumb, Settings → Team). Projects is shown as
// Operations since §18 (its key, database and timesheet category stay 'projects' / Projects).
export const MODULE_LABELS = { projects: 'Operations', marketing: 'Marketing', outreach: 'Outreach', clients: 'Clients', pipeline: 'Pipeline' };
// Modules whose boards sit on the module's own page, under its main content (Pipeline: Work in Progress under the
// deals), rather than in the sidebar; the others list theirs as sub-menus.
export const PAGE_BOARD_MODULES = ['pipeline'];
export const MENU_BOARD_MODULES = BOARD_MODULES.filter((m) => !PAGE_BOARD_MODULES.includes(m));

// What each module starts with: 0006 for Projects and Marketing, 0007 for Outreach and Clients, 0008 for Pipeline.
// `existing`: where the module's groups from before sub-boards go.
export const STARTING_BOARDS = {
  projects: ['Landing Page', 'Tender Portal', 'General'],
  marketing: ['Daily Automation', 'Posting schedule', 'Campaigns', 'Events'],
  outreach: ['Sales Tasks'],
  clients: ['Demos', 'Previews'],
  pipeline: ['Work in Progress'],
};
export const EXISTING_BOARD = { projects: 'General', marketing: 'Posting schedule' };
// The group a new board starts with, so it has somewhere to add tasks.
export const FIRST_GROUP = { projects: 'Active', marketing: 'To do', outreach: 'To do', clients: 'To do', pipeline: 'Active' };
// Modules whose menu starts with their own page (#/outreach: the email dashboard; #/clients: the client list), then
// their boards (#/<module>/<board id>). `id` is the menu entry's, unique across modules.
export const MODULE_HOMES = {
  outreach: { id: 'outreach:home', href: '#/outreach', title: 'Email dashboard' },
  clients: { id: 'clients:home', href: '#/clients', title: 'Clients' },
};
export const FIRST_GROUP_COLOR = '#c9ffe6';
export const GROUP_COLORS = ['#c9ffe6', '#bfe9ff', '#ead9ff', '#ffe6b0', '#ffd6e0', '#e6eaf2', '#d6e4ff'];

const list = (state) => state?.boards || [];

export const findBoard = (state, id) => list(state).find((b) => b.id === id);
export const personalBoard = (state, userId) => list(state).find((b) => b.module === 'projects' && b.owner === userId);
export const teamBoards = (state, module) => list(state).filter((b) => b.module === module && !b.owner);
export const boardOfItem = (state, itemId) => list(state).find((b) => b.groups.some((g) => g.items.some((i) => i.id === itemId)));
export const boardItems = (board) => (board?.groups || []).flatMap((g) => g.items);

/** Whether a task or group may move from one board to the other: the same module and the same audience (two team
 *  boards, or within one person's page), so who can see it never changes. same_audience() in 0006. */
export const sameAudience = (a, b) => Boolean(a && b) && a.module === b.module && (a.owner || '') === (b.owner || '');

/**
 * A board's groups with task `itemId` placed in group `toGroupId` just before task `beforeId` (null, or a task that isn't
 * in that group: at its end). Working from "before this task" rather than an index keeps a drop right while search or
 * filters hide rows. → the new groups (the task itself unchanged), or null when the task or group isn't on the board or
 * nothing would change.
 */
export function withItemPlaced(groups, itemId, toGroupId, beforeId = null) {
  const list = groups || [];
  const from = list.find((g) => g.items.some((i) => i.id === itemId));
  const to = list.find((g) => g.id === toGroupId);
  if (!from || !to || beforeId === itemId) return null;
  const item = from.items.find((i) => i.id === itemId);
  const out = list.map((g) => (g === from || g === to ? { ...g, items: g.items.filter((i) => i.id !== itemId) } : g));
  const target = out[list.indexOf(to)];
  const at = beforeId ? target.items.findIndex((i) => i.id === beforeId) : -1;
  target.items.splice(at < 0 ? target.items.length : at, 0, item);
  const ids = (g) => g.items.map((i) => i.id).join('\u0000');
  return from === to && ids(target) === ids(from) ? null : out;
}

/**
 * A group's tasks in Sort's order. `by`: 'due' (the soonest due first, no date last; ties by priority) or 'priority'
 * (in `priorities`' order, e.g. High, Medium, Low, then none; ties by the soonest due). Stable: tasks that tie keep their
 * order. `dateKey`: the board's date column.
 */
export function sortedItems(items, by, { priorities = [], dateKey = 'due' } = {}) {
  const day = (i) => { const v = String(i.values?.[dateKey] ?? ''); return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : ''; };
  const due = (a, b) => { const x = day(a); const y = day(b); return x === y ? 0 : !x ? 1 : !y ? -1 : x < y ? -1 : 1; };
  const rank = (i) => { const k = priorities.indexOf(i.values?.priority); return k < 0 ? priorities.length : k; };
  const pri = (a, b) => rank(a) - rank(b);
  const cmp = by === 'priority' ? (a, b) => pri(a, b) || due(a, b) : (a, b) => due(a, b) || pri(a, b);
  return (items || []).map((it, n) => [it, n]).sort(([a, x], [b, y]) => cmp(a, b) || x - y).map(([it]) => it);
}

export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Someone';

/** "Landing Page", or "Shem’s notes" for a personal board (its owner's page, on their Dashboard as My notes). */
export function boardTitle(state, board) {
  if (!board) return '';
  if (!board.owner) return String(board.name ?? '').trim() || 'Untitled board';
  const owner = (state?.users || []).find((u) => u.id === board.owner);
  return `${firstName(owner?.name)}’s notes`;
}

/** #/projects/<board id>, optionally opening a task. */
export const boardHref = (board, itemId) => (board
  ? `#/${board.module}/${board.id}${itemId ? `?item=${encodeURIComponent(itemId)}` : ''}`
  : '#/dashboard');

/**
 * The board a #/<module>/<sub> address shows, from the boards `visible` to the signed-in user (in state order):
 * the board named by `sub`; else the one holding `itemId` (old #/projects?item= links); else the module's default
 * (its first team board: team work comes first; for Projects with none you can see, your own page). null when there
 * is none. A module with its own page
 * (MODULE_HOMES: Outreach, Clients) has no default board: #/<module> is that page, so only a named board (or the one
 * holding `itemId`) is shown.
 */
export function resolveBoard(state, visible, module, sub, itemId) {
  const mine = visible.filter((b) => b.module === module);
  if (!mine.length) return null;
  const named = sub && mine.find((b) => b.id === sub);
  if (named) return named;
  const holding = itemId && mine.find((b) => b.groups.some((g) => g.items.some((i) => i.id === itemId)));
  if (holding) return holding;
  if (MODULE_HOMES[module] || PAGE_BOARD_MODULES.includes(module)) return null;
  return mine.find((b) => !b.owner) || (module === 'projects' && mine.find((b) => b.owner === state?.me)) || mine[0];
}
