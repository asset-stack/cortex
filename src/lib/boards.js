// The boards under Projects, Marketing, Outreach and Clients, and on the Pipeline page (state.boards, docs/PHASE2.md
// §11): team boards (Landing Page, Posting schedule, Sales Tasks, Demos, Work in Progress …) and each person's own
// Projects page (`owner` set). Pure helpers; access rules are in src/lib/access.js.
// Relative imports with extensions, so scripts/test-sync.mjs can load this file in Node.

export const BOARD_MODULES = ['projects', 'marketing', 'outreach', 'clients', 'pipeline'];
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

export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Someone';

/** "Landing Page", or "Shem’s Projects" for a personal board. */
export function boardTitle(state, board) {
  if (!board) return '';
  if (!board.owner) return String(board.name ?? '').trim() || 'Untitled board';
  const owner = (state?.users || []).find((u) => u.id === board.owner);
  return `${firstName(owner?.name)}’s Projects`;
}

/** #/projects/<board id>, optionally opening a task. */
export const boardHref = (board, itemId) => (board
  ? `#/${board.module}/${board.id}${itemId ? `?item=${encodeURIComponent(itemId)}` : ''}`
  : '#/work');

/**
 * The board a #/<module>/<sub> address shows, from the boards `visible` to the signed-in user (in state order):
 * the board named by `sub`; else the one holding `itemId` (old #/projects?item= links); else the module's default
 * (your own page for Projects, the first team board otherwise). null when there is none. A module with its own page
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
  return (module === 'projects' && mine.find((b) => b.owner === state?.me)) || mine.find((b) => !b.owner) || mine[0];
}
