// @mention text helpers for team chat and task updates. Mentions are plain text "@Name" matched against team members.
// Pure, with no JSX, so scripts/test-sync.mjs can load this file in Node (src/lib/mentions.jsx re-exports it).

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// '@' only counts at the start or after whitespace/punctuation, so URLs and emails don't match.
// A capture group rather than a lookbehind keeps older Safari working.
const LEAD = '(^|[^\\w@./:-])';

export function mentionRegex(users) {
  const names = users.map((u) => escape(u.name)).sort((a, b) => b.length - a.length);
  return new RegExp(`${LEAD}@(${names.join('|')}|here)\\b`, 'gi');
}

export function mentionsUser(text, user) {
  if (!user?.name) return false;
  const re = new RegExp(`${LEAD}@(${escape(user.name)}|here)\\b`, 'i');
  return re.test(text);
}

// Ids of the active people @named in a text, in order of first mention, each once ("@here" names nobody in
// particular). My Work → Mentions uses this for task updates (src/lib/work.js).
export function mentionedUserIds(text, users) {
  const active = (users || []).filter((u) => u && u.id && u.active !== false && String(u.name || '').trim());
  if (!active.length || !text) return [];
  const byName = new Map(active.map((u) => [u.name.toLowerCase(), u.id]));
  const ids = [...String(text).matchAll(mentionRegex(active))].map((m) => byName.get(m[2].toLowerCase())).filter(Boolean);
  return [...new Set(ids)];
}
