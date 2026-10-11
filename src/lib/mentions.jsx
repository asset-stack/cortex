// @mention helpers for team chat. Mentions are plain text "@Name" matched against team members.
import { Fragment } from 'react';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// '@' only counts at the start or after whitespace/punctuation, so URLs and emails don't match.
// A capture group rather than a lookbehind keeps older Safari working.
const LEAD = '(^|[^\\w@./:-])';

export function mentionRegex(users) {
  const names = users.map((u) => escape(u.name)).sort((a, b) => b.length - a.length);
  return new RegExp(`${LEAD}@(${names.join('|')}|here)\\b`, 'gi');
}

export function mentionsUser(text, user) {
  const re = new RegExp(`${LEAD}@(${escape(user.name)}|here)\\b`, 'i');
  return re.test(text);
}

export function MessageText({ text, users, me }) {
  const re = mentionRegex(users);
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    if (start > last) parts.push(text.slice(last, start));
    const isMe = m[2].toLowerCase() === 'here' || m[2].toLowerCase() === me.name.toLowerCase();
    parts.push(<span key={start} className={isMe ? 'mention mention-me' : 'mention'}>@{m[2]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}
