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
//
// JWT verification is OFF for this function (Google's callback carries no JWT), so it checks callers itself: the
// caller's JWT goes to rpc google_me, and PostgREST decides who that is. Refresh tokens are read and saved with the
// secret key (rpc google_token / google_save), which exists only in the function runtime.
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

const ROUTES = { connect: 'POST', callback: 'GET', send: 'POST', contract: 'POST' };
const EXPIRED = 'This sign-in link has expired. Go back to Cortex and try again.';
const NOT_CONNECTED = 'Connect your Google account in Settings first.';
const RECONNECT = 'Reconnect your Google account in Settings.';
const NOT_FOUND = 'Template or folder not found, or not shared with your Google account.';

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

// A Google API call → its JSON, or an HttpError: missing scope → 409 (reconnect), 404 → `notFound` when given,
// anything else → 502 with Google's message.
async function google(fetch, url, init, notFound = '') {
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
  throw new HttpError(502, msg || `Google returned ${res.status}.`);
}

// ── Who is calling ──────────────────────────────────────────────────────────────────────────────────────────────

// The caller's own JWT goes to rpc google_me, so PostgREST verifies it. → { uid, name, email, admin, google_email }
async function caller(req, cfg, fetch) {
  const auth = str(req.headers.get('authorization'));
  if (!auth) throw new HttpError(401, 'Sign in to Cortex first.');
  const res = await fetch(`${cfg.url}/rest/v1/rpc/google_me`, {
    method: 'POST',
    headers: { apikey: cfg.publishableKey, Authorization: auth, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await readJson(res);
  if (!res.ok) {
    const code = str(data?.code);
    const jwtError = /jwt|jws/i.test(`${data?.message ?? ''} ${data?.msg ?? ''}`) || code.startsWith('PGRST3');
    if (res.status === 401 || (res.status === 403 && code !== '42501' && jwtError)) throw new HttpError(401, 'Sign in to Cortex again.');
    if (code === '42501' || res.status === 403) throw new HttpError(403, 'Your Cortex account can’t use Google.');
    throw new HttpError(502, 'Could not check your Cortex account.');
  }
  if (!data || !str(data.uid)) throw new HttpError(403, 'Your Cortex account can’t use Google.');
  if (data.admin !== true) throw new HttpError(403, 'Only admins can use Google from Cortex.');
  return data;
}

// The caller's stored refresh token → a fresh access token. → { token, email }
async function googleAccess(cfg, fetch, me) {
  const stored = await fetch(`${cfg.url}/rest/v1/rpc/google_token`, {
    method: 'POST',
    headers: { ...keyHeaders(cfg.secretKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_user: me.uid }),
  });
  if (!stored.ok) throw new HttpError(502, 'Could not read your Google connection.');
  const account = await readJson(stored);
  if (!str(account?.refresh_token)) throw new HttpError(409, NOT_CONNECTED);
  const email = str(account.email).toLowerCase();
  if (!EMAIL.test(email) || !ASCII.test(email)) throw new HttpError(409, RECONNECT);

  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: account.refresh_token, grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await readJson(res);
  if (data?.error === 'invalid_grant') throw new HttpError(409, RECONNECT);
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
