// Outreach (docs/PHASE2.md §12): the cold email a Claude agent sends from each outreach mailbox, as logged in its Google
// Sheet and read into outreach_emails by the google function's outreach-sync route. Pure helpers shared by the store
// (demo mode computes with them; live mode gets the same numbers from outreach_daily() / outreach_breakdown()), the
// Outreach page and the tests. Relative imports only, so scripts/test-sync.mjs can load this file in Node.

const str = (v) => String(v ?? '').trim();
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}/.test(str(v)) ? str(v).slice(0, 10) : '');
const inRange = (day, from, to) => Boolean(day) && day >= from && day <= to;
const earlier = (a, b) => Boolean(a) && (!b || a < b);

// A database row (snake_case, from a select or realtime) → the app's shape. `mailbox` is '' for rows whose sender
// matches no mailbox (Unassigned). One row per contact: an email sent to two people is two rows with one messageId.
export function emailFromRow(r = {}) {
  return {
    id: str(r.id), rowKey: str(r.row_key), mailbox: str(r.mailbox_id), sender: str(r.sender), dateLogged: ymd(r.date_logged), vertical: str(r.vertical),
    organisation: str(r.organisation), domain: str(r.domain), location: str(r.location), contactName: str(r.contact_name),
    contactRole: str(r.contact_role), contactEmail: str(r.contact_email), tier: str(r.tier), signal: str(r.signal),
    subject: str(r.subject), variant: str(r.variant), status: str(r.status), sentOn: ymd(r.sent_on), messageId: str(r.message_id),
    threadId: str(r.thread_id), sequenceStatus: str(r.sequence_status), followupStage: Number(r.followup_stage) || 0,
    nextFollowup: ymd(r.next_followup), bounced: Boolean(r.bounced), replyStatus: str(r.reply_status), replyOn: ymd(r.reply_on),
    replySummary: str(r.reply_summary), note: str(r.note), meetingOn: ymd(r.meeting_on), inSheet: r.in_sheet !== false,
  };
}

/** The email a row belongs to: its Gmail message (shared by everyone it went to), else the row itself. */
export function emailKey(e) {
  return e.messageId || e.rowKey || e.id;
}

// Rows still in the sheet, one entry per email and mailbox: its first sent day, whether any of its addresses bounced,
// its first reply (day and kind, from rows with a reply status) and its first meeting. Same rules as 0007's.
function byEmail(rows) {
  const out = new Map();
  (rows || []).filter((e) => e.inSheet !== false).forEach((e) => {
    const k = `${emailKey(e)}|${e.mailbox}`;
    if (!out.has(k)) out.set(k, { mailbox: e.mailbox, sentOn: '', bounced: false, replyOn: '', replyStatus: '', meetingOn: '' });
    const g = out.get(k);
    if (earlier(e.sentOn, g.sentOn)) g.sentOn = e.sentOn;
    if (e.bounced) g.bounced = true;
    if (e.replyStatus && e.replyOn && (earlier(e.replyOn, g.replyOn) || (e.replyOn === g.replyOn && e.replyStatus < g.replyStatus))) {
      g.replyOn = e.replyOn; g.replyStatus = e.replyStatus;
    }
    if (earlier(e.meetingOn, g.meetingOn)) g.meetingOn = e.meetingOn;
  });
  return [...out.values()];
}

/**
 * Per day and mailbox between `from` and `to` (YYYY-MM-DD, inclusive): emails sent (on their sent day, with how many
 * of those bounced), replied to (on the first reply's day) and meetings booked (on the meeting day). Counts emails, not
 * people: an email to two contacts counts once. Rows no longer in the sheet don't count. Same rules as outreach_daily()
 * in 0007 and the sheet's Summary tab. → [{ day, mailbox, sent, replies, bounces, meetings }] sorted by day, then mailbox
 * (Unassigned last).
 */
export function outreachDaily(rows, from, to) {
  const out = new Map();
  const at = (day, mailbox) => {
    const k = `${day}|${mailbox}`;
    if (!out.has(k)) out.set(k, { day, mailbox, sent: 0, replies: 0, bounces: 0, meetings: 0 });
    return out.get(k);
  };
  byEmail(rows).forEach((g) => {
    if (inRange(g.sentOn, from, to)) { const x = at(g.sentOn, g.mailbox); x.sent++; if (g.bounced) x.bounces++; }
    if (inRange(g.replyOn, from, to)) at(g.replyOn, g.mailbox).replies++;
    if (inRange(g.meetingOn, from, to)) at(g.meetingOn, g.mailbox).meetings++;
  });
  const box = (m) => m || '\uffff'; // Unassigned last in a day, as the database orders a null mailbox
  return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : box(a.mailbox) < box(b.mailbox) ? -1 : box(a.mailbox) > box(b.mailbox) ? 1 : 0));
}

/**
 * Contacts logged between `from` and `to` by mailbox and status (sent, draft-saved, skipped-…), and emails first
 * replied to in the period by kind (negative, referral, …). Same rules as outreach_breakdown() in 0007.
 * → [{ mailbox, kind: 'status' | 'reply', value, n }]
 */
export function outreachBreakdown(rows, from, to) {
  const out = new Map();
  const add = (mailbox, kind, value) => {
    const k = `${mailbox}|${kind}|${value}`;
    if (!out.has(k)) out.set(k, { mailbox, kind, value, n: 0 });
    out.get(k).n++;
  };
  (rows || []).filter((e) => e.inSheet !== false).forEach((e) => {
    if (inRange(e.dateLogged, from, to)) add(e.mailbox, 'status', e.status);
  });
  byEmail(rows).forEach((g) => {
    if (inRange(g.replyOn, from, to)) add(g.mailbox, 'reply', g.replyStatus);
  });
  return [...out.values()];
}

/**
 * Totals of daily rows (outreachDaily(), or mergeDaily() with Gmail's), for one mailbox ('' = Unassigned) or all (null).
 * `started` is prospects emailed (Gmail threads started; a sheet row's emails otherwise). Reply rate = replies ÷ started,
 * bounce rate = bounces ÷ started.
 */
export function outreachTotals(daily, mailbox = null) {
  const t = { sent: 0, started: 0, replies: 0, autos: 0, bounces: 0, meetings: 0 };
  (daily || []).filter((d) => mailbox === null || d.mailbox === mailbox).forEach((d) => {
    t.sent += d.sent; t.started += d.started ?? d.sent; t.replies += d.replies; t.autos += d.autos || 0; t.bounces += d.bounces;
    t.meetings += d.meetings || 0;
  });
  return { ...t, replyRate: t.started ? t.replies / t.started : 0, bounceRate: t.started ? t.bounces / t.started : 0 };
}

// ── Gmail (0010, docs/PHASE2.md §16): cold emails read from each connected mailbox ─────────────────────────────────
// A cold thread is one we started with a new outside contact (the google function's outreach-gmail-sync decides, once).
// Its messages are ours ('sent': the first email and each follow-up) and the prospect's answer ('reply', 'auto' for an
// auto-reply or out-of-office, 'bounce'). Days are Sydney days, worked out by the database (outreach_gmail_save).

const num = (v) => Number(v) || 0;

// A thread row (snake_case, from outreach_gmail_threads() or the demo seed) → the app's shape. The sheet's details
// (organisation, role, tier, the agent's reply status) come along when a sheet row matches.
export function threadFromRow(r = {}) {
  return {
    id: str(r.id), mailbox: str(r.mailbox_id), threadId: str(r.thread_id), sender: str(r.sender), prospectEmail: str(r.prospect_email),
    prospectName: str(r.prospect_name), recipients: num(r.recipients) || 1, subject: str(r.subject), firstAt: str(r.first_at),
    firstDay: ymd(r.first_day), lastSentAt: str(r.last_sent_at), sentCount: num(r.sent_count) || 1, replyAt: str(r.reply_at),
    replyDay: ymd(r.reply_day), autoAt: str(r.auto_at), autoDay: ymd(r.auto_day), bounceAt: str(r.bounce_at), bounceDay: ymd(r.bounce_day),
    replyKind: str(r.reply_kind), organisation: str(r.organisation), contactRole: str(r.contact_role), tier: str(r.tier),
    sheetReplyStatus: str(r.sheet_reply_status),
  };
}

/** What became of a cold thread: bounced, else replied, else an auto-reply, else waiting (same order as the database). */
export function gmailOutcome(t) {
  if (t.bounceAt || t.bounceDay) return 'bounced';
  if (t.replyAt || t.replyDay) return 'replied';
  if (t.autoAt || t.autoDay) return 'auto';
  return 'waiting';
}

/**
 * Per day and mailbox between `from` and `to` (inclusive): our cold emails sent (each first email and follow-up, on its
 * Sydney day), prospects emailed (threads started), and threads first replied to, auto-replied to and bounced, on those
 * days. Same rules as outreach_gmail_daily() in 0010. `threads` / `messages` in the app's shape (threadFromRow, and
 * { mailbox, messageId, threadId, kind, day }). → [{ day, mailbox, sent, started, replies, autos, bounces }] by day, then
 * mailbox.
 */
export function gmailDaily(threads, messages, from, to) {
  const out = new Map();
  const at = (day, mailbox) => {
    const k = `${day}|${mailbox}`;
    if (!out.has(k)) out.set(k, { day, mailbox, sent: 0, started: 0, replies: 0, autos: 0, bounces: 0 });
    return out.get(k);
  };
  (messages || []).forEach((m) => { if (m.kind === 'sent' && inRange(m.day, from, to)) at(m.day, m.mailbox).sent++; });
  (threads || []).forEach((t) => {
    if (inRange(t.firstDay, from, to)) at(t.firstDay, t.mailbox).started++;
    if (inRange(t.replyDay, from, to)) at(t.replyDay, t.mailbox).replies++;
    if (inRange(t.autoDay, from, to)) at(t.autoDay, t.mailbox).autos++;
    if (inRange(t.bounceDay, from, to)) at(t.bounceDay, t.mailbox).bounces++;
  });
  return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.mailbox < b.mailbox ? -1 : a.mailbox > b.mailbox ? 1 : 0));
}

/**
 * Threads started between `from` and `to`, by mailbox: what became of them (kind 'outcome': bounced, replied, auto,
 * waiting) and how many emails we sent in each (kind 'followups': '1', '2', '3', '4+'). Same rules as
 * outreach_gmail_breakdown() in 0010. → [{ mailbox, kind, value, n }]
 */
export function gmailBreakdown(threads, from, to) {
  const out = new Map();
  const add = (mailbox, kind, value) => {
    const k = `${mailbox}|${kind}|${value}`;
    if (!out.has(k)) out.set(k, { mailbox, kind, value, n: 0 });
    out.get(k).n++;
  };
  (threads || []).filter((t) => inRange(t.firstDay, from, to)).forEach((t) => {
    add(t.mailbox, 'outcome', gmailOutcome(t));
    add(t.mailbox, 'followups', t.sentCount >= 4 ? '4+' : String(Math.max(1, t.sentCount)));
  });
  return [...out.values()];
}

// The sheet row that tells us more about a thread: one with its Gmail thread id, else the newest for the prospect's
// address (latest sent, then logged, then id). Same order as outreach_gmail_threads().
function sheetRowFor(t, sheetRows) {
  const later = (a, b) => (a > b ? -1 : a < b ? 1 : 0);
  return (sheetRows || []).filter((e) => e.inSheet !== false
    && ((t.threadId && e.threadId === t.threadId) || (t.prospectEmail && e.contactEmail.toLowerCase() === t.prospectEmail)))
    .sort((a, b) => (b.threadId === t.threadId) - (a.threadId === t.threadId) || later(a.sentOn, b.sentOn)
      || later(a.dateLogged, b.dateLogged) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] || null;
}

/** A thread with the sheet's details for it (organisation, role, tier, the agent's reply status), when a row matches. */
export function withSheet(t, sheetRows) {
  const e = sheetRowFor(t, sheetRows);
  return e ? { ...t, organisation: e.organisation, contactRole: e.contactRole, tier: e.tier, sheetReplyStatus: e.replyStatus } : t;
}

/**
 * The cold threads list, for one mailbox (or all), newest first. `only`: 'sent' (started in the period), 'replies'
 * (first replied to in the period) or 'bounced' (bounced in the period). `search` matches the prospect's address and
 * name, the subject and the organisation (from the sheet). Same rules as outreach_gmail_threads() in 0010.
 * → { rows, more }
 */
export function filterThreads(threads, sheetRows, { mailbox = null, from, to, search = '', only = 'sent', limit = 50, offset = 0 } = {}) {
  const q = str(search).toLowerCase();
  const day = (t) => (only === 'replies' ? t.replyDay : only === 'bounced' ? t.bounceDay : t.firstDay);
  const list = (threads || [])
    .filter((t) => (mailbox === null || t.mailbox === mailbox) && inRange(day(t), from, to))
    .map((t) => withSheet(t, sheetRows))
    .filter((t) => !q || [t.prospectEmail, t.prospectName, t.subject, t.organisation].some((v) => str(v).toLowerCase().includes(q)))
    .sort((a, b) => (day(a) < day(b) ? 1 : day(a) > day(b) ? -1 : a.firstAt < b.firstAt ? 1 : a.firstAt > b.firstAt ? -1 : a.id < b.id ? -1 : 1));
  return { rows: list.slice(offset, offset + limit), more: list.length > offset + limit };
}

/**
 * The dashboard's daily rows: a mailbox whose Gmail has been read (`gmailBoxes`: a Set of mailbox ids) counts sent,
 * prospects, replies, auto-replies and bounces from Gmail and only meetings from the sheet; every other mailbox (and
 * Unassigned) counts everything from the sheet, each email a prospect. → [{ day, mailbox, sent, started, replies, autos,
 * bounces, meetings }] by day, then mailbox (Unassigned last).
 */
export function mergeDaily(sheetDaily, gmailRows, gmailBoxes = new Set()) {
  const out = new Map();
  const at = (day, mailbox) => {
    const k = `${day}|${mailbox}`;
    if (!out.has(k)) out.set(k, { day, mailbox, sent: 0, started: 0, replies: 0, autos: 0, bounces: 0, meetings: 0 });
    return out.get(k);
  };
  (sheetDaily || []).forEach((d) => {
    const x = at(d.day, d.mailbox);
    x.meetings += d.meetings;
    if (gmailBoxes.has(d.mailbox)) return;
    x.sent += d.sent; x.started += d.sent; x.replies += d.replies; x.bounces += d.bounces;
  });
  (gmailRows || []).filter((g) => gmailBoxes.has(g.mailbox)).forEach((g) => {
    const x = at(g.day, g.mailbox);
    x.sent += g.sent; x.started += g.started; x.replies += g.replies; x.autos += g.autos; x.bounces += g.bounces;
  });
  const box = (m) => m || '\uffff';
  return [...out.values()].filter((x) => x.sent || x.started || x.replies || x.autos || x.bounces || x.meetings)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : box(a.mailbox) < box(b.mailbox) ? -1 : box(a.mailbox) > box(b.mailbox) ? 1 : 0));
}

/**
 * The emails list, one row per contact still in the sheet: for one mailbox (or all), in the period, newest first.
 * `only`: 'sent' (sent in the period), 'replies' (replied in the period) or 'logged' (logged in the period, whatever
 * happened). `search` matches organisation, contact, role, email, subject and sender. → { rows, more }
 */
export function filterEmails(rows, { mailbox = null, from, to, search = '', only = 'sent', limit = 50, offset = 0 } = {}) {
  const q = str(search).toLowerCase();
  const day = (e) => (only === 'replies' ? e.replyOn : only === 'logged' ? e.dateLogged : e.sentOn);
  const list = (rows || [])
    .filter((e) => e.inSheet !== false && (mailbox === null || e.mailbox === mailbox) && inRange(day(e), from, to)
      && (only !== 'replies' || e.replyStatus))
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

/** "a@example.com, b@example.com" (commas, spaces, semicolons or new lines) → distinct, lower-case, valid addresses. */
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
