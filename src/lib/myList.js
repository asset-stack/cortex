// My list (0017, docs/PHASE2.md §27): each person's own lines at the top of their Dashboard, not linked to anything.
// Pure helpers; the store's actions use them (and refuse anyone else's line, as 0017's policies do).
// Relative imports with extensions, so scripts/test-sync.mjs can load this file in Node.

export const LIST_MAX = 500; // a line's length (0017's check)

/** A line's text as kept: one line, trimmed, at most LIST_MAX characters; '' when there's nothing. */
export const cleanListText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, LIST_MAX);

/** `personId`'s lines, in their order (position, then when added). */
export const listOf = (state, personId = state?.me) => (state?.myList || [])
  .filter((x) => x.user === personId)
  .map((x, n) => ({ x, n }))
  .sort((a, b) => (a.x.position ?? 0) - (b.x.position ?? 0) || String(a.x.createdAt || '').localeCompare(String(b.x.createdAt || '')) || a.n - b.n)
  .map(({ x }) => x);
