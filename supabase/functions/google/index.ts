// @ts-nocheck
// Cortex `google` Edge Function: Gmail, Drive and Docs as the calling admin's OWN Google account, each staff member's
// own Google Calendar (read only) for the Calendar page, and each outreach mailbox's Gmail (read only, headers of cold
// threads only) for Outreach.
// One self-contained file with no imports, so it can be pasted into the Supabase dashboard editor (Edge Functions →
// google); plain JavaScript in a .ts file, so scripts/test-google.mjs imports it in Node. Web APIs only.
//
// Routes (on the last path segment, so /google/send and /functions/v1/google/send both work):
//   POST connect  {origin, purpose?, mailbox?}           → {url}: Google's consent page (comes back to callback).
//                                                          purpose 'calendar': any staff member, calendar.readonly only;
//                                                          purpose 'mailbox' (admins only): that outreach mailbox's own
//                                                          @assetstackai.com account, gmail.readonly only;
//                                                          otherwise admins only, Gmail and Drive
//   GET  callback ?code&state                            → 302 to <origin>/#/settings?tab=business&google=…, or for a
//                                                          calendar connect <origin>/#/calendar?google=… (and only a
//                                                          calendar connect turns sharing on: rpc calendar_share), or
//                                                          for a mailbox <origin>/#/settings?tab=outreach&gmail=…&mailbox=…
//                                                          (rpc outreach_gmail_connect; never google_save)
//   POST send     {to, subject, text, attachment?}       → {id, from}: sent from the caller's own Gmail
//   POST contract {template, folder, name, replacements} → {id, name, url}: the template copied into the folder, filled in
//   POST outreach-sync {}                                → {ok, stats}: the outreach agent's sheet into outreach_emails,
//                                                          then its Summary, Notes and mailbox tabs written back
//                                                          (docs/PHASE2.md §12)
//   POST calendar-sync {force?}                          → {ok, claimed, synced, failed}: the staff sharing their
//                                                          calendar whose turn it is (rpc calendar_claim), each one's
//                                                          primary calendar into
//                                                          calendar_meetings (rpc calendar_save); titles only, never
//                                                          descriptions, places, attendees or links
//   POST outreach-gmail-sync {force?, since?}            → {ok, claimed, synced, failed, more, pending, since}: the
//                                                          connected outreach mailboxes whose turn it is (rpc
//                                                          outreach_gmail_claim), each one's cold threads (ones we started
//                                                          with a new outside contact) into outreach_threads /
//                                                          outreach_messages (rpc outreach_gmail_save): headers only, never
//                                                          a body or snippet; more = call again (a claim was released, or
//                                                          the claim was full so others may be due); since = when the
//                                                          chain started (pass it back on the chain's later calls)
//   POST task-mail {}                                    → {ok, sent, failed}: the task emails due (rpc task_mail_claim:
//                                                          a task handed to its owner, an update posted on it; 0013),
//                                                          one per person, from the Gmail of the admin chosen in
//                                                          Settings → Business; results through rpc task_mail_done
//
// JWT verification is OFF for this function (Google's callback carries no JWT), so it checks callers itself: the
// caller's JWT goes to rpc google_me (active staff only; send, contract, a plain and a mailbox connect then need admin;
// task-mail takes any of them, since it sends only what the database queued and claims with the secret key),
// or rpc outreach_access for outreach-sync and outreach-gmail-sync (anyone who can see Outreach; the sheet is read with
// the Google account of the admin who set its link, each mailbox with its own), and PostgREST decides who that is.
// Refresh tokens are read and saved with the secret key (rpc google_token / google_save / outreach_gmail_connect /
// outreach_gmail_job), which exists only in the function runtime; so are the outreach tables the syncs write and the
// calendar RPCs (calendar_share / calendar_claim / calendar_save).
//
// Env (Supabase injects the first three): SUPABASE_URL; SUPABASE_PUBLISHABLE_KEYS (JSON, .default) or
// SUPABASE_ANON_KEY; SUPABASE_SECRET_KEYS (JSON, .default) or SUPABASE_SERVICE_ROLE_KEY; function secrets
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET; optional CORTEX_ORIGINS (comma list, replaces DEFAULT_ORIGINS).
// Never log or return a Google token.

export const DEFAULT_ORIGINS = [
  'https://cortex.assetstackai.com',
  'https://cortex-1xk.pages.dev',
  'http://localhost:5173',
  'http://localhost:4322',
];

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'; // the drive scope covers the Sheets API
export const SCOPES = 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive';
export const CALENDAR_SCOPES = 'openid email https://www.googleapis.com/auth/calendar.readonly'; // a calendar connect
// Either one lets the sync read events (has_calendar() in 0009): whole entries of the space-separated scope list. A
// scope alone never shares a calendar: sharing is google_accounts.calendar, set only by a calendar connect's callback
// (rpc calendar_share).
const CALENDAR_SCOPE_ENTRIES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'];
const CALENDAR_API = 'https://www.googleapis.com/calendar/';
const CALENDAR_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DOMAIN = 'assetstackai.com';
const STATE_TTL = 600; // seconds to finish Google's consent screen
const MIME_DOC = 'application/vnd.google-apps.document';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const MAX_RECIPIENTS = 10;
const MAX_SUBJECT = 200;
const MAX_TEXT = 20000;
const MAX_PDF = 2 * 1024 * 1024;
const MAX_BODY = 4 * 1024 * 1024; // the request itself: a 2 MB PDF is ~2.8 MB of base64
const MAX_REPLACEMENTS = 100;

const SYNC_BATCH = 500; // outreach_emails rows per upsert
const MAX_CELL = 50000; // Google Sheets' limit per cell

const ROUTES = {
  connect: 'POST', callback: 'GET', send: 'POST', contract: 'POST', 'outreach-sync': 'POST', 'calendar-sync': 'POST', 'outreach-gmail-sync': 'POST',
  'task-mail': 'POST',
};
const EXPIRED = 'This sign-in link has expired. Go back to Cortex and try again.';
const NOT_CONNECTED = 'Connect your Google account in Settings first.';
const RECONNECT = 'Reconnect your Google account in Settings.';
const NOT_FOUND = 'Template or folder not found, or not shared with your Google account.';
const NO_OUTREACH = 'You don’t have access to Outreach.';
const NO_SHEET = 'Add the outreach sheet in Settings → Outreach.';
const NO_SHEET_BY = 'Ask an admin to click Use my Google in Settings → Outreach.';
const NO_GID = 'Paste the link of the agent’s tab in Settings → Outreach (open the tab, then copy the address: it ends in #gid=…).';
const GID_GONE = 'The tab in the outreach sheet link isn’t in the sheet any more. Paste the agent’s tab link in Settings → Outreach.';
const gidOurs = (title) => `The outreach sheet link opens Cortex’s ${title} tab. Paste the agent’s tab link in Settings → Outreach.`;
const SYNC_FAILED = 'Something went wrong with Google. Try again.';
const NOT_ADMIN = 'Only admins can use Google from Cortex.';
const NO_GOOGLE = 'Your Cortex account can’t use Google.';

const str = (v) => String(v ?? '').trim();
const utf8 = (s) => new TextEncoder().encode(String(s));
const CONTROL = /[\x00-\x1f\x7f]/;
const LINE_BREAK = /[\r\n]/;
const ASCII = /^[\x20-\x7e]*$/;
const EMAIL = /^[^\s@,;<>"()\\]+@[^\s@,;<>"()\\]+\.[^\s@,;<>"()\\]+$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** An expected failure: becomes { error } with this status. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────────────────────

// SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS are JSON objects of named keys; malformed JSON counts as unset.
function namedKey(json) {
  try {
    const key = JSON.parse(json || '')?.default;
    return typeof key === 'string' ? key.trim() : '';
  } catch {
    return '';
  }
}

const normOrigin = (o) => str(o).replace(/\/+$/, '').toLowerCase();

export function config(env = {}) {
  const origins = str(env.CORTEX_ORIGINS).split(',').map(normOrigin).filter(Boolean);
  return {
    url: str(env.SUPABASE_URL).replace(/\/+$/, ''),
    publishableKey: namedKey(env.SUPABASE_PUBLISHABLE_KEYS) || str(env.SUPABASE_ANON_KEY),
    secretKey: namedKey(env.SUPABASE_SECRET_KEYS) || str(env.SUPABASE_SERVICE_ROLE_KEY),
    clientId: str(env.GOOGLE_CLIENT_ID),
    clientSecret: str(env.GOOGLE_CLIENT_SECRET),
    origins: origins.length ? origins : DEFAULT_ORIGINS,
  };
}

function missingSettings(cfg) {
  const need = {
    SUPABASE_URL: cfg.url, SUPABASE_PUBLISHABLE_KEYS: cfg.publishableKey, SUPABASE_SECRET_KEYS: cfg.secretKey,
    GOOGLE_CLIENT_ID: cfg.clientId, GOOGLE_CLIENT_SECRET: cfg.clientSecret,
  };
  return Object.keys(need).filter((k) => !need[k]);
}

/** The origin (lower case, no trailing slash) when it is one of Cortex's; otherwise ''. */
export function allowedOrigin(origin, origins = DEFAULT_ORIGINS) {
  const o = normOrigin(origin);
  return o && origins.map(normOrigin).includes(o) ? o : '';
}

// The apikey header always; Authorization only for a JWT-style (legacy) key. sb_publishable_ / sb_secret_ keys
// are not JWTs, and the gateway turns them into a role itself.
export function keyHeaders(key) {
  return { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) };
}

// ── Encoding ────────────────────────────────────────────────────────────────────────────────────────────────────

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return utf8(input);
}

// In chunks: String.fromCharCode on a whole PDF overflows the call stack.
export function toBase64(input) {
  const bytes = toBytes(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Throws on anything that isn't base64. */
export function fromBase64(s) {
  const bin = atob(String(s));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes or a string (as UTF-8) → base64url without padding. */
export function base64url(input) {
  return toBase64(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

const wrap76 = (b64) => (b64.match(/.{1,76}/g) || []).join('\r\n');

// base64url(JSON) → the object, or null.
function decodeJson(part) {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64url(part)));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A JWT's payload, unverified (only for an id_token that came straight from Google's token endpoint). */
export function jwtPayload(jwt) {
  const part = String(jwt ?? '').split('.')[1];
  return part ? decodeJson(part) : null;
}

// ── Signed state (the OAuth round trip) ─────────────────────────────────────────────────────────────────────────

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(data)));
}

/** Same length and same bytes, in time that doesn't depend on where they differ. */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** base64url(JSON payload) + '.' + base64url(HMAC-SHA256 of that, keyed with `secret`). */
export async function signState(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${base64url(await hmac(secret, body))}`;
}

/** The payload when the signature matches and it hasn't expired (exp in seconds); otherwise null. */
export async function verifyState(state, secret, now = Math.floor(Date.now() / 1000)) {
  const parts = String(state ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || !secret) return null;
  let given;
  try {
    given = fromBase64url(parts[1]);
  } catch {
    return null;
  }
  if (!timingSafeEqual(given, await hmac(secret, parts[0]))) return null;
  const p = decodeJson(parts[0]);
  if (!p || !(Number(p.exp) > now) || !str(p.uid) || !str(p.email) || !str(p.origin)) return null;
  return p;
}

// ── Email (MIME) ────────────────────────────────────────────────────────────────────────────────────────────────

// RFC 2047 B encoded-words of at most 39 UTF-8 bytes each (64 characters with the wrapper, so a line holding one
// stays within 76 even after "Subject: "), split between characters and folded onto continuation lines.
export function encodeWords(s) {
  const words = [];
  let chunk = '';
  for (const ch of String(s)) {
    if (chunk && utf8(chunk + ch).length > 39) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${toBase64(w)}?=`).join('\r\n ');
}

const headerText = (s) => (ASCII.test(s) ? s : encodeWords(s));

// "Name" <address>; a non-ASCII name as encoded-words (they can't go inside quotes), the address on its own line.
function mailbox(name, email) {
  const n = str(String(name ?? '').replace(/[\x00-\x1f\x7f]/g, ' '));
  if (!n) return email;
  return ASCII.test(n) ? `"${n.replace(/["\\]/g, '\\$&')}" <${email}>` : `${encodeWords(n)}\r\n <${email}>`;
}

function randomBoundary() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `cortex-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A multipart/mixed message with CRLF line endings: a UTF-8 text part and, optionally, one PDF
 *  ({ filename, bytes }). Every header value must already be validated (no CR/LF). */
export function buildMime({ fromName = '', fromEmail, to, subject, text = '', attachment = null, boundary = randomBoundary() }) {
  const recipients = to.join(', ');
  const lines = [
    `From: ${mailbox(fromName, fromEmail)}`,
    `To: ${recipients.length > 900 ? to.join(',\r\n ') : recipients}`, // folded only past the 998-character line limit
    `Subject: ${headerText(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(toBase64(String(text).replace(/\r\n|\r|\n/g, '\r\n'))),
  ];
  if (attachment) {
    lines.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(toBase64(attachment.bytes)),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

// { to, subject, text, attachment? } from the request → the same, checked and cleaned (attachment as bytes).
export function emailFromBody(body) {
  const list = body?.to;
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Add at least one email address.');
  if (list.length > MAX_RECIPIENTS) throw new HttpError(400, `Send to ${MAX_RECIPIENTS} addresses at most.`);
  const to = [];
  for (const x of list) {
    if (typeof x !== 'string' || CONTROL.test(x)) throw new HttpError(400, 'Check the email addresses.');
    const address = x.trim().toLowerCase();
    if (address.length > 254 || !ASCII.test(address) || !EMAIL.test(address)) {
      throw new HttpError(400, `Not a valid email address: ${address.slice(0, 100)}`);
    }
    if (!to.includes(address)) to.push(address);
  }

  if (typeof body.subject !== 'string') throw new HttpError(400, 'Add a subject.');
  if (LINE_BREAK.test(body.subject)) throw new HttpError(400, 'The subject can’t contain line breaks.');
  const subject = str(body.subject.replace(/[\x00-\x1f\x7f]/g, ' '));
  if (!subject) throw new HttpError(400, 'Add a subject.');
  if (subject.length > MAX_SUBJECT) throw new HttpError(400, `Keep the subject under ${MAX_SUBJECT} characters.`);

  const text = body.text ?? '';
  if (typeof text !== 'string') throw new HttpError(400, 'The message must be text.');
  if (text.length > MAX_TEXT) throw new HttpError(400, 'The message is too long.');

  const a = body.attachment;
  if (a == null) return { to, subject, text, attachment: null };
  if (typeof a !== 'object' || a.type !== 'application/pdf' || typeof a.content !== 'string') {
    throw new HttpError(400, 'The attachment must be a PDF.');
  }
  if (typeof a.filename !== 'string' || LINE_BREAK.test(a.filename)) throw new HttpError(400, 'Check the attachment’s name.');
  const filename = a.filename.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').replace(/^[. ]+/, '').trim();
  if (!/^.+\.pdf$/i.test(filename)) throw new HttpError(400, 'The attachment’s name must end in .pdf.');
  if (filename.length > 150) throw new HttpError(400, 'The attachment’s name is too long.');
  if (a.content.length > Math.ceil(MAX_PDF / 3) * 4 + 4) throw new HttpError(400, 'The attachment is too big (2 MB at most).');
  let bytes;
  try {
    bytes = fromBase64(a.content);
  } catch {
    throw new HttpError(400, 'The attachment must be a PDF.');
  }
  if (bytes.length > MAX_PDF) throw new HttpError(400, 'The attachment is too big (2 MB at most).');
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 4)) !== '%PDF') {
    throw new HttpError(400, 'The attachment must be a PDF.');
  }
  return { to, subject, text, attachment: { filename, bytes } };
}

// ── Drive ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A Drive file or folder ID from a bare ID or a Docs / Drive link; '' when there isn't one. */
export function driveId(input) {
  const s = str(input);
  if (DRIVE_ID.test(s)) return s;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' || !/(^|\.)google\.com$/i.test(u.hostname)) return '';
  const m = u.pathname.match(/\/(?:document|file)\/(?:u\/\d+\/)?d\/([^/]+)/) || u.pathname.match(/\/folders\/([^/]+)/);
  const id = m ? m[1] : u.searchParams.get('id') || '';
  return DRIVE_ID.test(id) ? id : '';
}

/** One replaceAllText per placeholder: {{Key}} (any case) → the value. */
export function replaceRequests(replacements) {
  return Object.entries(replacements || {})
    .filter(([key]) => str(key))
    .map(([key, value]) => ({
      replaceAllText: { containsText: { text: `{{${key}}}`, matchCase: false }, replaceText: String(value ?? '') },
    }));
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  };
}

function json(status, body, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin), ...extra },
  });
}

// Supabase serves GET responses from functions as text/plain anyway, so the callback's one page is plain text.
const page = (status, text) => new Response(text, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
});

const redirect = (location) => new Response(null, {
  status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
});

async function readJson(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function readBody(req) {
  if (Number(req.headers.get('content-length')) > MAX_BODY) throw new HttpError(413, 'The attachment is too big (2 MB at most).');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'The attachment is too big (2 MB at most).');
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Invalid request.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
  return body;
}

const googleMessage = (data) => str(data?.error?.message || data?.error_description || (typeof data?.error === 'string' ? data.error : ''));
// The reasons in a Google API error (error.details[].reason and error.errors[].reason).
const googleReasons = (data) => (data?.error?.details || []).map((d) => d?.reason).concat((data?.error?.errors || []).map((e) => e?.reason));
// A 403 that means the token lacks the scope the call needs.
const scopeInsufficient = (status, data, reasons) => status === 403 && (reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')
  || reasons.includes('insufficientPermissions') || /insufficient authentication scopes/i.test(googleMessage(data)));

// A missing scope → what to reconnect and allow: the calendar (on the Calendar page) or Gmail and Drive (in Settings).
const scopeMissing = (url) => (String(url).startsWith(CALENDAR_API)
  ? 'Reconnect Google on the Calendar page and allow Google Calendar.'
  : 'Reconnect your Google account in Settings and allow Gmail and Drive.');

// A Google API call → its JSON, or an HttpError: missing scope → 409 (reconnect), 404 → `notFound` and any other 403
// (not shared; but not an API that is turned off) → `forbidden` when given, anything else → 502 with Google's message.
async function google(fetch, url, init, notFound = '', forbidden = '') {
  const res = await fetch(url, init);
  const data = await readJson(res);
  if (res.ok) return data || {};
  const msg = googleMessage(data);
  const reasons = googleReasons(data);
  if (scopeInsufficient(res.status, data, reasons)) throw new HttpError(409, scopeMissing(url));
  if (res.status === 404 && notFound) throw new HttpError(404, notFound);
  if (res.status === 403 && forbidden && !reasons.includes('SERVICE_DISABLED') && !reasons.includes('accessNotConfigured')) {
    throw new HttpError(403, forbidden);
  }
  throw new HttpError(502, msg || `Google returned ${res.status}.`);
}

// ── Who is calling ──────────────────────────────────────────────────────────────────────────────────────────────

// rpc `name` with the caller's own JWT, so PostgREST verifies it. → its JSON. A refusal (42501 / 403) → 403 `refused`.
async function callerRpc(req, cfg, fetch, name, refused) {
  const auth = str(req.headers.get('authorization'));
  if (!auth) throw new HttpError(401, 'Sign in to Cortex first.');
  const res = await fetch(`${cfg.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: cfg.publishableKey, Authorization: auth, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await readJson(res);
  if (!res.ok) {
    const code = str(data?.code);
    const jwtError = /jwt|jws/i.test(`${data?.message ?? ''} ${data?.msg ?? ''}`) || code.startsWith('PGRST3');
    if (res.status === 401 || (res.status === 403 && code !== '42501' && jwtError)) throw new HttpError(401, 'Sign in to Cortex again.');
    if (code === '42501' || res.status === 403) throw new HttpError(403, refused);
    throw new HttpError(502, 'Could not check your Cortex account.');
  }
  return data;
}

// Active staff, through rpc google_me (which refuses anyone else with 42501: it checks is_staff() itself).
// → { uid, name, email, admin, google_email, connected_at, calendar, business }
async function staffCaller(req, cfg, fetch) {
  const data = await callerRpc(req, cfg, fetch, 'google_me', NO_GOOGLE);
  if (!data || !str(data.uid)) throw new HttpError(403, NO_GOOGLE);
  return data;
}

function adminOnly(me) {
  if (me?.admin !== true) throw new HttpError(403, NOT_ADMIN);
  return me;
}

// Admins, through rpc google_me (send, contract and a plain connect).
const caller = async (req, cfg, fetch) => adminOnly(await staffCaller(req, cfg, fetch));

// Anyone who can see Outreach, through rpc outreach_access (can_view('outreach'): active staff with view or edit).
async function outreachCaller(req, cfg, fetch) {
  const data = await callerRpc(req, cfg, fetch, 'outreach_access', NO_OUTREACH);
  if (data?.view !== true) throw new HttpError(403, NO_OUTREACH);
  return data;
}

// A user's stored refresh token (the caller's, or for outreach-sync the admin who set the sheet, or for calendar-sync
// each claimed person) → a fresh access token. `text` rewords the failures for someone else's account; `needs`, when
// given, checks the stored scopes first (false → reconnect, without asking Google). → { token, email }
async function googleAccess(cfg, fetch, me, text = {}, needs = null) {
  const say = { unread: 'Could not read your Google connection.', notConnected: NOT_CONNECTED, reconnect: RECONNECT, ...text };
  const stored = await fetch(`${cfg.url}/rest/v1/rpc/google_token`, {
    method: 'POST',
    headers: { ...keyHeaders(cfg.secretKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_user: me.uid }),
  });
  if (!stored.ok) throw new HttpError(502, say.unread);
  const account = await readJson(stored);
  if (!str(account?.refresh_token)) throw new HttpError(409, say.notConnected);
  const email = str(account.email).toLowerCase();
  if (!EMAIL.test(email) || !ASCII.test(email)) throw new HttpError(409, say.reconnect);
  if (needs && !needs(account.scopes)) throw new HttpError(409, say.reconnect);
  const token = await refreshAccess(fetch, { id: cfg.clientId, secret: cfg.clientSecret }, account.refresh_token, say.reconnect);
  return { token, email };
}

// A refresh token → a fresh access token from the OAuth client that issued it (`client`: { id, secret }). Google's
// invalid_grant (revoked or expired) → 409 `reconnect`; any other failure → 502 with Google's short message. Never logs
// or returns the refresh token.
async function refreshAccess(fetch, client, refreshToken, reconnect) {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.id, client_secret: client.secret, refresh_token: refreshToken, grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await readJson(res);
  if (data?.error === 'invalid_grant') throw new HttpError(409, reconnect);
  if (!res.ok || !str(data?.access_token)) throw new HttpError(502, googleMessage(data) || 'Google sign-in failed.');
  return data.access_token;
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────────────────────

const callbackUrl = (cfg) => `${cfg.url}/functions/v1/google/callback`;

// purpose 'calendar' (any staff member): calendar.readonly only, back to the Calendar page. Anything else (admins only,
// checked by the caller): Gmail and Drive, back to Settings → Business. include_granted_scopes keeps what was granted
// before either way, so one refresh token carries both; that is why sharing is an explicit flag
// (google_accounts.calendar, 0009) that only a calendar connect's callback turns on, never the scopes a token carries.
async function connect(body, me, cfg) {
  const calendar = body.purpose === 'calendar';
  const origin = allowedOrigin(body.origin, cfg.origins);
  if (!origin) throw new HttpError(400, 'Open Cortex at its own address to connect Google.');
  const email = str(me.email).toLowerCase();
  if (!email) throw new HttpError(400, 'Your Cortex profile has no email.');
  const state = await signState({
    uid: me.uid, email, origin, exp: Math.floor(Date.now() / 1000) + STATE_TTL,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(16))), ...(calendar ? { purpose: 'calendar' } : {}),
  }, cfg.clientSecret);
  const query = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl(cfg),
    response_type: 'code',
    scope: calendar ? CALENDAR_SCOPES : SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    hd: DOMAIN,
    login_hint: email,
    state,
  });
  return { url: `${GOOGLE_AUTH}?${query}` };
}

// A calendar connect's failures, as the Calendar page reads them (#/calendar?google=…): the reasons it names, else
// error&reason=<step> (client, exchange, save or share), as Settings reads a plain connect's.
const CALENDAR_RESULTS = new Set(['denied', 'wrong_account', 'no_refresh_token', 'calendar_scope']);
// Google's token answer when the client ID and secret don't match (a GOOGLE_CLIENT_SECRET that isn't an enabled secret of
// that client): reason client, so an admin knows to check the setup rather than try again.
const CLIENT_ERRORS = new Set(['invalid_client', 'unauthorized_client']);

// One line in the function's logs (Supabase → Edge Functions → google → Logs) for a failed connect: the step, the HTTP
// status and Google's or PostgREST's short error. Never a code, token or secret: only those error fields are read.
function logFailure(step, status, data) {
  const detail = [data?.error, data?.error_description, data?.code, data?.message]
    .filter((x) => typeof x === 'string' && x).join(' · ').replace(/\s+/g, ' ').slice(0, 200);
  console.error('google callback:', step, status || '-', detail || '-');
}

// Google sends the browser here. Only a valid state says where Cortex is; anything else gets a plain page.
// google_save (0004) stores the token and scopes and never touches the calendar flag: a new connection starts not
// sharing and an existing one keeps what it had. A calendar connect then opts in with rpc calendar_share (secret key);
// any other connect never calls it, so a plain connect after a Calendar disconnect doesn't start sharing again even
// when Google hands back calendar.readonly (include_granted_scopes), and an admin already sharing keeps sharing.
// The authorization code → Google's token answer ({ token }), or the failed step ({ step: 'exchange' | 'client' }, logged
// in one token-free line). `client` is the OAuth client the consent page used ({ id, secret }).
async function exchangeCode(url, cfg, fetch, client) {
  const code = url.searchParams.get('code');
  if (!code) { logFailure('exchange', 0, { error: 'no code' }); return { step: 'exchange' }; }
  try {
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: client.id, client_secret: client.secret, redirect_uri: callbackUrl(cfg), grant_type: 'authorization_code',
      }).toString(),
    });
    const token = await readJson(res);
    if (!res.ok || !token || token.error) {
      const step = CLIENT_ERRORS.has(str(token?.error)) ? 'client' : 'exchange';
      logFailure(step, res.status, token);
      return { step };
    }
    return { token };
  } catch (e) {
    logFailure('exchange', 0, { error: str(e?.name) || 'network' });
    return { step: 'exchange' };
  }
}

async function callback(url, cfg, fetch) {
  const state = await verifyState(url.searchParams.get('state'), cfg.clientSecret);
  const origin = state ? allowedOrigin(state.origin, cfg.origins) : '';
  if (!origin) return page(400, EXPIRED);
  if (state.purpose === 'mailbox') return mailboxCallback(url, state, origin, cfg, fetch);
  const calendar = state.purpose === 'calendar';
  const back = calendar
    ? (result) => redirect(`${origin}/#/calendar?google=${result}`)
    : (result) => redirect(`${origin}/#/settings?tab=business&google=${result}`);
  const fail = calendar
    ? (reason) => back(CALENDAR_RESULTS.has(reason) ? reason : `error&reason=${reason}`)
    : (reason) => back(`error&reason=${reason}`);

  if (url.searchParams.get('error')) return fail('denied');
  const exchanged = await exchangeCode(url, cfg, fetch, { id: cfg.clientId, secret: cfg.clientSecret });
  if (exchanged.step) return fail(exchanged.step);
  const { token } = exchanged;

  // You can only connect your own account: the one Google signed in must be your Cortex email, and verified.
  const id = jwtPayload(token.id_token);
  const email = str(id?.email).toLowerCase();
  const verified = id?.email_verified === true || id?.email_verified === 'true';
  if (!email || !verified || email !== str(state.email).toLowerCase()) return fail('wrong_account');
  // A calendar connect where the calendar box was left unticked: nothing saved (the stored connection stays as it was).
  if (calendar && !hasCalendar(token.scope)) return fail('calendar_scope');
  if (!str(token.refresh_token)) return fail('no_refresh_token');

  try {
    const saved = await fetch(`${cfg.url}/rest/v1/rpc/google_save`, {
      method: 'POST',
      headers: { ...keyHeaders(cfg.secretKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: state.uid, p_email: email, p_token: token.refresh_token, p_scopes: str(token.scope) }),
    });
    if (!saved.ok) { logFailure('save', saved.status, await readJson(saved)); return fail('save'); }
  } catch (e) {
    logFailure('save', 0, { error: str(e?.name) || 'network' });
    return fail('save');
  }
  if (calendar) {
    // → true when the row was saved with a calendar scope and is now shared; false or a failure → error (the token
    // stays saved, sharing stays as it was).
    try {
      const shared = await fetch(`${cfg.url}/rest/v1/rpc/calendar_share`, {
        method: 'POST',
        headers: { ...keyHeaders(cfg.secretKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_user: state.uid }),
      });
      const answer = await readJson(shared);
      if (!shared.ok || answer !== true) {
        logFailure('share', shared.status, shared.ok ? { error: `answered ${JSON.stringify(answer)}`.slice(0, 60) } : answer);
        return fail('share');
      }
    } catch (e) {
      logFailure('share', 0, { error: str(e?.name) || 'network' });
      return fail('share');
    }
  }
  return back('connected');
}

async function send(body, me, cfg, fetch) {
  const message = emailFromBody(body);
  const { token, email } = await googleAccess(cfg, fetch, me);
  const mime = buildMime({ fromName: me.name, fromEmail: email, ...message });
  const sent = await google(fetch, GMAIL_SEND, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: base64url(mime) }),
  });
  return { id: str(sent.id), from: email };
}

async function contract(body, me, cfg, fetch) {
  const templateId = driveId(body.template);
  if (!templateId) throw new HttpError(400, 'The contract template isn’t a Google Doc link. Check it in Settings → Business.');
  const folderId = driveId(body.folder);
  if (!folderId) throw new HttpError(400, 'The contracts folder isn’t a Google Drive folder link. Check it in Settings → Business.');
  const name = str(String(body.name ?? '').replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, 200);
  if (!name) throw new HttpError(400, 'Name the contract.');
  const replacements = body.replacements ?? {};
  if (typeof replacements !== 'object' || Array.isArray(replacements)) throw new HttpError(400, 'Invalid replacements.');
  const requests = replaceRequests(replacements);
  if (requests.length > MAX_REPLACEMENTS) throw new HttpError(400, 'Too many replacements.');

  const { token } = await googleAccess(cfg, fetch, me);
  const auth = { Authorization: `Bearer ${token}` };
  const template = await google(fetch, `${DRIVE_FILES}/${templateId}?fields=id,name,mimeType&supportsAllDrives=true`,
    { method: 'GET', headers: auth }, NOT_FOUND);
  // A Word template is converted to a Google Doc as it is copied; anything else can't be filled in.
  if (template.mimeType !== MIME_DOC && template.mimeType !== MIME_DOCX) throw new HttpError(400, 'The template must be a Google Doc.');
  const copy = await google(fetch, `${DRIVE_FILES}/${templateId}/copy?supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [folderId], ...(template.mimeType === MIME_DOCX ? { mimeType: MIME_DOC } : {}) }),
  }, NOT_FOUND);
  const id = str(copy.id);
  if (!DRIVE_ID.test(id)) throw new HttpError(502, 'Google didn’t return the new document.');

  if (requests.length) {
    await google(fetch, `${DOCS}/${id}:batchUpdate`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
  }
  return { id, name: str(copy.name) || name, url: str(copy.webViewLink) || `https://docs.google.com/document/d/${id}/edit` };
}

// ── Outreach sync ───────────────────────────────────────────────────────────────────────────────────────────────

// The agent's columns (row 1, any order or case) → outreach_emails columns.
const SHEET_TEXT = {
  vertical: 'vertical', organisation: 'organisation', domain: 'domain', location: 'location', kdm_name: 'contact_name',
  kdm_role: 'contact_role', kdm_email: 'contact_email', tier: 'tier', signal: 'signal', subject: 'subject', variant: 'variant',
  draft_status: 'status', sent_message_id: 'message_id', thread_id: 'thread_id', sequence_status: 'sequence_status',
  reply_status: 'reply_status', reply_summary: 'reply_summary', note: 'note',
};
const SHEET_DATES = {
  date_logged: 'date_logged', sent_date: 'sent_on', next_followup_date: 'next_followup', reply_date: 'reply_on',
  meeting_booked_date: 'meeting_on',
};
const SENDER_HEADERS = ['sender', 'mailbox', 'from', 'sent_from']; // the first one with a value
const ID_HEADERS = ['sent_message_id', 'email_id', 'gmail_draft_id']; // the agent's; only for recognising its tab
const KNOWN_HEADERS = new Set([
  ...Object.keys(SHEET_TEXT), ...Object.keys(SHEET_DATES), ...SENDER_HEADERS, ...ID_HEADERS, 'followup_stage', 'bounced',
]);
const YES = new Set(['yes', 'y', 'true', '1']);
const OWN_TABS = ['Summary', 'Notes']; // written by the sync (as are the mailbox tabs), never read as the agent's rows
const SUMMARY_HEAD = ['Date', 'Mailbox', 'Sent', 'Replies', 'Reply rate', 'Bounces', 'Meetings'];
const NOTES_HEAD = ['Created', 'Mailbox', 'Pinned', 'Author', 'Note'];
const TEAM_TIMEZONE = 'Australia/Sydney'; // as src/lib/format.js

/** The Google Sheet's id and tab (gid) from its link; '' when it isn't a Sheets link. As sheetFromUrl() in src/lib/outreach.js. */
export function sheetFromUrl(url) {
  const m = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(str(url));
  if (!m) return { id: '', gid: '' };
  const gid = /[#&?]gid=(\d+)/.exec(str(url));
  return { id: m[1], gid: gid ? gid[1] : '' };
}

/** A sheet date → YYYY-MM-DD: YYYY-MM-DD (a time after it is ignored) or Australian D/M/YYYY; anything else → null. */
export function sheetDate(value) {
  const s = str(value);
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(s);
  let y, mo, d;
  if (m) [, y, mo, d] = m.map(Number);
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s,].*)?$/.exec(s))) [, d, mo, y] = m.map(Number);
  else return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null; // 31/02, 2026-13-01
  return t.toISOString().slice(0, 10);
}

// A column's letter (0 → A, 26 → AA), for a value under an empty header.
function columnName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// "Name <a@x.com>" or "A@X.com" → a@x.com
function senderAddress(value) {
  const s = str(value);
  return str(/<([^<>]*)>/.exec(s)?.[1] ?? s).toLowerCase();
}

const followupStage = (value) => {
  const n = Number.parseInt(str(value), 10);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : 0;
};

/**
 * The agent's tab (rows of cells; row 1 = headers, matched by name) → outreach_emails rows (without mailbox_id,
 * in_sheet and synced_at). One row per contact: row_key = kdm_email|date_logged, else organisation|kdm_name|date_logged
 * (lower case, the date as YYYY-MM-DD or '' when it can't be read). Not the Gmail ids: one email often goes to two
 * contacts at an organisation (two rows, the same ids), and the ids only appear as a row goes from logged to drafted to
 * sent. Rows with no email, organisation or name are skipped; of two rows with the same key the later one wins.
 * → { rows, duplicates, skipped, known (row 1 has at least one of the agent's columns), head (row 1 as read), cells
 * (each kept row's cells as read, untrimmed: cells[i] is rows[i]'s, for the mailbox tabs) }
 */
export function sheetRows(values) {
  const [head, ...body] = Array.isArray(values) && values.length ? values : [[]];
  const headers = (Array.isArray(head) ? head : []).map(str);
  const col = new Map();
  headers.forEach((h, i) => {
    const k = h.toLowerCase();
    if (k && !col.has(k)) col.set(k, i);
  });
  const byKey = new Map(); // row_key → [row, its cells as read]
  let duplicates = 0;
  let skipped = 0;
  for (const line of body) {
    const read = Array.isArray(line) ? line : [];
    const cells = read.map(str);
    if (!cells.some(Boolean)) continue;
    const get = (h) => (col.has(h) ? cells[col.get(h)] || '' : '');
    const row = { row_key: '', sender: senderAddress(SENDER_HEADERS.map(get).find(Boolean)) };
    for (const [h, c] of Object.entries(SHEET_TEXT)) row[c] = get(h);
    for (const [h, c] of Object.entries(SHEET_DATES)) row[c] = sheetDate(get(h));
    row.followup_stage = followupStage(get('followup_stage'));
    row.bounced = YES.has(get('bounced').toLowerCase());
    row.raw = {};
    cells.forEach((v, i) => {
      if (v) row.raw[headers[i] || columnName(i)] = v;
    });

    const logged = row.date_logged || '';
    const key = row.contact_email ? `${row.contact_email}|${logged}`
      : row.organisation || row.contact_name ? `${row.organisation}|${row.contact_name}|${logged}` : '';
    if (!key) {
      skipped++;
      continue;
    }
    row.row_key = key.toLowerCase();
    if (byKey.has(row.row_key)) {
      duplicates++;
      byKey.delete(row.row_key);
    }
    byKey.set(row.row_key, [row, read]);
  }
  const kept = [...byKey.values()];
  return {
    rows: kept.map(([row]) => row), duplicates, skipped, known: headers.some((h) => KNOWN_HEADERS.has(h.toLowerCase())),
    head: Array.isArray(head) ? head : [], cells: kept.map(([, read]) => read),
  };
}

// A tab title as Google compares them (it refuses "summary" next to "Summary"); trimmed, as the mailbox names are.
const tabKey = (title) => str(title).toLowerCase();

/**
 * The mailbox tabs: one per mailbox (all of them, active or not, in their order), titled with its trimmed name: the
 * agent's row 1 as read, then the rows Cortex saved for that mailbox (one per row_key), in the agent's order and
 * exactly as the agent wrote them (padded with '' to row 1's width). `parsed` is sheetRows()'s result and `rows` its
 * rows with mailbox_id (mailboxIdFor()), so Unassigned rows are in no tab. A mailbox named like the agent's tab
 * (`agentTab`), like Summary or Notes, or like an earlier mailbox, or with no name, gets no tab, so the sync never
 * writes over the agent's tab or over another of its own.
 * → { tabs: [{ title, values }], noTab: [{ mailbox (its name), why: 'agent tab' | 'reserved' | 'duplicate' | 'no name' }] }
 */
export function mailboxTabs(parsed, rows, mailboxes, agentTab) {
  const head = Array.isArray(parsed?.head) ? parsed.head : [];
  const lines = new Map(); // mailbox id → its rows' cells, padded
  (rows || []).forEach((r, i) => {
    if (!r?.mailbox_id) return;
    const read = parsed?.cells?.[i] || [];
    if (!lines.has(r.mailbox_id)) lines.set(r.mailbox_id, []);
    lines.get(r.mailbox_id).push(Array.from({ length: Math.max(head.length, read.length) }, (_, j) => read[j] ?? ''));
  });
  const tabs = [];
  const noTab = [];
  const taken = new Set();
  for (const m of mailboxes || []) {
    const title = str(m?.name);
    const key = tabKey(title);
    const why = !title ? 'no name'
      : key === tabKey(agentTab) ? 'agent tab'
        : OWN_TABS.some((t) => tabKey(t) === key) ? 'reserved'
          : taken.has(key) ? 'duplicate' : '';
    if (why) {
      noTab.push({ mailbox: title, why });
      continue;
    }
    taken.add(key);
    tabs.push({ title, values: [[...head], ...((m.id && lines.get(m.id)) || [])] });
  }
  return { tabs, noTab };
}

/** The mailbox that sends as `sender` (its id), or null (Unassigned). As mailboxFor() in src/lib/outreach.js. */
export function mailboxIdFor(mailboxes, sender) {
  const s = str(sender).toLowerCase();
  return (s && (mailboxes || []).find((m) => (m.addresses || []).some((a) => str(a).toLowerCase() === s))?.id) || null;
}

const replyRate = (t) => (t.sent ? `${Math.round((t.replies * 100) / t.sent)}%` : '');
const zero = () => ({ sent: 0, replies: 0, bounces: 0, meetings: 0 });
const earliest = (a, b) => (a && b ? (a < b ? a : b) : a || b || null);

/**
 * Emails, not rows (one email to two contacts is two rows): mapped rows grouped by email (sent_message_id, else the
 * row_key) and mailbox → [{ mailbox ('' = Unassigned), sent, bounced, reply, meeting }]: the earliest sent day, bounced
 * when any row is, the earliest reply day of the rows with a reply_status, the earliest meeting day. Same rules as
 * outreach_daily() in 0007 and outreachDaily() in src/lib/outreach.js.
 */
export function outreachEmailGroups(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const mailbox = r.mailbox_id || '';
    const k = JSON.stringify([str(r.message_id) || r.row_key, mailbox]);
    const e = groups.get(k) || { mailbox, sent: null, bounced: false, reply: null, meeting: null };
    e.sent = earliest(e.sent, r.sent_on);
    e.bounced = e.bounced || r.bounced === true;
    if (str(r.reply_status)) e.reply = earliest(e.reply, r.reply_on);
    e.meeting = earliest(e.meeting, r.meeting_on);
    groups.set(k, e);
  }
  return [...groups.values()];
}

/**
 * The Summary tab: emails per day and mailbox, newest day first (mailboxes in their order, Unassigned last): sent on
 * the sent day (and bounced, when the email bounced), replies on the reply day, meetings on the meeting day; then a
 * blank row and the all-time totals per mailbox and for all of them.
 */
export function summaryValues(rows, mailboxes) {
  const list = mailboxes || [];
  const rank = (id) => (id ? list.findIndex((m) => m.id === id) + 1 || list.length + 1 : list.length + 2);
  const name = (id) => (id ? str(list.find((m) => m.id === id)?.name) || 'Mailbox' : 'Unassigned');
  const days = new Map();
  const totals = new Map(list.map((m) => [m.id, zero()]));
  const add = (day, id, field) => {
    const k = `${day}|${id}`;
    if (!days.has(k)) days.set(k, { day, id, ...zero() });
    days.get(k)[field]++;
    if (!totals.has(id)) totals.set(id, zero());
    totals.get(id)[field]++;
  };
  for (const e of outreachEmailGroups(rows)) {
    if (e.sent) {
      add(e.sent, e.mailbox, 'sent');
      if (e.bounced) add(e.sent, e.mailbox, 'bounces');
    }
    if (e.reply) add(e.reply, e.mailbox, 'replies');
    if (e.meeting) add(e.meeting, e.mailbox, 'meetings');
  }
  const line = (first, label, t) => [first, label, t.sent, t.replies, replyRate(t), t.bounces, t.meetings];
  const daily = [...days.values()].sort((a, b) => (a.day !== b.day ? (a.day < b.day ? 1 : -1) : rank(a.id) - rank(b.id)));
  const all = zero();
  const block = [...totals.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([id, t]) => {
    for (const k of Object.keys(all)) all[k] += t[k];
    return line('Total', name(id), t);
  });
  return [SUMMARY_HEAD, ...daily.map((d) => line(d.day, name(d.id), d)), [], ...block, line('Total', 'All mailboxes', all)];
}

// An ISO time → "YYYY-MM-DD HH:MM" in Sydney.
function teamTime(iso) {
  const t = new Date(str(iso));
  if (Number.isNaN(t.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone: TEAM_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The Notes tab: pinned first, then newest first. `names`: { profile id: name }. */
export function notesValues(notes, mailboxes, names = {}) {
  const time = (n) => Date.parse(str(n.created_at)) || 0;
  const sorted = [...(notes || [])].sort((a, b) => (b.pinned === true) - (a.pinned === true) || time(b) - time(a));
  const mailbox = (id) => (id ? str((mailboxes || []).find((m) => m.id === id)?.name) || 'Mailbox' : 'All mailboxes');
  return [NOTES_HEAD, ...sorted.map((n) => [
    teamTime(n.created_at), mailbox(n.mailbox_id), n.pinned === true ? 'Yes' : '', str(names[n.author_id]), String(n.body ?? '').slice(0, MAX_CELL),
  ])];
}

// 'Tab' for an A1 range ('' doubled).
const quoteTab = (title) => `'${String(title).replace(/'/g, "''")}'`;

// Tab grids: Google refuses a values write past a tab's rowCount × columnCount, so each tab Cortex writes is first made
// big enough. A new tab gets at least Google's default; an existing one is only ever grown, never shrunk.
const NEW_TAB_GRID = { rowCount: 1000, columnCount: 26 };
const GRID_FIELDS = 'gridProperties.rowCount,gridProperties.columnCount';
// What `values` needs: as many rows, and as many columns as its longest row.
const gridNeeded = (values) => ({ rows: values.length, columns: values.reduce((n, v) => Math.max(n, v.length), 0) });
// Whether tab `p` holds `need`. A tab whose grid Google didn't give (not a grid tab) counts as big enough: its size is
// unknown, so it is never resized.
function gridFits(p, need) {
  const g = p?.gridProperties;
  if (!Number.isInteger(g?.rowCount) || !Number.isInteger(g?.columnCount)) return true;
  return g.rowCount >= need.rows && g.columnCount >= need.columns;
}
const grownGrid = (g, need) => ({ rowCount: Math.max(g.rowCount, need.rows), columnCount: Math.max(g.columnCount, need.columns) });

// PostgREST with the secret key (no RLS). → its JSON; a failure → 502 `fail` (PostgREST's own message is only logged,
// under google/<label>).
async function rest(cfg, fetch, label, path, { method = 'GET', body, prefer = '' } = {}, fail = 'Could not reach the database.') {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    headers: {
      ...keyHeaders(cfg.secretKey), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    console.error(`google/${label}: ${method} ${path.split('?')[0]} → ${res.status}`, str(data?.code), str(data?.message).slice(0, 200));
    throw new HttpError(502, fail);
  }
  return data;
}

// The sheet's tab in the link (the agents' one shared tab) → outreach_emails (rows no longer in it keep their data,
// with in_sheet false) → Cortex's tabs in the same spreadsheet: Summary, Notes and one tab per mailbox (titled with its
// name: the agent's header row and that mailbox's rows as saved, see mailboxTabs()), added or grown when needed →
// outreach_settings (synced_at, sync_stats). The sync never writes the agent's tab (a mailbox named like it gets no
// tab) and never deletes a tab (a renamed or removed mailbox's old tab stays). A failure once a link and its admin are
// set is saved as sync_error.
// There is no lock: two syncs can overlap (two people open Outreach at once). 0007's keep_newer_sync trigger skips an
// older sync's writes over a newer one's rows, so neither flags rows the other read as gone; the results are saved
// only when no newer sync has saved its own; and tabs the other one just added or grew are found again.
async function outreachSync(cfg, fetch) {
  const start = new Date().toISOString();
  const db = (path, init, fail) => rest(cfg, fetch, 'outreach-sync', path, init, fail);
  const settings = await db('outreach_settings?id=eq.1&select=sheet_url,sheet_by', {}, 'Could not read the outreach settings.');
  const set = Array.isArray(settings) ? settings[0] : null;
  if (!str(set?.sheet_url)) throw new HttpError(400, NO_SHEET);
  if (!str(set?.sheet_by)) throw new HttpError(400, NO_SHEET_BY);

  // The results (or the error) are saved only while the link and its reader are still the ones this sync read and no
  // newer sync has saved its own: an older sync finishing or failing late never overwrites a newer one's, a new link's
  // or a takeover's (Use my Google).
  const current = `id=eq.1&sheet_url=eq.${encodeURIComponent(set.sheet_url)}&sheet_by=eq.${encodeURIComponent(set.sheet_by)}`
    + `&or=(synced_at.is.null,synced_at.lt.${encodeURIComponent(start)})`;
  let token = '';
  try {
    const sheet = sheetFromUrl(set.sheet_url);
    if (!sheet.id) throw new HttpError(400, 'The outreach sheet isn’t a Google Sheets link. Check it in Settings → Outreach.');
    if (!sheet.gid) throw new HttpError(400, NO_GID); // the agent's tab is the link's tab, never a guess (below)

    // The admin who set the link: the sheet is read and written with their Google account, while they are an active admin.
    const found = await db(`profiles?id=eq.${encodeURIComponent(set.sheet_by)}&select=name,active,role`, {},
      'Could not check who set the outreach sheet.');
    const admin = Array.isArray(found) ? found[0] : null;
    const who = str(admin?.name);
    const whom = who || 'the admin who set the sheet link';
    const Who = who || 'The admin who set the sheet link';
    if (admin?.active !== true) {
      throw new HttpError(409, `${Who} is no longer active. Another admin can click Use my Google in Settings → Outreach.`);
    }
    if (admin.role !== 'superadmin' && admin.role !== 'admin') {
      throw new HttpError(409, `${Who} is no longer an admin. Another admin can click Use my Google in Settings → Outreach.`);
    }
    const reconnect = `${Who} needs to reconnect Google in Settings → Business.`;
    ({ token } = await googleAccess(cfg, fetch, { uid: set.sheet_by }, {
      unread: 'Could not read the Google connection for the outreach sheet.',
      notConnected: `${Who} needs to connect Google in Settings → Business.`,
      reconnect,
    }));
    const sheets = async (url, init, { notFound = '', forbidden = '' } = {}) => {
      const headers = { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
      try {
        return await google(fetch, url, { ...init, headers }, notFound, forbidden);
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) throw new HttpError(409, reconnect);
        throw e;
      }
    };
    const base = `${SHEETS}/${sheet.id}`;
    const unshared = `The outreach sheet wasn’t found or isn’t shared with ${whom}.`;
    const readOnly = `${Who} can’t edit the outreach sheet.`;

    const readTabs = async () => {
      const meta = await sheets(`${base}?fields=sheets.properties`, { method: 'GET' }, { notFound: unshared, forbidden: unshared });
      return (Array.isArray(meta?.sheets) ? meta.sheets : []).map((s) => s?.properties).filter((p) => p && typeof p.title === 'string');
    };
    let tabs = await readTabs(); // { sheetId, title, gridProperties: { rowCount, columnCount }, … }
    const tabNamed = (title) => tabs.find((p) => tabKey(p.title) === tabKey(title));

    // The agent's tab is the link's tab (its gid), never a guess: the sync rewrites Summary, Notes and every tab titled
    // like a mailbox, so "the first other tab" could take one of Cortex's tabs for the agent's, or the agent's tab for
    // one of Cortex's (a mailbox named like it) and write over it. No gid → refused above; a gid that is gone, or that
    // is Summary or Notes → refused here. A gid on a mailbox-named tab is fine: that tab is read, and that mailbox gets
    // no tab (mailboxTabs()), so it is never written.
    const tab = tabs.find((p) => String(p.sheetId) === sheet.gid);
    if (!tab) throw new HttpError(400, GID_GONE);
    if (OWN_TABS.some((t) => tabKey(t) === tabKey(tab.title))) throw new HttpError(400, gidOurs(str(tab.title)));
    const read = await sheets(`${base}/values/${encodeURIComponent(`${quoteTab(tab.title)}!A1:AZ`)}`, { method: 'GET' },
      { notFound: unshared, forbidden: unshared });
    const parsed = sheetRows(read.values);
    if (!parsed.known) throw new HttpError(400, `The “${tab.title}” tab has no outreach columns in row 1.`);

    const mailboxes = await db('outreach_mailboxes?select=id,name,addresses&order=position.asc', {}, 'Could not read the outreach mailboxes.');
    const boxes = Array.isArray(mailboxes) ? mailboxes : [];
    const rows = parsed.rows.map((r) => ({ ...r, mailbox_id: mailboxIdFor(boxes, r.sender), in_sheet: true, synced_at: start }));
    for (let i = 0; i < rows.length; i += SYNC_BATCH) {
      await db('outreach_emails?on_conflict=row_key', {
        method: 'POST', body: rows.slice(i, i + SYNC_BATCH), prefer: 'resolution=merge-duplicates,return=minimal',
      }, 'Could not save the outreach emails.');
    }
    // Every row this sync didn't write is no longer in the sheet. Stamped with this sync's start too, so an older sync
    // finishing late can't put it back (0007's keep_newer_sync skips its write).
    const gone = await db(`outreach_emails?synced_at=lt.${start}&in_sheet=eq.true&select=id`, {
      method: 'PATCH', body: { in_sheet: false, synced_at: start }, prefer: 'return=representation',
    }, 'Could not update the outreach emails.');

    // Write back: Summary, Notes and the mailbox tabs, in three requests however many mailboxes there are. First one
    // batchUpdate (only when needed) adds the missing tabs and grows the ones too small: Google never grows a grid on a
    // values write ("exceeds grid limits"), and a mailbox tab is as wide as the agent's (~35 columns, a new tab has
    // 26) while Summary passes 1,000 rows within a year. Then all of them are cleared in one request and rewritten in
    // one, as plain values (RAW: a cell starting with "=" stays text). An existing tab keeps its own title (any case).
    const boxTabs = mailboxTabs(parsed, rows, boxes, tab.title);
    const notes = await db('outreach_notes?select=mailbox_id,pinned,body,author_id,created_at', {}, 'Could not read the outreach notes.');
    const noteList = Array.isArray(notes) ? notes : [];
    const authors = [...new Set(noteList.map((n) => str(n.author_id)).filter(Boolean))];
    const people = authors.length
      ? await db(`profiles?select=id,name&id=in.(${authors.map(encodeURIComponent).join(',')})`, {}, 'Could not read the note authors.')
      : [];
    const names = Object.fromEntries((Array.isArray(people) ? people : []).map((p) => [p.id, str(p.name)]));
    const writes = [
      ['Summary', summaryValues(rows, boxes)], ['Notes', notesValues(noteList, boxes, names)], ...boxTabs.tabs.map((t) => [t.title, t.values]),
    ].map(([title, values]) => ({ title, values, ...gridNeeded(values) }));
    const sizeRequests = () => writes.flatMap((w) => {
      const p = tabNamed(w.title);
      if (!p) return [{ addSheet: { properties: { title: w.title, gridProperties: grownGrid(NEW_TAB_GRID, w) } } }];
      if (gridFits(p, w)) return [];
      return [{ updateSheetProperties: { properties: { sheetId: p.sheetId, gridProperties: grownGrid(p.gridProperties, w) }, fields: GRID_FIELDS } }];
    });
    const requests = sizeRequests();
    if (requests.length) {
      try {
        await sheets(`${base}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) }, { forbidden: readOnly });
      } catch (e) {
        // Another sync running at the same time may have just added or grown them: carry on if they all are now.
        tabs = await readTabs();
        if (sizeRequests().length) throw e;
      }
    }
    const targets = writes.map((w) => ({ ...w, title: tabNamed(w.title)?.title ?? w.title }));
    await sheets(`${base}/values:batchClear`, {
      method: 'POST', body: JSON.stringify({ ranges: targets.map((w) => quoteTab(w.title)) }),
    }, { forbidden: readOnly });
    await sheets(`${base}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: targets.map((w) => ({ range: `${quoteTab(w.title)}!A1`, majorDimension: 'ROWS', values: w.values })),
      }),
    }, { forbidden: readOnly });

    // Stats: sent, replies, bounced and meetings are emails, as on the Summary (all time); contacts = rows sent to.
    const emails = outreachEmailGroups(rows);
    const stats = {
      rows: rows.length,
      contacts: rows.filter((r) => r.sent_on).length,
      sent: emails.filter((e) => e.sent).length,
      replies: emails.filter((e) => e.reply).length,
      bounced: emails.filter((e) => e.sent && e.bounced).length,
      meetings: emails.filter((e) => e.meeting).length,
      unassigned: rows.filter((r) => !r.mailbox_id).length,
      duplicates: parsed.duplicates,
      skipped: parsed.skipped,
      missing: Array.isArray(gone) ? gone.length : 0,
      tab: tab.title,
      tabs: targets.slice(OWN_TABS.length).map((w) => w.title), // the mailbox tabs written, in mailbox order
      noTab: boxTabs.noTab, // [{ mailbox, why }]: the mailboxes that got no tab
    };
    await db(`outreach_settings?${current}`, {
      method: 'PATCH', body: { synced_at: start, sync_error: '', sync_stats: stats }, prefer: 'return=minimal',
    }, 'Could not save the sync results.');
    return { ok: true, stats };
  } catch (e) {
    // Saved for Settings → Outreach: a short message of ours, never a token or Google's payload.
    let message = e instanceof HttpError ? e.message : SYNC_FAILED;
    if (token) message = message.split(token).join('…');
    message = message.replace(/\s+/g, ' ').trim().slice(0, 500) || SYNC_FAILED;
    try {
      await db(`outreach_settings?${current}`, { method: 'PATCH', body: { sync_error: message }, prefer: 'return=minimal' }, '');
    } catch {
      // the caller gets the error either way
    }
    throw e instanceof HttpError ? new HttpError(e.status, message) : e;
  }
}

// ── Calendar sync ───────────────────────────────────────────────────────────────────────────────────────────────

const CALENDAR_PAGES = 10; // events.list pages of 2,500 per person; more → TOO_MANY_EVENTS, nothing saved
const CALENDAR_EVENT_TYPES = ['default', 'outOfOffice', 'focusTime', 'fromGmail']; // not workingLocation or birthday
const CALENDAR_FIELDS = 'nextPageToken,items(id,status,summary,visibility,start,end,eventType,attendees(self,responseStatus))';
const MAX_TITLE = 200;
const TOO_MANY_EVENTS = 'Too many events';
// Saved per person (calendar_sync.error, which every staff member sees on the Calendar page): short, never a token.
const CAL_UNREAD = 'Could not read the Google connection.';
const CAL_NOT_CONNECTED = 'Google Calendar isn’t connected.';
const CAL_RECONNECT = 'Google Calendar needs reconnecting.';
const CAL_FAILED = 'Something went wrong with Google.';
const CAL_ERROR_LENGTH = 200;

/** Whether a space-separated scope list holds a calendar scope as a whole entry (as private.has_calendar() in 0009). */
export function hasCalendar(scopes) {
  return str(scopes).split(/\s+/).some((s) => CALENDAR_SCOPE_ENTRIES.includes(s));
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const utcDay = (y, m, d) => new Date(Date.UTC(y, m, d)); // Date.UTC carries a month or day past its end over
const ymdOf = (t) => t.toISOString().slice(0, 10);
const midnightUtc = (t) => `${ymdOf(t)}T00:00:00Z`;

// A real YYYY-MM-DD → the same; anything else → ''.
function validYmd(value) {
  const m = YMD.exec(str(value));
  if (!m) return '';
  const t = utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return ymdOf(t) === m[0] ? m[0] : '';
}

/** Today in Sydney as YYYY-MM-DD (business dates are Sydney's, as team_today()). */
export function teamToday(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone: TEAM_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The sync window for a (Sydney) day: the first day of last month to the last day of the month 11 months on, as dates
 * (from / to, inclusive; what calendar_save prunes inside), and the instants events.list is asked for (timeMin /
 * timeMax: UTC midnights one day beyond the window on each side, so every time zone's view of those days is in it).
 * 2026-10-21 → { from: 2026-09-01, to: 2027-09-30, timeMin: 2026-08-31T00:00:00Z, timeMax: 2027-10-02T00:00:00Z }
 */
export function calendarWindow(todayYmd) {
  const m = YMD.exec(str(todayYmd));
  if (!m || !validYmd(todayYmd)) throw new Error('calendarWindow: not a YYYY-MM-DD date');
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return {
    from: ymdOf(utcDay(y, mo - 1, 1)),
    to: ymdOf(utcDay(y, mo + 12, 0)), // day 0 of the month after month +11 = its last day
    timeMin: midnightUtc(utcDay(y, mo - 1, 0)),
    timeMax: midnightUtc(utcDay(y, mo + 12, 2)),
  };
}

// Code points, not UTF-16 units (Postgres counts characters), so an emoji is never cut in half.
const clip = (s, n) => Array.from(s).slice(0, n).join('');

/**
 * A Google Calendar event (events.list item) → a calendar_meetings row, or null when it isn't one: no id, cancelled,
 * a working location or birthday, declined by you (your own attendee entry), or with no readable start. Private and
 * confidential events are busy: no title. All day: start.date to end.date minus a day (Google's end is exclusive;
 * never before the start), no times. Timed: the instants as ISO, their UTC dates (an end before the start → the start).
 * Only the title is kept: never a description, place, attendee or link.
 * → { google_id, title, busy, all_day, start_date, end_date, start_at, end_at }
 */
export function meetingRow(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const id = str(ev.id);
  if (!id || ev.status === 'cancelled') return null;
  if (ev.eventType === 'workingLocation' || ev.eventType === 'birthday') return null;
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  if (attendees.some((a) => a?.self === true && a.responseStatus === 'declined')) return null;
  const busy = ev.visibility === 'private' || ev.visibility === 'confidential';
  const title = busy ? '' : clip(str(ev.summary), MAX_TITLE);
  const start = ev.start && typeof ev.start === 'object' ? ev.start : {};
  const end = ev.end && typeof ev.end === 'object' ? ev.end : {};

  if (start.date !== undefined && start.dateTime === undefined) {
    const startDate = validYmd(start.date);
    if (!startDate) return null;
    const endExclusive = validYmd(end.date);
    let endDate = endExclusive ? ymdOf(new Date(Date.parse(`${endExclusive}T00:00:00Z`) - 86400000)) : startDate;
    if (endDate < startDate) endDate = startDate;
    return { google_id: id, title, busy, all_day: true, start_date: startDate, end_date: endDate, start_at: null, end_at: null };
  }

  const a = Date.parse(str(start.dateTime));
  if (!Number.isFinite(a)) return null;
  const b = Date.parse(str(end.dateTime));
  const startAt = new Date(a);
  const endAt = Number.isFinite(b) && b >= a ? new Date(b) : startAt;
  return {
    google_id: id, title, busy, all_day: false, start_date: ymdOf(startAt), end_date: ymdOf(endAt),
    start_at: startAt.toISOString(), end_at: endAt.toISOString(),
  };
}

// One person's primary calendar in the window → their rows (one per event id), or an HttpError.
async function calendarRows(fetch, token, win) {
  const rows = new Map();
  let pageToken = '';
  for (let n = 0; n < CALENDAR_PAGES; n++) {
    const q = new URLSearchParams({
      timeMin: win.timeMin, timeMax: win.timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500',
      maxAttendees: '1', showDeleted: 'false',
    });
    for (const type of CALENDAR_EVENT_TYPES) q.append('eventTypes', type);
    q.set('fields', CALENDAR_FIELDS);
    if (pageToken) q.set('pageToken', pageToken);
    const data = await google(fetch, `${CALENDAR_EVENTS}?${q}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    for (const ev of Array.isArray(data?.items) ? data.items : []) {
      const row = meetingRow(ev);
      if (row) rows.set(row.google_id, row);
    }
    pageToken = str(data?.nextPageToken);
    if (!pageToken) return [...rows.values()];
  }
  throw new HttpError(422, TOO_MANY_EVENTS);
}

// A failure → the short text saved for that person: ours, or Google's message with the access token cut out.
function calendarError(e, token) {
  if (!(e instanceof HttpError)) return CAL_FAILED;
  if (e.status === 409) return e.message === CAL_NOT_CONNECTED ? CAL_NOT_CONNECTED : CAL_RECONNECT; // and p_reconnect
  let message = e.message;
  if (token) message = message.split(token).join('…');
  return clip(message.replace(/\s+/g, ' ').trim(), CAL_ERROR_LENGTH) || CAL_FAILED;
}

// The ids rpc calendar_claim returned (PostgREST gives a setof uuid as bare values; objects are read too).
function claimedIds(data) {
  const list = Array.isArray(data) ? data : [];
  return [...new Set(list.map((x) => str(x && typeof x === 'object' ? Object.values(x)[0] : x)).filter(Boolean))];
}

// Claims the people whose turn it is (staff sharing their calendar, not synced in the last 10 minutes, or 1 minute when
// forced) and syncs them one at a time with their own Google accounts. One person's failure (saved as their error, with
// reconnect when their Google connection needs it) never stops the others. Every save carries this run's start, so an
// older run finishing late never overwrites a newer one's meetings or status (calendar_save).
async function calendarSync(body, cfg, fetch) {
  const started = new Date();
  const start = started.toISOString();
  const db = (path, init, fail) => rest(cfg, fetch, 'calendar-sync', path, init, fail);
  const claimed = claimedIds(await db('rpc/calendar_claim', {
    method: 'POST', body: { p_gap: body.force === true ? 60 : 600 },
  }, 'Could not start the calendar sync.'));
  const result = { ok: true, claimed: claimed.length, synced: 0, failed: 0 };
  if (!claimed.length) return result;

  const win = calendarWindow(teamToday(started));
  for (const uid of claimed) {
    let rows = [];
    let error = '';
    let reconnect = false;
    let token = '';
    try {
      ({ token } = await googleAccess(cfg, fetch, { uid }, {
        unread: CAL_UNREAD, notConnected: CAL_NOT_CONNECTED, reconnect: CAL_RECONNECT,
      }, hasCalendar));
      rows = await calendarRows(fetch, token, win);
    } catch (e) {
      rows = [];
      reconnect = e instanceof HttpError && e.status === 409;
      error = calendarError(e, token);
    }
    try {
      const saved = await db('rpc/calendar_save', {
        method: 'POST',
        body: {
          p_user: uid, p_started: start, p_from: win.from, p_to: win.to, p_rows: rows, p_error: error, p_reconnect: reconnect,
        },
      }, 'Could not save the calendar.');
      if (error) result.failed++;
      else if (saved === true) result.synced++; // false: no longer staff sharing a calendar; their meetings are gone
    } catch {
      result.failed++;
    }
  }
  return result;
}

// ── Task emails (0013) ──────────────────────────────────────────────────────────────────────────────────────────
// A task's owner hears by email when someone else hands them the task or posts an update on it. The database queues
// them (triggers on items and item_updates, private.task_mail) and decides what may still go (task_mail_claim: still
// theirs, still active, the board still theirs to see); this sends one plain-text email per person from the Gmail of the
// admin chosen in Settings → Business, with a link to each task, and records the result (task_mail_done).

const TASK_MAIL_FROM = 'Cortex';
const TASK_MODULES = { projects: 'Operations', marketing: 'Marketing', outreach: 'Outreach', clients: 'Clients', pipeline: 'Pipeline' };
const MAX_UPDATE = 2000; // an update's text in the email
const SENDER_RECONNECT = 'The admin who sends task emails needs to reconnect Google in Settings → Business.';
const oneLine = (s) => str(String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ')).replace(/\s+/g, ' ');
const firstName = (name) => oneLine(name).split(' ')[0] || 'Someone';

// 'YYYY-MM-DD' → 'Fri 30 Oct'; anything else → ''.
export function dueLabel(day) {
  const s = str(day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/,/g, '');
}

// Where a task lives, as its breadcrumb in the app: Operations › Landing Page, or “David’s notes” for a personal page.
function whereLabel(e) {
  if (str(e.board_owner)) return `${firstName(e.board_owner)}’s notes`;
  return [TASK_MODULES[e.module] || '', oneLine(e.board) || 'Untitled board'].filter(Boolean).join(' › ');
}

const taskLink = (origin, e) => `${origin}/#/${encodeURIComponent(str(e.module))}/${encodeURIComponent(str(e.board_id))}?item=${encodeURIComponent(str(e.item_id))}`;

/** One person's claimed events → { subject, text }: one email, each event with a link to its task. */
export function taskMailMessage(mail, origin) {
  const events = Array.isArray(mail?.events) ? mail.events : [];
  const name = (e) => oneLine(e.item) || 'Untitled task';
  const blocks = events.map((e) => {
    const who = oneLine(e.actor) || 'Someone';
    const v = e.values || {};
    if (e.kind === 'assigned') {
      const facts = [
        str(v.priority) && `Priority: ${oneLine(v.priority)}`,
        dueLabel(v.due) && `Due: ${dueLabel(v.due)}`,
        str(v.status) && `Status: ${oneLine(v.status)}`,
      ].filter(Boolean).join(' · ');
      return [`${who} assigned you a task:`, name(e), whereLabel(e), facts, taskLink(origin, e)].filter(Boolean).join('\n');
    }
    const said = String(e.text ?? '').replace(/\r\n|\r/g, '\n').trim();
    const text = said.length > MAX_UPDATE ? `${said.slice(0, MAX_UPDATE)}…` : said;
    return [`${who} posted an update on ${name(e)} (${whereLabel(e)}):`, text, taskLink(origin, e)].filter(Boolean).join('\n');
  });
  let subject;
  if (events.length === 1) {
    const e = events[0];
    subject = e.kind === 'assigned' ? `${oneLine(e.actor) || 'Someone'} assigned you: ${name(e)}` : `Update on ${name(e)}`;
  } else {
    subject = `${events.length} task updates in Cortex`;
  }
  if (subject.length > MAX_SUBJECT) subject = `${subject.slice(0, MAX_SUBJECT - 1)}…`;
  return { subject, text: `${blocks.join('\n\n')}\n` };
}

async function taskMail(cfg, fetch, origin) {
  const db = (path, body, fail) => rest(cfg, fetch, 'task-mail', path, { method: 'POST', body }, fail);
  const done = (ids, error = '') => db('rpc/task_mail_done', { p_ids: ids, p_error: error }, 'Could not save the task emails.');
  const claim = await db('rpc/task_mail_claim', { p_limit: 100 }, 'Could not read the task emails.');
  const mails = Array.isArray(claim?.mails) ? claim.mails : [];
  const result = { ok: true, sent: 0, failed: 0 };
  if (!str(claim?.sender) || !mails.length) return result;

  let access;
  try {
    access = await googleAccess(cfg, fetch, { uid: str(claim.sender) }, {
      unread: 'Could not read the task email sender’s Google connection.', notConnected: SENDER_RECONNECT, reconnect: SENDER_RECONNECT,
    });
  } catch (e) {
    const error = e instanceof HttpError ? e.message : 'Google sign-in failed.';
    await done(mails.flatMap((m) => m.ids || []), error);
    result.failed = mails.length;
    return result;
  }
  const link = origin || cfg.origins[0] || DEFAULT_ORIGINS[0];
  for (const mail of mails) {
    const ids = Array.isArray(mail.ids) ? mail.ids : [];
    const to = str(mail.to).toLowerCase();
    let error = '';
    try {
      if (!EMAIL.test(to) || !ASCII.test(to) || to.length > 254) throw new HttpError(400, 'Not a valid email address.');
      const { subject, text } = taskMailMessage(mail, link);
      const mime = buildMime({ fromName: TASK_MAIL_FROM, fromEmail: access.email, to: [to], subject, text });
      await google(fetch, GMAIL_SEND, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: base64url(mime) }),
      });
    } catch (e) {
      error = e instanceof HttpError ? e.message : 'Sending failed.';
    }
    try {
      await done(ids, error);
    } catch {
      // Unsaved: the rows go again once their claim lapses (5 minutes).
    }
    if (error) result.failed++;
    else result.sent++;
  }
  return result;
}

// ── Outreach Gmail (0010) ───────────────────────────────────────────────────────────────────────────────────────
// Each outreach mailbox's own Gmail, read only, to measure cold sales emails. An admin connects a mailbox by signing in
// to that mailbox's Google account (rpc outreach_gmail_connect keeps its refresh token in private.outreach_gmail). The
// sync reads only message headers (format=metadata): never a body, snippet or attachment. A thread is kept only when it
// is COLD: we sent its first message, to 1–5 new outside contacts (not internal, not a known client, contact or user,
// never wrote to this mailbox before). Its rows hold our first subject, the prospect's address and name, and when we
// sent, they replied, an auto-reply came or the email bounced; nothing of a reply but its time.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
export const MAILBOX_SCOPES = `openid email ${GMAIL_READ}`; // a mailbox connect: nothing but Gmail read
// Ours: mail to or from these (and every mailbox's own domain, from rpc outreach_gmail_known) is never cold.
const INTERNAL_DOMAINS = ['assetstackai.com', 'assetstack.org', 'assetstackai.com.au'];
/** The sync's limits per run (handle() takes overrides, for tests). */
export const GMAIL_LIMITS = {
  deadline: 60000, // ms for a run, shared out between the claimed mailboxes
  mailboxes: 3, // claimed per run (p_limit)
  listPages: 40, // messages.list pages of 500 on a first read or a restart
  historyPages: 20, // history pages of 500 per run
  threadsPerRun: 500, // threads read per mailbox per run
  saveEvery: 100, // threads per rpc outreach_gmail_save
  parallel: 6, // threads read at once
  backoff: 2000, // ms to wait once on a Gmail rate limit (or a 500/502/503/504) before trying again
};
const DAY_MS = 86400000;
const LOOKBACK_DAYS = 90; // a first read: our sent mail of the last 90 days
const RESTART_OVERLAP_DAYS = 2; // a restart (history too old): from 2 days before the last sync
// p_started when the job doesn't give the claim's own run_started: the time the claim answered plus this, so the
// function's clock running a little behind the database's never makes its own run look older than its claim (a newer
// run can only claim the mailbox 30 s later, or after this run released it).
const START_MARGIN = 5000;
const MAX_COLD_RECIPIENTS = 5;
const MAX_NAME = 100;
const GMAIL_METADATA = [
  'From', 'To', 'Cc', 'Subject', 'Sender', 'In-Reply-To', 'Content-Type', 'Auto-Submitted', 'X-Autoreply', 'X-Autorespond',
  'Precedence', 'X-Failed-Recipients',
];
const GMAIL_THREAD_FIELDS = 'id,messages(id,labelIds,internalDate,payload(mimeType,headers))'; // never snippet
const GMAIL_LIST_FIELDS = 'messages(threadId),nextPageToken';
const GMAIL_HISTORY_FIELDS = 'history(id,messagesAdded(message(id,threadId,labelIds))),nextPageToken,historyId';
const RATE_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED', 'quotaExceeded'];
const GMAIL_TRANSIENT = [500, 502, 503, 504]; // a passing Gmail server error: retried once, like a rate limit
// A thread whose read answers a server error (after the retry) goes to the back of the queue and is tried again next
// run. Its failures count at most once per GMAIL_FAILURE_SPACING (runs can come a minute or seconds apart: a first read's
// forced retries, a Sync now chain), and one that reaches GMAIL_THREAD_FAILURES counted failures (so spread over at least
// 40 minutes) is dropped. GMAIL_SERVER_STOP server errors in one run stop the mailbox, as a rate limit.
const GMAIL_THREAD_FAILURES = 5;
const GMAIL_FAILURE_SPACING = 10 * 60 * 1000; // ms
const GMAIL_SERVER_STOP = 3;
// Saved per mailbox (outreach_gmail_sync.error, which Outreach shows): short, never a token or an address.
const GMAIL_RECONNECT = 'Reconnect this mailbox’s Gmail in Settings → Outreach.';
const GMAIL_OTHER_ACCOUNT = 'Signed in as another account.';
const GMAIL_BUSY = 'Gmail is busy. Cortex will try again shortly.';
const GMAIL_FAILED = 'Something went wrong with Gmail.';
const GMAIL_NO_KNOWN = 'Could not read Cortex’s contacts.';
const MAILBOX_GONE = 'That mailbox isn’t in Cortex any more.';
const MAILBOX_INACTIVE = 'That mailbox isn’t active.';
const mailboxDomain = (hd) => `Connect Gmail needs an @${hd} address on this mailbox for now.`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * A Gmail rate limit (429, or 403 with a rate-limit reason) that outlasted one short back-off: a thread's read stops the
 * mailbox there and holds its claim (no more this chain); the profile, list or history step saves "Gmail is busy".
 */
class RateLimited extends Error {}
/**
 * A Gmail 500, 502, 503 or 504 that came back after the one retry. A thread's read (or its prior-inbound check) moves
 * that thread to the back of the queue, counting one more failure when its last counted one is at least
 * GMAIL_FAILURE_SPACING old (dropped at GMAIL_THREAD_FAILURES), and goes on with the others, so a thread Gmail keeps
 * failing on never blocks the queue and an outage of under 40 minutes never loses one, however often runs come;
 * GMAIL_SERVER_STOP of them in a run stop the mailbox as a rate limit. The profile, list or history step saves "Gmail is
 * busy".
 */
class GmailServerError extends RateLimited {}

/** Whether a space-separated scope list holds gmail.readonly as a whole entry (as private.has_gmail_read() in 0010). */
export function hasGmailRead(scopes) {
  return str(scopes).split(/\s+/).includes(GMAIL_READ);
}

/**
 * The OAuth client a mailbox connection uses, by its key (private.outreach_gmail.client) → { id, secret, hd }, or null
 * for a key this function doesn't know. Only 'default' for now: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, an app Internal
 * to the assetstackai.com Workspace. Another Workspace (@assetstack.org, @assetstackai.com.au) gets its own key here.
 */
export function clientFor(cfg, key = 'default') {
  if (key !== 'default') return null;
  return { id: cfg.clientId, secret: cfg.clientSecret, hd: DOMAIN };
}

const domainOf = (email) => {
  const s = str(email).toLowerCase();
  const i = s.lastIndexOf('@');
  return i < 0 ? '' : s.slice(i + 1);
};
const localOf = (email) => {
  const s = str(email).toLowerCase();
  const i = s.lastIndexOf('@');
  return i < 0 ? s : s.slice(0, i);
};
const unique = (list) => [...new Set(list)];
const threadIds = (list) => unique((Array.isArray(list) ? list : []).map(str).filter((t) => THREAD_ID.test(t)));
const validTime = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const wholeCount = (n) => Number.isInteger(n) && n > 0;
// job.failures ({ thread id: { n: counted server errors, at: ISO time of the last counted one } }) → a Map of the valid
// entries (n a positive whole number, at a valid time; any other entry is ignored). A legacy plain count n → { n, at: '' }
// (its next failure counts), written back as that plain count (failureOut) while it isn't counted again.
const failureCounts = (v) => new Map(!v || typeof v !== 'object' || Array.isArray(v) ? [] : Object.entries(v).flatMap(([t, e]) => {
  if (!THREAD_ID.test(t)) return [];
  if (wholeCount(e)) return [[t, { n: e, at: '' }]];
  return e && typeof e === 'object' && wholeCount(e.n) && validTime(e.at) ? [[t, { n: e.n, at: e.at }]] : [];
}));
const failureOut = ({ n, at }) => (at ? { n, at } : n);

// Whether `email` is on one of `domains` (a Set of lower-case domains) or a subdomain of one.
function onDomain(email, domains) {
  const parts = domainOf(email).split('.');
  for (let i = 0; i < parts.length - 1; i++) if (domains.has(parts.slice(i).join('.'))) return true;
  return false;
}

// RFC 2047 Q encoding → bytes ('_' is a space, =XX a byte).
function qBytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '_') out.push(32);
    else if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) { out.push(Number.parseInt(hex, 16)); i += 2; } else out.push(text.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/** A header value with its RFC 2047 encoded words (=?charset?B|Q?…?=) decoded; the space between two of them dropped. */
export function decodeHeader(value) {
  return String(value ?? '').replace(/\r?\n(?=[ \t])/g, '').replace(/(\?=)\s+(?==\?[^?\s]+\?[BbQq]\?)/g, '$1')
    .replace(ENCODED_WORD, (word, charset, enc, text) => {
      try {
        const bytes = enc.toUpperCase() === 'B' ? fromBase64(text) : qBytes(text);
        return new TextDecoder(charset.split('*')[0].toLowerCase(), { fatal: false }).decode(bytes);
      } catch {
        return word;
      }
    });
}

// A display name as read: quotes and their escapes removed, encoded words decoded, spaces collapsed.
function displayName(raw) {
  const unquoted = String(raw).replace(/"((?:[^"\\]|\\.)*)"/g, (_, q) => q.replace(/\\(.)/g, '$1'));
  return decodeHeader(unquoted).replace(/\s+/g, ' ').trim();
}

/**
 * An address-list header (From, To, Cc, Sender) → [{ name, email }] in order: display names (quoted, with commas or
 * angle brackets inside, or RFC 2047 encoded words), comments, groups ("undisclosed-recipients:;") and bare addresses.
 * Addresses are lower case; anything that isn't one is dropped.
 */
export function parseAddresses(value) {
  const s = String(value ?? '').replace(/\r?\n(?=[ \t])/g, '');
  const parts = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  let comment = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      cur += ch;
      if (ch === '\\' && i + 1 < s.length) cur += s[++i];
      else if (ch === '"') quoted = false;
    } else if (comment) {
      if (ch === '\\') i++;
      else if (ch === '(') comment++;
      else if (ch === ')') comment--;
    } else if (ch === '(') {
      comment = 1;
    } else if (ch === '"') {
      quoted = true;
      cur += ch;
    } else if (!angle && (ch === ',' || ch === ';')) {
      parts.push(cur);
      cur = '';
    } else if (!angle && ch === ':') {
      cur = ''; // a group's name
    } else {
      if (ch === '<') angle = true;
      else if (ch === '>') angle = false;
      cur += ch;
    }
  }
  parts.push(cur);
  const out = [];
  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    const m = /<([^<>]*)>\s*$/.exec(p);
    const email = str(m ? m[1] : p).replace(/^mailto:/i, '').toLowerCase();
    if (!EMAIL.test(email)) continue;
    out.push({ name: m ? displayName(p.slice(0, m.index)) : '', email });
  }
  return out;
}

const labelsOf = (msg) => (Array.isArray(msg?.labelIds) ? msg.labelIds : []);

// A message's headers → { lower-case name: value } (To and Cc that appear twice are joined; others keep the first).
function headersOf(msg) {
  const out = Object.create(null);
  for (const h of Array.isArray(msg?.payload?.headers) ? msg.payload.headers : []) {
    const name = str(h?.name).toLowerCase();
    if (!name) continue;
    const value = String(h?.value ?? '');
    if (!(name in out)) out[name] = value;
    else if (name === 'to' || name === 'cc') out[name] = `${out[name]}, ${value}`;
  }
  return out;
}

const subjectOf = (h) => decodeHeader(h.subject ?? '').replace(/\s+/g, ' ').trim();
const firstAddress = (value) => parseAddresses(value)[0]?.email || '';
const isoOf = (msg) => {
  const n = Number(msg?.internalDate);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : '';
};

const BOUNCE_FROM = /^(?:mailer-daemon|postmaster)$/i;
// A delay notice (not a bounce), by how its subject starts: "Delivery Status Notification (Delay)", "Delivery delayed: …",
// "Warning: message 1Abc delayed 24 hours", "Delayed Mail (still being retried)". Never by "delay" anywhere in it: a real
// bounce quotes our subject ("Undeliverable: Delayed maintenance on your bridges").
const DELAY_NOTICE = /^(?:delivery status notification \(delay\)|delivery delayed\b|warning: (?:message \S+ )?delayed?\b|delayed mail\b|message delayed\b)/i;
const AUTO_SUBJECT = /^(automatic reply|auto[- ]?reply|out of (the )?office|ooo\b|abwesenheit|réponse automatique)/i;
const CALENDAR_SUBJECT = /^(accepted|declined|tentatively accepted|invitation|updated invitation|canceled event|cancelled event):/i;
const CALENDAR_SENDER = 'calendar-notification@google.com';
const NO_REPLY = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify)(?:[-+._].*)?$/i;
const REPLY_SUBJECT = /^(re|fwd?)\s*:/i;
const CONTEXT = Symbol('gmail context');

// { internal, emails, domains } (arrays or Sets) → lower-case Sets, the internal domains always included.
function gmailContext(ctx = {}) {
  if (ctx?.[CONTEXT]) return ctx;
  const set = (v) => (v instanceof Set ? v : new Set((Array.isArray(v) ? v : []).map((x) => str(x).toLowerCase()).filter(Boolean)));
  return {
    [CONTEXT]: true, internal: new Set([...INTERNAL_DOMAINS, ...set(ctx?.internal)]), emails: set(ctx?.emails), domains: set(ctx?.domains),
  };
}

// Auto-Submitted (anything but "no"), X-Autoreply, X-Autorespond, or Precedence auto_reply / bulk / junk.
function autoHeaders(h) {
  if ('auto-submitted' in h && str(h['auto-submitted']).toLowerCase().split(';')[0].trim() !== 'no') return true;
  if ('x-autoreply' in h || 'x-autorespond' in h) return true;
  return ['auto_reply', 'bulk', 'junk'].includes(str(h.precedence).toLowerCase());
}

/**
 * What one Gmail message (format=metadata) is, for a thread of ours. In this order:
 * - 'ignored': a draft or chat;
 * - 'ours': labelled SENT;
 * - 'bounce': from mailer-daemon or postmaster, a multipart/report delivery-status report, or with X-Failed-Recipients
 *   (a delay notice, known by how its subject starts, is 'ignored');
 * - 'ignored': from an internal domain (or no readable From), or Google Calendar (its sender or an
 *   Accepted:/Declined:/Invitation:… subject);
 * - 'auto': an auto-reply or out-of-office (Auto-Submitted, X-Autoreply, X-Autorespond, Precedence, or the subject);
 * - 'ignored': a no-reply or notifications sender;
 * - 'reply': anything else.
 * `ctx`: { internal: domains } (the defaults are always included).
 */
export function messageKind(msg, ctx = {}) {
  const c = gmailContext(ctx);
  const labels = labelsOf(msg);
  if (labels.includes('DRAFT') || labels.includes('CHAT')) return 'ignored';
  if (labels.includes('SENT')) return 'ours';
  const h = headersOf(msg);
  const from = firstAddress(h.from);
  const subject = subjectOf(h);
  const type = str(h['content-type'] || msg?.payload?.mimeType).toLowerCase();
  if (BOUNCE_FROM.test(localOf(from)) || 'x-failed-recipients' in h
      || (/^multipart\/report\b/.test(type) && /report-type\s*=\s*"?delivery-status"?/.test(type))) {
    return DELAY_NOTICE.test(subject) ? 'ignored' : 'bounce';
  }
  if (!from || onDomain(from, c.internal)) return 'ignored';
  if (from === CALENDAR_SENDER || firstAddress(h.sender) === CALENDAR_SENDER || CALENDAR_SUBJECT.test(subject)) return 'ignored';
  if (autoHeaders(h) || AUTO_SUBJECT.test(subject)) return 'auto';
  if (NO_REPLY.test(localOf(from))) return 'ignored';
  return 'reply';
}

// A thread's messages (drafts and chats left out), oldest first.
function threadMessages(thread) {
  return (Array.isArray(thread?.messages) ? thread.messages : [])
    .filter((m) => m && typeof m === 'object' && !labelsOf(m).includes('DRAFT') && !labelsOf(m).includes('CHAT'))
    .map((m, i) => ({ m, i, at: Number(m.internalDate) || 0 }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.m);
}

// Not a colleague: an address on none of the internal domains (the mailbox's own included).
const outsideOf = (c) => (r) => !onDomain(r.email, c.internal);

// What the first (non-draft) message says, when it is ours; else null.
function firstFacts(thread, c) {
  const msgs = threadMessages(thread);
  const first = msgs[0];
  if (!first || messageKind(first, c) !== 'ours') return null;
  const firstAt = isoOf(first);
  if (!firstAt) return null;
  const h = headersOf(first);
  const to = parseAddresses(h.to);
  const cc = parseAddresses(h.cc);
  const seen = new Set();
  const outside = outsideOf(c);
  // Colleagues in To or Cc don't count: the outside people do (each address once).
  const recipients = [...to, ...cc].filter((r) => outside(r) && !seen.has(r.email) && seen.add(r.email));
  const type = str(h['content-type'] || first?.payload?.mimeType).toLowerCase();
  return {
    msgs, firstAt, h, subject: subjectOf(h), from: firstAddress(h.from), recipients,
    prospect: to.find(outside) || cc.find(outside) || { name: '', email: '' },
    calendar: type.startsWith('text/calendar') || firstAddress(h.sender) === CALENDAR_SENDER || firstAddress(h.from) === CALENDAR_SENDER,
  };
}

/**
 * Whether a thread we haven't stored yet is cold, from its headers alone: its first non-draft message is ours, isn't a
 * reply or forward (no In-Reply-To, no Re:/Fw:/Fwd: subject) or a calendar invite (text/calendar, Google Calendar as
 * Sender), and goes to 1–5 outside To/Cc recipients (colleagues copied in don't count; Bcc isn't seen), none of them a
 * no-reply address, a known email or on a client's domain. The sync then asks Gmail whether the prospect ever wrote to the mailbox before (priorInbound).
 * `ctx`: { internal, emails, domains } (rpc outreach_gmail_known plus the mailbox's own domains).
 * → { cold: true, prospect, prospectName, recipients, firstAt } or { cold: false, why }
 */
export function coldThread(thread, ctx = {}) {
  const c = gmailContext(ctx);
  const f = firstFacts(thread, c);
  if (!f) return { cold: false, why: 'not ours' };
  if (str(f.h['in-reply-to'])) return { cold: false, why: 'in reply' };
  if (REPLY_SUBJECT.test(f.subject)) return { cold: false, why: 'reply subject' };
  if (f.calendar) return { cold: false, why: 'calendar' };
  if (!f.recipients.length || f.recipients.length > MAX_COLD_RECIPIENTS) return { cold: false, why: 'recipients' };
  for (const r of f.recipients) {
    if (NO_REPLY.test(localOf(r.email))) return { cold: false, why: 'no-reply' };
    if (c.emails.has(r.email)) return { cold: false, why: 'known' };
    if (onDomain(r.email, c.domains)) return { cold: false, why: 'client domain' };
  }
  return { cold: true, prospect: f.prospect.email, prospectName: f.prospect.name, recipients: f.recipients.length, firstAt: f.firstAt };
}

/**
 * A cold thread (format=metadata) → its outreach_threads row and outreach_messages rows, or null when its first message
 * isn't ours. The row: our From address, the prospect (the first outside To recipient, else Cc) and their display name
 * (≤100), the To/Cc count, our first subject (≤200; never a reply's), when we first and last sent and how many we sent,
 * the first reply (and its message id), auto-reply and bounce. Messages: each of ours ('sent') and each reply, auto-reply
 * and bounce; ignored ones give nothing. One of ours after the first counts (sent_count, last_sent_at, a 'sent' row) only
 * when its To or Cc holds someone outside: a note only to colleagues (a forward of the prospect's reply to ops, say) is
 * ignored, and so is one with nobody in To or Cc (Bcc isn't seen). Days are worked out by the database, never here.
 */
export function threadRows(thread, ctx = {}) {
  const c = gmailContext(ctx);
  const threadId = str(thread?.id);
  const f = threadId ? firstFacts(thread, c) : null;
  if (!f) return null;
  const row = {
    thread_id: threadId, sender: f.from, prospect_email: f.prospect.email, prospect_name: clip(f.prospect.name, MAX_NAME),
    recipients: Math.max(1, f.recipients.length), subject: clip(f.subject, MAX_SUBJECT), first_at: f.firstAt, last_sent_at: null,
    sent_count: 0, reply_at: null, reply_message_id: '', auto_at: null, bounce_at: null,
  };
  const messages = [];
  const outside = outsideOf(c);
  for (const m of f.msgs) {
    const at = isoOf(m);
    const id = str(m.id);
    let kind = messageKind(m, c);
    if (kind === 'ours' && m !== f.msgs[0]) {
      const h = headersOf(m);
      if (![...parseAddresses(h.to), ...parseAddresses(h.cc)].some(outside)) kind = 'ignored'; // only to colleagues
    }
    if (!at || !id || kind === 'ignored') continue;
    if (kind === 'ours') {
      row.sent_count++;
      row.last_sent_at = at;
    } else if (kind === 'reply' && !row.reply_at) {
      row.reply_at = at;
      row.reply_message_id = id;
    } else if (kind === 'auto' && !row.auto_at) row.auto_at = at;
    else if (kind === 'bounce' && !row.bounce_at) row.bounce_at = at;
    messages.push({ message_id: id, thread_id: threadId, kind: kind === 'ours' ? 'sent' : kind, at });
  }
  return { thread: row, messages };
}

// ── Mailbox connect and callback ──

// purpose 'mailbox' (admins only, checked by the caller): the consent page for that mailbox's own @assetstackai.com
// account, Gmail read only. include_granted_scopes false, so the mailbox's token never carries anything the account
// granted Cortex before. → { url }
async function mailboxConnect(body, me, cfg, fetch) {
  const origin = allowedOrigin(body.origin, cfg.origins);
  if (!origin) throw new HttpError(400, 'Open Cortex at its own address to connect Google.');
  const mailbox = str(body.mailbox).toLowerCase();
  if (!UUID.test(mailbox)) throw new HttpError(400, 'Choose a mailbox to connect.');
  const email = str(me.email).toLowerCase();
  if (!email) throw new HttpError(400, 'Your Cortex profile has no email.');
  const client = clientFor(cfg, 'default');
  const found = await rest(cfg, fetch, 'connect', `outreach_mailboxes?id=eq.${mailbox}&select=id,active,addresses`, {}, 'Could not read the mailbox.');
  const box = Array.isArray(found) ? found[0] : null;
  if (!box) throw new HttpError(400, MAILBOX_GONE);
  if (box.active !== true) throw new HttpError(400, MAILBOX_INACTIVE);
  const hint = (Array.isArray(box.addresses) ? box.addresses : []).map((a) => str(a).toLowerCase())
    .find((a) => EMAIL.test(a) && domainOf(a) === client.hd);
  if (!hint) throw new HttpError(400, mailboxDomain(client.hd));
  const state = await signState({
    uid: me.uid, email, origin, exp: Math.floor(Date.now() / 1000) + STATE_TTL, nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
    purpose: 'mailbox', mailbox, client: 'default',
  }, cfg.clientSecret);
  const query = new URLSearchParams({
    client_id: client.id,
    redirect_uri: callbackUrl(cfg),
    response_type: 'code',
    scope: MAILBOX_SCOPES,
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'false',
    hd: client.hd,
    login_hint: hint,
    state,
  });
  return { url: `${GOOGLE_AUTH}?${query}` };
}

// A mailbox connect comes back here: → <origin>/#/settings?tab=outreach&gmail=<result>&mailbox=<id>, result connected,
// denied, wrong_account, gmail_scope (Gmail read left unticked: nothing saved), no_refresh_token or
// error&reason=client|exchange|save. The account signed in is the mailbox's (not the admin's): rpc
// outreach_gmail_connect checks it is one of the mailbox's addresses and that the admin still is one.
async function mailboxCallback(url, state, origin, cfg, fetch) {
  const mailbox = str(state.mailbox).toLowerCase();
  if (!UUID.test(mailbox)) return page(400, EXPIRED);
  const back = (result) => redirect(`${origin}/#/settings?tab=outreach&gmail=${result}&mailbox=${mailbox}`);
  const fail = (step) => back(`error&reason=${step}`);
  if (url.searchParams.get('error')) return back('denied');
  const key = str(state.client) || 'default';
  const client = clientFor(cfg, key);
  if (!client) { logFailure('client', 0, { error: 'unknown client' }); return fail('client'); }
  const exchanged = await exchangeCode(url, cfg, fetch, client);
  if (exchanged.step) return fail(exchanged.step);
  const { token } = exchanged;

  const id = jwtPayload(token.id_token);
  const email = str(id?.email).toLowerCase();
  const verified = id?.email_verified === true || id?.email_verified === 'true';
  if (!email || !verified) return back('wrong_account');
  if (!hasGmailRead(token.scope)) return back('gmail_scope');
  if (!str(token.refresh_token)) return back('no_refresh_token');

  try {
    const saved = await fetch(`${cfg.url}/rest/v1/rpc/outreach_gmail_connect`, {
      method: 'POST',
      headers: { ...keyHeaders(cfg.secretKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_mailbox: mailbox, p_email: email, p_token: token.refresh_token, p_scopes: str(token.scope), p_by: state.uid, p_client: key,
      }),
    });
    const answer = await readJson(saved);
    if (saved.ok && answer === 'ok') return back('connected');
    if (saved.ok && answer === 'wrong_account') return back('wrong_account');
    logFailure('save', saved.status, saved.ok ? { error: `answered ${JSON.stringify(answer)}`.slice(0, 60) } : answer);
    return fail('save');
  } catch (e) {
    logFailure('save', 0, { error: str(e?.name) || 'network' });
    return fail('save');
  }
}

// ── Mailbox sync ──

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A Gmail GET → its JSON. A rate limit (429, or 403 with a rate-limit reason) or a passing server error (500, 502, 503,
// 504) waits `backoff` once and tries again; then a rate limit throws RateLimited and a server error GmailServerError (by
// the second answer). A missing scope → 409 (reconnect); 404 → null when `allow404`; anything else → 502 "Gmail returned
// <status>." (Google's message is never kept: it could quote the mailbox).
async function gmailGet(fetch, token, url, { sleep, backoff }, allow404 = false) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    const data = await readJson(res);
    if (res.ok) return data || {};
    const reasons = googleReasons(data);
    const server = GMAIL_TRANSIENT.includes(res.status);
    if (server || res.status === 429 || (res.status === 403 && reasons.some((r) => RATE_REASONS.includes(r)))) {
      if (attempt === 0) {
        await sleep(backoff);
        continue;
      }
      throw server ? new GmailServerError('server error') : new RateLimited('rate limited');
    }
    if (res.status === 404 && allow404) return null;
    if (scopeInsufficient(res.status, data, reasons)) throw new HttpError(409, GMAIL_RECONNECT);
    throw new HttpError(502, `Gmail returned ${res.status}.`);
  }
}

// messages.list for `q`, page after page (at most `pages`) → distinct thread ids, newest first (Gmail's order).
async function listThreads(get, q, pages) {
  const ids = [];
  const seen = new Set();
  let pageToken = '';
  for (let n = 0; n < pages; n++) {
    const params = new URLSearchParams({ q, maxResults: '500', fields: GMAIL_LIST_FIELDS });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await get(`${GMAIL_API}/messages?${params}`);
    for (const m of Array.isArray(data?.messages) ? data.messages : []) {
      const t = str(m?.threadId);
      if (THREAD_ID.test(t) && !seen.has(t)) {
        seen.add(t);
        ids.push(t);
      }
    }
    pageToken = str(data?.nextPageToken);
    if (!pageToken) break;
  }
  return ids;
}

// The messages added since `start` (drafts and chats left out) → { gone: true } when Gmail no longer has that history
// (404), else { events: [{ thread, sent }] newest first, historyId, more }. Finished: historyId = the mailbox's current
// one; stopped at the page cap: the last record read (more true, so the next run carries on from there).
async function readHistory(get, start, pages) {
  const events = [];
  let lastId = '';
  let pageToken = '';
  for (let n = 0; n < pages; n++) {
    const params = new URLSearchParams({ startHistoryId: start, historyTypes: 'messageAdded', maxResults: '500', fields: GMAIL_HISTORY_FIELDS });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await get(`${GMAIL_API}/history?${params}`, true);
    if (data === null) return { gone: true };
    for (const h of Array.isArray(data?.history) ? data.history : []) {
      for (const added of Array.isArray(h?.messagesAdded) ? h.messagesAdded : []) {
        const labels = labelsOf(added?.message);
        const thread = str(added?.message?.threadId);
        if (!THREAD_ID.test(thread) || labels.includes('DRAFT') || labels.includes('CHAT')) continue;
        events.push({ thread, sent: labels.includes('SENT') });
      }
      if (str(h?.id)) lastId = str(h.id);
    }
    pageToken = str(data?.nextPageToken);
    if (!pageToken) return { gone: false, events: events.reverse(), historyId: str(data?.historyId), more: false };
  }
  return { gone: false, events: events.reverse(), historyId: lastId, more: true };
}

// Which of `ids` are this mailbox's stored cold threads (secret key; 100 ids a request). → Set
async function storedThreads(db, mailbox, ids) {
  const out = new Set();
  const list = threadIds(ids);
  for (let i = 0; i < list.length; i += 100) {
    const rows = await db(`outreach_threads?select=thread_id&mailbox_id=eq.${encodeURIComponent(mailbox)}&thread_id=in.(${list.slice(i, i + 100).join(',')})`,
      {}, 'Could not read the stored threads.');
    for (const r of Array.isArray(rows) ? rows : []) out.add(str(r?.thread_id));
  }
  return out;
}

// threads.get with headers only: format=metadata, the headers the rules read, and a fields mask without snippet.
function threadUrl(id) {
  const q = new URLSearchParams({ format: 'metadata' });
  for (const h of GMAIL_METADATA) q.append('metadataHeaders', h);
  q.set('fields', GMAIL_THREAD_FIELDS);
  return `${GMAIL_API}/threads/${encodeURIComponent(id)}?${q}`;
}

// Whether the prospect wrote to this mailbox before our first message (then they aren't a new contact).
async function priorInbound(get, verdict) {
  const before = Math.floor(Date.parse(verdict.firstAt) / 1000);
  const q = new URLSearchParams({ q: `from:${verdict.prospect} before:${before}`, maxResults: '1', fields: 'messages(id)' });
  const data = await get(`${GMAIL_API}/messages?${q}`);
  return Array.isArray(data?.messages) && data.messages.length > 0;
}

// Runs `worker(item, index)` over `items`, `n` at a time; every worker finishes. → the first error thrown, or null.
async function pool(items, n, worker) {
  let next = 0;
  let failure = null;
  const lane = async () => {
    while (next < items.length && !failure) {
      const k = next++;
      try {
        await worker(items[k], k);
      } catch (e) {
        failure = failure || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, lane));
  return failure;
}

// A failure → what is saved for the mailbox: { error (short, never a token), reconnect }.
function gmailError(e, secrets = []) {
  if (e instanceof RateLimited) return { error: GMAIL_BUSY, reconnect: false };
  if (!(e instanceof HttpError)) return { error: GMAIL_FAILED, reconnect: false };
  let message = e.message;
  for (const s of secrets) if (s) message = message.split(s).join('…');
  return { error: clip(message.replace(/\s+/g, ' ').trim(), 200) || GMAIL_FAILED, reconnect: e.status === 409 };
}

// rpc outreach_gmail_known (+ the mailbox's own domains) → the classification context.
function knownContext(known, addresses) {
  const list = (v) => (Array.isArray(v) ? v : []);
  return gmailContext({
    internal: [...list(known?.internal), ...list(addresses).map(domainOf).filter(Boolean)], emails: list(known?.emails), domains: list(known?.domains),
  });
}

// One claimed mailbox: what to read (a first read of the last 90 days of sent mail, Gmail's history since the last run,
// or a restart when that history is gone), then the queued threads newest first, saved every `saveEvery` threads with the
// rest of the queue as the cursor. Stopped by its deadline with more to read: the last save releases the claim and more
// is true (call again now). Stopped by a rate limit: the claim is held (due again after its gap) and more is false, so a
// Sync now chain doesn't hammer a limited Gmail. A thread Gmail answers with a server error twice (its read or its
// prior-inbound check) goes to the back of the saved queue with its count in cursor.failures (job.failures in: { n, at });
// a failure counts (n + 1, at now) only when there is no count yet or the last counted one is GMAIL_FAILURE_SPACING old,
// so runs a minute or seconds apart never add up. At GMAIL_THREAD_FAILURES counted failures it is dropped, and a read
// clears it. GMAIL_SERVER_STOP of them in a run stop the mailbox as a rate limit. Only such threads left: more is false and
// the claim is held too (tried again after the gap, not at once).
// → { status: 'synced' | 'failed' | 'skipped', more, pending }
async function gmailMailbox(id, run) {
  const { cfg, fetch, db, lim, now, sleep, until } = run;
  let started = new Date(run.claimedAt + START_MARGIN).toISOString();
  let pending = [];
  let queue = 0; // the queue as last saved (or as the job read it): what a failed run leaves pending
  let serverErrors = 0; // thread reads that ended in a Gmail server error this run (logged as a count)
  let dropped = 0; // of those, threads dropped at GMAIL_THREAD_FAILURES counted failures (logged as a count)
  let refresh = '';
  let token = '';
  let step = 'job';
  const save = (fields) => db('rpc/outreach_gmail_save', {
    method: 'POST',
    body: {
      p_mailbox: id, p_started: started, p_threads: fields.threads || [], p_messages: fields.messages || [], p_cursor: fields.cursor || {},
      p_release: fields.release === true, p_error: fields.error || '', p_reconnect: fields.reconnect === true,
    },
  }, 'Could not save the Gmail sync.');
  try {
    if (!run.known || typeof run.known !== 'object' || Array.isArray(run.known)) throw new HttpError(502, GMAIL_NO_KNOWN);
    const job = await db('rpc/outreach_gmail_job', { method: 'POST', body: { p_mailbox: id } }, 'Could not read the mailbox’s connection.');
    if (!job || typeof job !== 'object' || Array.isArray(job)) return { status: 'skipped', more: false, pending: 0 }; // not connected
    if (validTime(job.run_started)) started = job.run_started; // the claim's own time, when the job gives it
    pending = threadIds(job.pending);
    queue = pending.length;
    const failures = failureCounts(job.failures);
    refresh = str(job.refresh_token);
    const email = str(job.email).toLowerCase();
    const client = clientFor(cfg, str(job.client) || 'default');
    if (!client || !refresh || !EMAIL.test(email) || !hasGmailRead(job.scopes)) throw new HttpError(409, GMAIL_RECONNECT);
    step = 'token';
    token = await refreshAccess(fetch, client, refresh, GMAIL_RECONNECT);
    const ctx = knownContext(run.known, job.addresses);
    const get = (url, allow404) => gmailGet(fetch, token, url, { sleep, backoff: lim.backoff }, allow404);
    const stored = (ids) => storedThreads(db, id, ids);

    // 1. What to read.
    const fromScratch = async (fromMs, touched) => {
      step = 'profile';
      const profile = await get(`${GMAIL_API}/profile`);
      if (str(profile?.emailAddress).toLowerCase() !== email) throw new HttpError(409, GMAIL_OTHER_ACCOUNT);
      step = 'list';
      const after = Math.floor(fromMs / 1000);
      let ids = await listThreads(get, `in:sent after:${after}`, lim.listPages);
      if (touched) {
        const inbound = await listThreads(get, `-in:sent after:${after}`, lim.listPages);
        const keep = inbound.length ? await stored(inbound) : new Set();
        ids = unique([...ids, ...inbound.filter((t) => keep.has(t))]);
      }
      return { ids, historyId: str(profile?.historyId) || null };
    };
    let queued;
    let cursor;
    let historyMore = false;
    const history = str(job.history_id);
    if (!history) {
      const fromMs = now() - LOOKBACK_DAYS * DAY_MS;
      const r = await fromScratch(fromMs, false);
      queued = r.ids;
      cursor = { history_id: r.historyId, scan_from: new Date(fromMs).toISOString() };
    } else {
      step = 'history';
      const h = await readHistory(get, history, lim.historyPages);
      if (h.gone) {
        const last = Date.parse(str(job.synced_at));
        const fromMs = Math.max(Number.isFinite(last) ? last - RESTART_OVERLAP_DAYS * DAY_MS : 0, now() - LOOKBACK_DAYS * DAY_MS);
        const r = await fromScratch(fromMs, true);
        queued = r.ids;
        cursor = { history_id: r.historyId, ...(validTime(job.scan_from) ? {} : { scan_from: new Date(fromMs).toISOString() }) };
      } else {
        const inbound = unique(h.events.filter((e) => !e.sent).map((e) => e.thread));
        const keep = inbound.length ? await stored(inbound) : new Set();
        queued = unique(h.events.filter((e) => e.sent || keep.has(e.thread)).map((e) => e.thread));
        cursor = { history_id: h.historyId || null };
        historyMore = h.more;
      }
    }
    pending = unique([...queued, ...pending]);

    // 2. The queued threads, newest first: a stored cold thread is refreshed; any other is kept only when it is cold.
    step = 'threads';
    const batch = pending.slice(0, lim.threadsPerRun);
    const cold = batch.length ? await stored(batch) : new Set();
    const done = new Set();
    const later = new Set(); // answered a server error this run: to the back of the queue
    let stop = false; // the deadline, or a rate limit
    let limited = false; // a rate limit (or GMAIL_SERVER_STOP server errors): hold the claim, no more this chain
    for (let i = 0; ; i += lim.saveEvery) {
      const chunk = batch.slice(i, i + lim.saveEvery);
      const rows = new Array(chunk.length).fill(null);
      const failure = await pool(chunk, lim.parallel, async (tid, k) => {
        if (stop) return;
        if (now() >= until) {
          stop = true;
          return;
        }
        try {
          const thread = await get(threadUrl(tid), true);
          if (thread && cold.has(tid)) rows[k] = threadRows(thread, ctx);
          else if (thread) {
            const verdict = coldThread(thread, ctx);
            if (verdict.cold && !(await priorInbound(get, verdict))) rows[k] = threadRows(thread, ctx);
          }
          done.add(tid); // read (or gone from Gmail: 404): no longer queued, so its count goes
        } catch (e) {
          if (!(e instanceof RateLimited)) throw e;
          if (e instanceof GmailServerError) {
            serverErrors++;
            const was = failures.get(tid);
            const at = now();
            const spaced = !was || !validTime(was.at) || at - Date.parse(was.at) >= GMAIL_FAILURE_SPACING;
            const entry = spaced ? { n: (was ? was.n : 0) + 1, at: new Date(at).toISOString() } : was; // else not counted again
            if (entry.n >= GMAIL_THREAD_FAILURES) {
              done.add(tid); // given up on, as a 404
              dropped++;
            } else {
              failures.set(tid, entry);
              later.add(tid); // never the front of the queue: the others go first
            }
            if (serverErrors < GMAIL_SERVER_STOP) return;
          }
          stop = true;
          limited = true;
        }
      });
      if (failure) throw failure;
      const left = pending.filter((t) => !done.has(t));
      const remaining = [...left.filter((t) => !later.has(t)), ...left.filter((t) => later.has(t))];
      const last = stop || i + lim.saveEvery >= batch.length;
      const more = last && !limited && (remaining.length > later.size || historyMore);
      const kept = rows.filter(Boolean);
      const counts = Object.fromEntries(remaining.filter((t) => failures.has(t)).map((t) => [t, failureOut(failures.get(t))]));
      step = 'save';
      const saved = await save({
        threads: kept.map((r) => r.thread), messages: kept.flatMap((r) => r.messages), cursor: { ...cursor, pending: remaining, failures: counts },
        release: more,
      });
      if (saved !== true) return { status: 'skipped', more: false, pending: 0 }; // no longer connected or active
      queue = remaining.length;
      if (last) return { status: 'synced', more, pending: queue };
      cursor = {};
      step = 'threads';
    }
  } catch (e) {
    const { error, reconnect } = gmailError(e, [token, refresh]);
    console.error('google/outreach-gmail-sync: mailbox failed at', step, e instanceof RateLimited ? 'rate limited' : e instanceof HttpError ? e.status : str(e?.name) || 'Error');
    try {
      await save({ error, reconnect });
    } catch {
      // logged by rest(); the mailbox counts as failed either way
    }
    return { status: 'failed', more: false, pending: queue };
  } finally {
    if (serverErrors) {
      const stopped = serverErrors >= GMAIL_SERVER_STOP ? ', mailbox stopped' : '';
      console.error(`google/outreach-gmail-sync: a Gmail server error on ${serverErrors} thread(s), ${dropped} dropped${stopped}`);
    }
  }
}

// p_gap (seconds) for rpc outreach_gmail_claim: 600, or 60 when forced. A forced call later in a Sync now chain (one that
// passes back the chain's `since`) uses the time since the chain started plus 5 s instead (60 to 600), so a mailbox
// already claimed in this chain isn't due again in it (each run can last the whole deadline), while a released one
// (claimed_at null) or one last claimed over a minute before the chain still is.
function claimGap(force, since, nowMs) {
  if (!force) return 600;
  if (since === null) return 60;
  return Math.min(600, Math.max(60, Math.ceil((nowMs - since) / 1000) + 5));
}

// Claims the connected mailboxes whose turn it is (not read in the last 10 minutes, or 1 minute when forced, or since
// the chain started: claimGap(); at most three) and reads them one at a time, each with its own Google account and its
// share of the run's time. One mailbox's failure (saved as its error, with reconnect when its connection needs it) never
// stops the others. more: the client may call again straight away (a Sync now chain passes force and the first answer's
// since on each call), because a mailbox stopped by its deadline has more to read and its claim was released, or the
// claim was full (p_limit mailboxes), so others may be due; a call that claims nothing answers more false, and a mailbox
// stopped by a rate limit adds no more. since: body.since when it is a valid time not in the future, else now (the
// chain's first call).
async function gmailSync(body, cfg, fetch, { limits = {}, now = Date.now, sleep = pause } = {}) {
  const lim = { ...GMAIL_LIMITS, ...limits };
  const start = now();
  const end = start + lim.deadline;
  const given = validTime(body.since) && Date.parse(body.since) <= start ? Date.parse(body.since) : null;
  const db = (path, init, fail) => rest(cfg, fetch, 'outreach-gmail-sync', path, init, fail);
  const claimed = claimedIds(await db('rpc/outreach_gmail_claim', {
    method: 'POST', body: { p_gap: claimGap(body.force === true, given, start), p_limit: lim.mailboxes },
  }, 'Could not start the Gmail sync.'));
  const claimedAt = now();
  const since = new Date(given ?? start).toISOString();
  const result = { ok: true, claimed: claimed.length, synced: 0, failed: 0, more: false, pending: 0, since };
  if (!claimed.length) return result;
  let known = null;
  try {
    known = await db('rpc/outreach_gmail_known', { method: 'POST', body: {} }, GMAIL_NO_KNOWN);
  } catch {
    known = null; // each mailbox saves the error
  }
  for (let i = 0; i < claimed.length; i++) {
    const until = now() + Math.max(0, end - now()) / (claimed.length - i);
    const r = await gmailMailbox(claimed[i], { cfg, fetch, db, lim, now, sleep, known, until, claimedAt });
    if (r.status === 'synced') result.synced++;
    else if (r.status === 'failed') result.failed++;
    result.more = result.more || r.more;
    result.pending += r.pending;
  }
  if (claimed.length >= lim.mailboxes) result.more = true; // others may be due
  return result;
}

// ── Entry ───────────────────────────────────────────────────────────────────────────────────────────────────────

// `limits` (GMAIL_LIMITS overrides), `now` (ms) and `sleep` are only for tests of outreach-gmail-sync.
export async function handle(req, { env = {}, fetch = globalThis.fetch, limits = {}, now = Date.now, sleep = pause } = {}) {
  const cfg = config(env);
  const origin = allowedOrigin(req.headers.get('origin'), cfg.origins);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

  const url = new URL(req.url);
  const route = url.pathname.split('/').filter(Boolean).pop() || '';
  const method = Object.hasOwn(ROUTES, route) ? ROUTES[route] : '';
  if (!method) return json(404, { error: 'Not found.' }, origin);
  if (req.method !== method) return json(405, { error: 'Method not allowed.' }, origin, { Allow: `${method}, OPTIONS` });

  const missing = missingSettings(cfg);
  if (missing.length) {
    const msg = `Google isn’t set up yet (missing ${missing.join(', ')}).`;
    return route === 'callback' ? page(500, msg) : json(500, { error: msg }, origin);
  }

  try {
    if (route === 'callback') return await callback(url, cfg, fetch);
    if (route === 'outreach-sync') {
      await outreachCaller(req, cfg, fetch);
      await readBody(req);
      return json(200, await outreachSync(cfg, fetch), origin);
    }
    if (route === 'calendar-sync') {
      await staffCaller(req, cfg, fetch);
      return json(200, await calendarSync(await readBody(req), cfg, fetch), origin);
    }
    if (route === 'outreach-gmail-sync') {
      await outreachCaller(req, cfg, fetch);
      return json(200, await gmailSync(await readBody(req), cfg, fetch, { limits, now, sleep }), origin);
    }
    if (route === 'task-mail') {
      await staffCaller(req, cfg, fetch);
      await readBody(req);
      return json(200, await taskMail(cfg, fetch, origin), origin);
    }
    if (route === 'connect') {
      // Any staff member may connect their calendar; anything else (a mailbox's Gmail too) stays admins only.
      const me = await staffCaller(req, cfg, fetch);
      const body = await readBody(req);
      if (body.purpose !== 'calendar') adminOnly(me);
      if (body.purpose === 'mailbox') return json(200, await mailboxConnect(body, me, cfg, fetch), origin);
      return json(200, await connect(body, me, cfg), origin);
    }
    const me = await caller(req, cfg, fetch);
    const body = await readBody(req);
    if (route === 'send') return json(200, await send(body, me, cfg, fetch), origin);
    return json(200, await contract(body, me, cfg, fetch), origin);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message }, origin);
    console.error(`google/${route}:`, e?.name || 'Error', e?.message || ''); // never the request or a token
    if (route === 'callback') return page(500, 'Something went wrong. Go back to Cortex and try again.');
    return json(500, { error: 'Something went wrong with Google. Try again.' }, origin);
  }
}

if (globalThis.Deno?.serve) Deno.serve((req) => handle(req, { env: Deno.env.toObject(), fetch: globalThis.fetch }));
