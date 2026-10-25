// @mention helpers for team chat and task updates: the text helpers (src/lib/mentionText.js) and MessageText.
import { Fragment } from 'react';
import { mentionRegex } from './mentionText.js';

export { mentionRegex, mentionsUser, mentionedUserIds } from './mentionText.js';

export function MessageText({ text, users, me }) {
  const re = mentionRegex(users);
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    if (start > last) parts.push(text.slice(last, start));
    const isMe = m[2].toLowerCase() === 'here' || m[2].toLowerCase() === String(me?.name || '').toLowerCase();
    parts.push(<span key={start} className={isMe ? 'mention mention-me' : 'mention'}>@{m[2]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}
