// The boards under Projects and Marketing (state.boards, docs/PHASE2.md §11): team boards (Landing Page, Posting
// schedule …) and each person's own Projects page (`owner` set). Pure helpers; access rules are in src/lib/access.js.
// Relative imports with extensions, so scripts/test-sync.mjs can load this file in Node.

export const BOARD_MODULES = ['projects', 'marketing'];

// What 0006 starts each module with. `existing`: where the module's groups from before sub-boards go.
export const STARTING_BOARDS = {
  projects: ['Landing Page', 'Tender Portal', 'General'],
  marketing: ['Daily Automation', 'Posting schedule', 'Campaigns', 'Events'],
};
export const EXISTING_BOARD = { projects: 'General', marketing: 'Posting schedule' };
// The group a new board starts with, so it has somewhere to add tasks.
export const FIRST_GROUP = { projects: 'Active', marketing: 'To do' };
export const FIRST_GROUP_COLOR = '#c9ffe6';
export const GROUP_COLORS = ['#c9ffe6', '#bfe9ff', '#ead9ff', '#ffe6b0', '#ffd6e0', '#e6eaf2', '#d6e4ff'];

const list = (state) => state?.boards || [];

export const findBoard = (state, id) => list(state).find((b) => b.id === id);
export const personalBoard = (state, userId) => list(state).find((b) => b.module === 'projects' && b.owner === userId);
export const teamBoards = (state, module) => list(state).filter((b) => b.module === module && !b.owner);
export const boardOfItem = (state, itemId) => list(state).find((b) => b.groups.some((g) => g.items.some((i) => i.id === itemId)));
export const boardItems = (board) => (board?.groups || []).flatMap((g) => g.items);

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
 * (your own page for Projects, the first team board otherwise). null when there is none.
 */
export function resolveBoard(state, visible, module, sub, itemId) {
  const mine = visible.filter((b) => b.module === module);
  if (!mine.length) return null;
  const named = sub && mine.find((b) => b.id === sub);
  if (named) return named;
  const holding = itemId && mine.find((b) => b.groups.some((g) => g.items.some((i) => i.id === itemId)));
  if (holding) return holding;
  return (module === 'projects' && mine.find((b) => b.owner === state?.me)) || mine.find((b) => !b.owner) || mine[0];
}
