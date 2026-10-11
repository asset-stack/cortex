// @mention helpers for team chat. Mentions are plain text "@Name" matched against team members.
import { Fragment } from 'react';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function mentionRegex(users) {
  const names = users.map((u) => escape(u.name)).sort((a, b) => b.length - a.length);
  return new RegExp(`@(${names.join('|')}|here)\\b`, 'gi');
}

export function mentionsUser(text, user) {
  const re = new RegExp(`@(${escape(user.name)}|here)\\b`, 'i');
  return re.test(text);
}

export function MessageText({ text, users, me }) {
  const re = mentionRegex(users);
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const isMe = m[1].toLowerCase() === 'here' || m[1].toLowerCase() === me.name.toLowerCase();
    parts.push(<span key={m.index} className={isMe ? 'mention mention-me' : 'mention'}>@{m[1]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}
