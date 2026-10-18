// @ts-nocheck
// Cortex `google` Edge Function: Gmail, Drive and Docs as the calling admin's OWN Google account.
// One self-contained file with no imports, so it can be pasted into the Supabase dashboard editor (Edge Functions →
// google); plain JavaScript in a .ts file, so scripts/test-google.mjs imports it in Node. Web APIs only.
//
// Routes (on the last path segment, so /google/send and /functions/v1/google/send both work):
//   POST connect  {origin}                               → {url}: Google's consent page (comes back to callback)
//   GET  callback ?code&state                            → 302 to <origin>/#/settings?tab=business&google=…
//   POST send     {to, subject, text, attachment?}       → {id, from}: sent from the caller's own Gmail
//   POST contract {template, folder, name, replacements} → {id, name, url}: the template copied into the folder, filled in
//   POST outreach-sync {}                                → {ok, stats}: the outreach agent's sheet into outreach_emails,
//                                                          then its Summary and Notes tabs written back (docs/PHASE2.md §12)
//
// JWT verification is OFF for this function (Google's callback carries no JWT), so it checks callers itself: the
// caller's JWT goes to rpc google_me (admins only), or rpc outreach_access for outreach-sync (anyone who can see
// Outreach; the sheet is read with the Google account of the admin who set its link), and PostgREST decides who that
// is. Refresh tokens are read and saved with the secret key (rpc google_token / google_save), which exists only in the
// function runtime; so are the outreach tables the sync writes.
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

const ROUTES = { connect: 'POST', callback: 'GET', send: 'POST', contract: 'POST', 'outreach-sync': 'POST' };
const EXPIRED = 'This sign-in link has expired. Go back to Cortex and try again.';
const NOT_CONNECTED = 'Connect your Google account in Settings first.';
const RECONNECT = 'Reconnect your Google account in Settings.';
const NOT_FOUND = 'Template or folder not found, or not shared with your Google account.';
const NO_OUTREACH = 'You don’t have access to Outreach.';
const NO_SHEET = 'Add the outreach sheet in Settings → Outreach.';
const NO_SHEET_BY = 'Ask an admin to click Use my Google in Settings → Outreach.';
const SYNC_FAILED = 'Something went wrong with Google. Try again.';

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

// A Google API call → its JSON, or an HttpError: missing scope → 409 (reconnect), 404 → `notFound` and any other 403
// (not shared; but not an API that is turned off) → `forbidden` when given, anything else → 502 with Google's message.
async function google(fetch, url, init, notFound = '', forbidden = '') {
  const res = await fetch(url, init);
  const data = await readJson(res);
  if (res.ok) return data || {};
  const msg = googleMessage(data);
  const reasons = (data?.error?.details || []).map((d) => d?.reason).concat((data?.error?.errors || []).map((e) => e?.reason));
  if (res.status === 403 && (reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || reasons.includes('insufficientPermissions')
      || /insufficient authentication scopes/i.test(msg))) {
    throw new HttpError(409, 'Reconnect your Google account in Settings and allow Gmail and Drive.');
  }
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

// Admins, through rpc google_me. → { uid, name, email, admin, google_email }
async function caller(req, cfg, fetch) {
  const data = await callerRpc(req, cfg, fetch, 'google_me', 'Your Cortex account can’t use Google.');
  if (!data || !str(data.uid)) throw new HttpError(403, 'Your Cortex account can’t use Google.');
  if (data.admin !== true) throw new HttpError(403, 'Only admins can use Google from Cortex.');
  return data;
}

// Anyone who can see Outreach, through rpc outreach_access (can_view('outreach'): active staff with view or edit).
async function outreachCaller(req, cfg, fetch) {
  const data = await callerRpc(req, cfg, fetch, 'outreach_access', NO_OUTREACH);
  if (data?.view !== true) throw new HttpError(403, NO_OUTREACH);
  return data;
}

// A user's stored refresh token (the caller's, or for outreach-sync the admin who set the sheet) → a fresh access
// token. `text` rewords the failures for someone else's account. → { token, email }
async function googleAccess(cfg, fetch, me, text = {}) {
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

  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: account.refresh_token, grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await readJson(res);
  if (data?.error === 'invalid_grant') throw new HttpError(409, say.reconnect);
  if (!res.ok || !str(data?.access_token)) throw new HttpError(502, googleMessage(data) || 'Google sign-in failed.');
  return { token: data.access_token, email };
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────────────────────

const callbackUrl = (cfg) => `${cfg.url}/functions/v1/google/callback`;

async function connect(body, me, cfg) {
  const origin = allowedOrigin(body.origin, cfg.origins);
  if (!origin) throw new HttpError(400, 'Open Cortex at its own address to connect Google.');
  const email = str(me.email).toLowerCase();
  if (!email) throw new HttpError(400, 'Your Cortex profile has no email.');
  const state = await signState({
    uid: me.uid, email, origin, exp: Math.floor(Date.now() / 1000) + STATE_TTL,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
  }, cfg.clientSecret);
  const query = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl(cfg),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    hd: DOMAIN,
    login_hint: email,
    state,
  });
  return { url: `${GOOGLE_AUTH}?${query}` };
}

// Google sends the browser here. Only a valid state says where Cortex is; anything else gets a plain page.
async function callback(url, cfg, fetch) {
  const state = await verifyState(url.searchParams.get('state'), cfg.clientSecret);
  const origin = state ? allowedOrigin(state.origin, cfg.origins) : '';
  if (!origin) return page(400, EXPIRED);
  const back = (result) => redirect(`${origin}/#/settings?tab=business&google=${result}`);
  const fail = (reason) => back(`error&reason=${reason}`);

  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code) return fail('exchange');

  let token;
  try {
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: callbackUrl(cfg), grant_type: 'authorization_code',
      }).toString(),
    });
    token = await readJson(res);
    if (!res.ok || !token || token.error) return fail('exchange');
  } catch {
    return fail('exchange');
  }

  // You can only connect your own account: the one Google signed in must be your Cortex email, and verified.
  const id = jwtPayload(token.id_token);
  const email = str(id?.email).toLowerCase();
  const verified = id?.email_verified === true || id?.email_verified === 'true';
  if (!email || !verified || email !== str(state.email).toLowerCase()) return fail('wrong_account');
  if (!str(token.refresh_token)) return fail('no_refresh_token');

  try {
    const saved = await fetch(`${cfg.url}/rest/v1/rpc/google_save`, {
      method: 'POST',
      headers: { ...keyHeaders(cfg.secretKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: state.uid, p_email: email, p_token: token.refresh_token, p_scopes: str(token.scope) }),
    });
    if (!saved.ok) return fail('save');
  } catch {
    return fail('save');
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
const OWN_TABS = ['Summary', 'Notes']; // written by the sync, never read as the agent's rows
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
 * → { rows, duplicates, skipped, known (row 1 has at least one of the agent's columns) }
 */
export function sheetRows(values) {
  const [head, ...body] = Array.isArray(values) && values.length ? values : [[]];
  const headers = (Array.isArray(head) ? head : []).map(str);
  const col = new Map();
  headers.forEach((h, i) => {
    const k = h.toLowerCase();
    if (k && !col.has(k)) col.set(k, i);
  });
  const byKey = new Map();
  let duplicates = 0;
  let skipped = 0;
  for (const line of body) {
    const cells = (Array.isArray(line) ? line : []).map(str);
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
    byKey.set(row.row_key, row);
  }
  return { rows: [...byKey.values()], duplicates, skipped, known: headers.some((h) => KNOWN_HEADERS.has(h.toLowerCase())) };
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

// PostgREST with the secret key (no RLS). → its JSON; a failure → 502 `fail` (PostgREST's own message is only logged).
async function rest(cfg, fetch, path, { method = 'GET', body, prefer = '' } = {}, fail = 'Could not reach the database.') {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    headers: {
      ...keyHeaders(cfg.secretKey), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    console.error(`google/outreach-sync: ${method} ${path.split('?')[0]} → ${res.status}`, str(data?.code), str(data?.message).slice(0, 200));
    throw new HttpError(502, fail);
  }
  return data;
}

// The sheet → outreach_emails (rows no longer in it keep their data, with in_sheet false) → the Summary and Notes tabs
// → outreach_settings (synced_at, sync_stats). A failure once a link and its admin are set is saved as sync_error.
// There is no lock: two syncs can overlap (two people open Outreach at once). 0007's keep_newer_sync trigger skips an
// older sync's writes over a newer one's rows, so neither flags rows the other read as gone; the results are saved
// only when no newer sync has saved its own; and tabs the other one just added are found again.
async function outreachSync(cfg, fetch) {
  const start = new Date().toISOString();
  const db = (path, init, fail) => rest(cfg, fetch, path, init, fail);
  const settings = await db('outreach_settings?id=eq.1&select=sheet_url,sheet_by', {}, 'Could not read the outreach settings.');
  const set = Array.isArray(settings) ? settings[0] : null;
  if (!str(set?.sheet_url)) throw new HttpError(400, NO_SHEET);
  if (!str(set?.sheet_by)) throw new HttpError(400, NO_SHEET_BY);

  let token = '';
  try {
    const sheet = sheetFromUrl(set.sheet_url);
    if (!sheet.id) throw new HttpError(400, 'The outreach sheet isn’t a Google Sheets link. Check it in Settings → Outreach.');

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

    // The agent's tab: the one in the link, else the first that isn't Summary or Notes.
    const meta = await sheets(`${base}?fields=sheets.properties`, { method: 'GET' }, { notFound: unshared, forbidden: unshared });
    const tabs = (Array.isArray(meta.sheets) ? meta.sheets : []).map((s) => s?.properties).filter((p) => p && typeof p.title === 'string');
    const tabNamed = (title) => tabs.find((p) => p.title.trim().toLowerCase() === title.toLowerCase());
    const own = (p) => OWN_TABS.some((t) => tabNamed(t) === p);
    const tab = (sheet.gid && tabs.find((p) => String(p.sheetId) === sheet.gid && !own(p))) || tabs.find((p) => !own(p));
    if (!tab) throw new HttpError(400, 'The outreach sheet has no tab to read.');
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
    // Every row this sync didn't write is no longer in the sheet.
    const gone = await db(`outreach_emails?synced_at=lt.${start}&in_sheet=eq.true&select=id`, {
      method: 'PATCH', body: { in_sheet: false }, prefer: 'return=representation',
    }, 'Could not update the outreach emails.');

    // Write back: Summary and Notes (added when missing), cleared and rewritten as plain values.
    const missingTabs = OWN_TABS.filter((t) => !tabNamed(t));
    if (missingTabs.length) {
      try {
        await sheets(`${base}:batchUpdate`, {
          method: 'POST', body: JSON.stringify({ requests: missingTabs.map((title) => ({ addSheet: { properties: { title } } })) }),
        }, { forbidden: readOnly });
      } catch (e) {
        // Another sync running at the same time may have just added them: carry on if they're there now.
        const again = await sheets(`${base}?fields=sheets.properties`, { method: 'GET' }, { notFound: unshared, forbidden: unshared });
        const titles = (Array.isArray(again.sheets) ? again.sheets : []).map((x) => str(x?.properties?.title).trim().toLowerCase());
        if (!missingTabs.every((t) => titles.includes(t.toLowerCase()))) throw e;
      }
    }
    const notes = await db('outreach_notes?select=mailbox_id,pinned,body,author_id,created_at', {}, 'Could not read the outreach notes.');
    const noteList = Array.isArray(notes) ? notes : [];
    const authors = [...new Set(noteList.map((n) => str(n.author_id)).filter(Boolean))];
    const people = authors.length
      ? await db(`profiles?select=id,name&id=in.(${authors.map(encodeURIComponent).join(',')})`, {}, 'Could not read the note authors.')
      : [];
    const names = Object.fromEntries((Array.isArray(people) ? people : []).map((p) => [p.id, str(p.name)]));
    for (const [title, values] of [['Summary', summaryValues(rows, boxes)], ['Notes', notesValues(noteList, boxes, names)]]) {
      const range = quoteTab(tabNamed(title)?.title ?? title);
      await sheets(`${base}/values/${encodeURIComponent(range)}:clear`, { method: 'POST', body: '{}' }, { forbidden: readOnly });
      await sheets(`${base}/values/${encodeURIComponent(`${range}!A1`)}?valueInputOption=RAW`, {
        method: 'PUT', body: JSON.stringify({ majorDimension: 'ROWS', values }),
      }, { forbidden: readOnly });
    }

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
    };
    // Unless a newer sync has already saved its results.
    await db(`outreach_settings?id=eq.1&or=(synced_at.is.null,synced_at.lt.${encodeURIComponent(start)})`, {
      method: 'PATCH', body: { synced_at: start, sync_error: '', sync_stats: stats }, prefer: 'return=minimal',
    }, 'Could not save the sync results.');
    return { ok: true, stats };
  } catch (e) {
    // Saved for Settings → Outreach: a short message of ours, never a token or Google's payload.
    let message = e instanceof HttpError ? e.message : SYNC_FAILED;
    if (token) message = message.split(token).join('…');
    message = message.replace(/\s+/g, ' ').trim().slice(0, 500) || SYNC_FAILED;
    try {
      await db('outreach_settings?id=eq.1', { method: 'PATCH', body: { sync_error: message }, prefer: 'return=minimal' }, '');
    } catch {
      // the caller gets the error either way
    }
    throw e instanceof HttpError ? new HttpError(e.status, message) : e;
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────────────────────────────────────────

export async function handle(req, { env = {}, fetch = globalThis.fetch } = {}) {
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
    const me = await caller(req, cfg, fetch);
    const body = await readBody(req);
    if (route === 'connect') return json(200, await connect(body, me, cfg), origin);
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
