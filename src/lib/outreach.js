// Outreach (docs/PHASE2.md §12): the cold email a Claude agent sends from each outreach mailbox, as logged in its Google
// Sheet and read into outreach_emails by the google function's outreach-sync route. Pure helpers shared by the store
// (demo mode computes with them; live mode gets the same numbers from outreach_daily() / outreach_breakdown()), the
// Outreach page and the tests. Relative imports only, so scripts/test-sync.mjs can load this file in Node.

const str = (v) => String(v ?? '').trim();
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}/.test(str(v)) ? str(v).slice(0, 10) : '');
const inRange = (day, from, to) => Boolean(day) && day >= from && day <= to;

// A database row (snake_case, from a select or realtime) → the app's shape. `mailbox` is '' for rows whose sender
// matches no mailbox (Unassigned).
export function emailFromRow(r = {}) {
  return {
    id: str(r.id), mailbox: str(r.mailbox_id), sender: str(r.sender), dateLogged: ymd(r.date_logged), vertical: str(r.vertical),
    organisation: str(r.organisation), domain: str(r.domain), location: str(r.location), contactName: str(r.contact_name),
    contactRole: str(r.contact_role), contactEmail: str(r.contact_email), tier: str(r.tier), signal: str(r.signal),
    subject: str(r.subject), variant: str(r.variant), status: str(r.status), sentOn: ymd(r.sent_on), messageId: str(r.message_id),
    threadId: str(r.thread_id), sequenceStatus: str(r.sequence_status), followupStage: Number(r.followup_stage) || 0,
    nextFollowup: ymd(r.next_followup), bounced: Boolean(r.bounced), replyStatus: str(r.reply_status), replyOn: ymd(r.reply_on),
    replySummary: str(r.reply_summary), note: str(r.note), meetingOn: ymd(r.meeting_on), inSheet: r.in_sheet !== false,
  };
}

/**
 * Per day and mailbox between `from` and `to` (YYYY-MM-DD, inclusive): emails sent (by sent day, and how many of
 * those bounced), replies (by reply day) and meetings booked (by meeting day). Same rules as outreach_daily() in 0007.
 * → [{ day, mailbox, sent, replies, bounces, meetings }] sorted by day, then mailbox.
 */
export function outreachDaily(rows, from, to) {
  const out = new Map();
  const at = (day, mailbox) => {
    const k = `${day}|${mailbox}`;
    if (!out.has(k)) out.set(k, { day, mailbox, sent: 0, replies: 0, bounces: 0, meetings: 0 });
    return out.get(k);
  };
  (rows || []).forEach((e) => {
    if (inRange(e.sentOn, from, to)) { const x = at(e.sentOn, e.mailbox); x.sent++; if (e.bounced) x.bounces++; }
    if (inRange(e.replyOn, from, to) && e.replyStatus) at(e.replyOn, e.mailbox).replies++;
    if (inRange(e.meetingOn, from, to)) at(e.meetingOn, e.mailbox).meetings++;
  });
  return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.mailbox < b.mailbox ? -1 : a.mailbox > b.mailbox ? 1 : 0));
}

/**
 * Prospects logged between `from` and `to` by mailbox and status (sent, draft-saved, skipped-…), and replies in the
 * period by kind (negative, referral, …). Same rules as outreach_breakdown() in 0007.
 * → [{ mailbox, kind: 'status' | 'reply', value, n }]
 */
export function outreachBreakdown(rows, from, to) {
  const out = new Map();
  const add = (mailbox, kind, value) => {
    const k = `${mailbox}|${kind}|${value}`;
    if (!out.has(k)) out.set(k, { mailbox, kind, value, n: 0 });
    out.get(k).n++;
  };
  (rows || []).forEach((e) => {
    if (inRange(e.dateLogged, from, to)) add(e.mailbox, 'status', e.status);
    if (inRange(e.replyOn, from, to) && e.replyStatus) add(e.mailbox, 'reply', e.replyStatus);
  });
  return [...out.values()];
}

/** Totals of outreachDaily() rows, for one mailbox ('' = Unassigned) or all (null). Reply rate = replies ÷ sent. */
export function outreachTotals(daily, mailbox = null) {
  const t = { sent: 0, replies: 0, bounces: 0, meetings: 0 };
  (daily || []).filter((d) => mailbox === null || d.mailbox === mailbox).forEach((d) => {
    t.sent += d.sent; t.replies += d.replies; t.bounces += d.bounces; t.meetings += d.meetings;
  });
  return { ...t, replyRate: t.sent ? t.replies / t.sent : 0, bounceRate: t.sent ? t.bounces / t.sent : 0 };
}

/**
 * The emails list: rows for one mailbox (or all), in the period, newest first. `only`: 'sent' (sent in the period),
 * 'replies' (replied in the period) or 'logged' (logged in the period, whatever happened). `search` matches
 * organisation, contact, role, email, subject and sender. → { rows, more }
 */
export function filterEmails(rows, { mailbox = null, from, to, search = '', only = 'sent', limit = 50, offset = 0 } = {}) {
  const q = str(search).toLowerCase();
  const day = (e) => (only === 'replies' ? e.replyOn : only === 'logged' ? e.dateLogged : e.sentOn);
  const list = (rows || [])
    .filter((e) => (mailbox === null || e.mailbox === mailbox) && inRange(day(e), from, to) && (only !== 'replies' || e.replyStatus))
    .filter((e) => !q || [e.organisation, e.contactName, e.contactRole, e.contactEmail, e.subject, e.sender]
      .some((v) => v.toLowerCase().includes(q)))
    .sort((a, b) => (day(a) < day(b) ? 1 : day(a) > day(b) ? -1 : a.id < b.id ? -1 : 1));
  return { rows: list.slice(offset, offset + limit), more: list.length > offset + limit };
}

/** `days` days ending today: { from, to } as YYYY-MM-DD (today in the browser's time zone). */
export function periodRange(days, today) {
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end.getTime() - (Math.max(1, days) - 1) * 86400e3);
  return { from: start.toISOString().slice(0, 10), to: today };
}

/** Every day from `from` to `to`, inclusive (for the chart's x axis, so quiet days show as zero). */
export function daysBetween(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86400e3)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** "a@x.com, b@y.com" (commas, spaces, semicolons or new lines) → distinct, lower-case, valid addresses. */
export function parseAddresses(text) {
  const list = (Array.isArray(text) ? text : String(text ?? '').split(/[\s,;]+/)).map((x) => str(x).toLowerCase()).filter(Boolean);
  return [...new Set(list)].filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
}

/** The mailbox a sender address belongs to ('' when none lists it). */
export function mailboxFor(mailboxes, sender) {
  const s = str(sender).toLowerCase();
  return (s && (mailboxes || []).find((m) => (m.addresses || []).includes(s))?.id) || '';
}

/** The Gmail thread in the sending mailbox (opens for whoever is signed in to that mailbox in the browser). */
export function gmailThreadUrl(sender, threadId) {
  if (!str(threadId)) return '';
  const who = str(sender) ? encodeURIComponent(str(sender)) : '0';
  return `https://mail.google.com/mail/u/${who}/#all/${encodeURIComponent(str(threadId))}`;
}

/** The Google Sheet's id and tab (gid) from its link; '' when it isn't a Sheets link. */
export function sheetFromUrl(url) {
  const m = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(str(url));
  if (!m) return { id: '', gid: '' };
  const gid = /[#&?]gid=(\d+)/.exec(str(url));
  return { id: m[1], gid: gid ? gid[1] : '' };
}
