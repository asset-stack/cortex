// Checks the google Edge Function (supabase/functions/google/index.ts) without a network: node scripts/test-google.mjs
// The function is plain JavaScript in a .ts file (so it can be pasted into the Supabase dashboard); a load hook hands it
// to Node as an ES module. PostgREST and Google are a fake fetch that answers per URL and records every call.
// Covers CORS, the caller check, connect / callback (signed state, your own account only), send (validation and the
// MIME message Gmail gets), contract (Drive copy, .docx conversion, placeholders), outreach-sync (the agent's sheet
// into outreach_emails, the Summary, Notes and mailbox tabs back, never over the agent's tab, sync_error) and the
// calendar (a staff member's calendar connect and callback, which alone opts in with calendar_share; calendar-sync:
// claim, events.list, the rows calendar_save gets, reconnects and per-person failures) and Outreach from Gmail (a
// mailbox connect and its callback; outreach-gmail-sync: claim, first read, history, restart, the headers-only thread
// read, the cold rule and message kinds, caps, deadline, rate limits and server errors, a chain's since and claim gap,
// the save bodies, per-mailbox failures; never a token, body, snippet or reply subject saved, and no address or subject
// logged). Exits non-zero when any check fails.
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(`data:text/javascript,${encodeURIComponent(`
  import { readFile } from 'node:fs/promises';
  export async function load(url, context, next) {
    if (url.endsWith('.ts')) return { format: 'module', source: await readFile(new URL(url), 'utf8'), shortCircuit: true };
    return next(url, context);
  }
`)}`);
const g = await import('../supabase/functions/google/index.ts');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n  ${String(e?.stack || e).split('\n').slice(0, 12).join('\n  ')}`);
  }
}

// ── Fixtures (placeholders only: no real keys, accounts or addresses) ──────────────────────────────────────────────

const SUPABASE = 'https://cortex-test.supabase.co';
const ORIGIN = 'https://cortex.assetstackai.com';
const SECRET = 'test-google-client-secret';
const ENV = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_test' }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_test' }),
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: SECRET,
};
// A project still on the legacy JWT-style keys (and a malformed SUPABASE_PUBLISHABLE_KEYS, which is ignored).
const LEGACY_ENV = {
  ...ENV, SUPABASE_PUBLISHABLE_KEYS: '{"default":', SUPABASE_SECRET_KEYS: '',
  SUPABASE_ANON_KEY: 'eyJ.anon.placeholder', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.service.placeholder',
};
const USER_JWT = 'Bearer user-session-jwt';
const ME = { uid: 'u-ana', name: 'Ana Example', email: 'ana@example.com', admin: true, google_email: '', connected_at: null };

const RPC = `${SUPABASE}/rest/v1/rpc`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const MIME_DOC = 'application/vnd.google-apps.document';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEMPLATE = '1TemplateDocId_abcdefghijklmnopqrstu';
const FOLDER = '1FolderId-abcdefghijklmnopqrstuvwxyz';
const NEW_DOC = '1NewDocId_abcdefghijklmnopqrstuvwxy';
const EXPIRED = 'This sign-in link has expired. Go back to Cortex and try again.';

const now = () => Math.floor(Date.now() / 1000);
const b64url = (s) => Buffer.from(s).toString('base64url');
const idToken = (claims) => ['eyJhbGciOiJSUzI1NiJ9', b64url(JSON.stringify({
  iss: 'https://accounts.google.com', aud: ENV.GOOGLE_CLIENT_ID, sub: '1001', email: 'ana@example.com', email_verified: true, ...claims,
})), 'not-checked'].join('.');
const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

// Answers per URL prefix (the longest that matches); every call is recorded with its headers and body.
const defaults = () => ({
  [`${RPC}/google_me`]: () => reply(200, ME),
  [`${RPC}/google_token`]: () => reply(200, { email: 'ana@example.com', refresh_token: 'stored-refresh-token', scopes: g.SCOPES }),
  [`${RPC}/google_save`]: () => new Response(null, { status: 204 }),
  [`${RPC}/calendar_share`]: () => reply(200, true),
  [TOKEN_URL]: (c) => (c.form.get('grant_type') === 'refresh_token'
    ? reply(200, { access_token: 'fresh-access-token', expires_in: 3599, token_type: 'Bearer' })
    : reply(200, {
      access_token: 'first-access-token', refresh_token: 'new-refresh-token', scope: g.SCOPES, token_type: 'Bearer', id_token: idToken({}),
    })),
  [GMAIL]: () => reply(200, { id: 'msg-1', threadId: 'thread-1', labelIds: ['SENT'] }),
  [`${DRIVE}/${TEMPLATE}?`]: () => reply(200, { id: TEMPLATE, name: 'Contract template', mimeType: MIME_DOC }),
  [`${DRIVE}/${TEMPLATE}/copy`]: (c) => reply(200, {
    id: NEW_DOC, name: c.json().name, webViewLink: `https://docs.google.com/document/d/${NEW_DOC}/edit?usp=drivesdk`,
  }),
  [`${DOCS}/${NEW_DOC}:batchUpdate`]: () => reply(200, { documentId: NEW_DOC, replies: [] }),
});

function fakeFetch(overrides = {}) {
  const routes = { ...defaults(), ...overrides };
  const calls = [];
  const unexpected = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : null;
    const call = {
      url, method: init.method || 'GET', headers: new Headers(init.headers), body,
      json: () => JSON.parse(body), form: new URLSearchParams(body || ''),
    };
    calls.push(call);
    const prefix = Object.keys(routes).filter((p) => url.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (!prefix) {
      unexpected.push(`${call.method} ${url}`);
      throw new Error(`unexpected fetch: ${call.method} ${url}`);
    }
    return routes[prefix](call);
  };
  return { fetch, calls, unexpected, to: (prefix) => calls.filter((c) => c.url.startsWith(prefix)) };
}

/** One request through handle(). → { status, headers, text, data, calls, to(prefix) } */
async function run(path, {
  method = 'POST', body, auth = USER_JWT, origin = ORIGIN, env = ENV, routes = {}, query = '', base = `${SUPABASE}/functions/v1/google`,
} = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const req = new Request(`${base}/${path}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const f = fakeFetch(routes);
  const res = await g.handle(req, { env, fetch: f.fetch });
  assert.deepEqual(f.unexpected, [], 'no unexpected fetches');
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, headers: res.headers, text, data, calls: f.calls, to: f.to };
}

const stateFor = (over = {}) => g.signState({ uid: 'u-ana', email: 'ana@example.com', origin: ORIGIN, exp: now() + 600, nonce: 'n1', ...over }, SECRET);
const callback = async (state, { query, ...opts } = {}) => run('callback', {
  method: 'GET', auth: '', origin: '', query: query ?? `?code=auth-code&state=${encodeURIComponent(state)}`, ...opts,
});
const settings = (result) => `${ORIGIN}/#/settings?tab=business&google=${result}`;
// A callback with console.error captured: → its result plus `logs` (the function's one line per failed connect).
const loggedCallback = async (state, opts) => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    return { ...(await callback(state, opts)), logs };
  } finally {
    console.error = original;
  }
};
// A failed connect's log line names its step and never a code, token or secret.
const SECRET_BITS = ['auth-code', 'new-refresh-token', 'first-access-token'];
function failureLogged(r, step) {
  assert.equal(r.logs.length, 1, `${step}: one log line`);
  assert.ok(r.logs[0].startsWith(`google callback: ${step} `), r.logs[0]);
  [...SECRET_BITS, ENV.GOOGLE_CLIENT_SECRET].forEach((x) => assert.ok(!r.logs[0].includes(x), `${step}: no ${x} in the log`));
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 7), Buffer.from('\n%%EOF\n')]);
const email = (over = {}) => ({
  to: ['accounts@example.com', 'Pat@Example.com'],
  subject: 'Tax invoice EX-1002 from Example Pty Ltd',
  text: 'Hi,\nPlease find attached.\n',
  attachment: { filename: 'Invoice EX-1002.pdf', content: PDF.toString('base64'), type: 'application/pdf' },
  ...over,
});

// MIME → { headers (unfolded, lower-case names), headBlock, boundary, parts: [{ headers, content }] }
function parseHeaders(block) {
  const out = {};
  for (const line of block.replace(/\r\n(?=[ \t])/g, '').split('\r\n')) {
    const i = line.indexOf(':');
    out[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}
function parseMime(mime) {
  const i = mime.indexOf('\r\n\r\n');
  const headBlock = mime.slice(0, i);
  const headers = parseHeaders(headBlock);
  const boundary = headers['content-type'].match(/boundary="([^"]+)"/)[1];
  const chunks = mime.slice(i + 4).split(`--${boundary}`);
  assert.equal(chunks[0], '', 'the body starts with the first boundary');
  assert.equal(chunks.at(-1), '--\r\n', 'the message ends with the closing boundary');
  const parts = chunks.slice(1, -1).map((c) => {
    assert.ok(c.startsWith('\r\n') && c.endsWith('\r\n'));
    const body = c.slice(2, -2);
    const j = body.indexOf('\r\n\r\n');
    return { headers: parseHeaders(body.slice(0, j)), content: body.slice(j + 4) };
  });
  return { headers, headBlock, boundary, parts };
}
const decodeWords = (value) => value.match(/=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/g)
  .map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
const assertWrapped = (b64, label) => {
  const lines = b64.split('\r\n');
  assert.ok(lines.every((l) => l.length <= 76), `${label}: lines of at most 76`);
  assert.ok(lines.slice(0, -1).every((l) => l.length === 76), `${label}: full lines are 76`);
  return Buffer.from(lines.join(''), 'base64');
};

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

await check('helpers: base64url round-trips text and bytes (URL-safe, no padding)', () => {
  assert.equal(g.base64url('Grüße ?>>'), Buffer.from('Grüße ?>>').toString('base64url'));
  assert.equal(g.base64url(new Uint8Array([251, 255, 191])), '-_-_');
  assert.equal(new TextDecoder().decode(g.fromBase64url(g.base64url('Zoë {{Customer}}'))), 'Zoë {{Customer}}');
  const big = new Uint8Array(200000).map((_, i) => i % 256);
  assert.deepEqual(g.fromBase64url(g.base64url(big)), big, 'large inputs are chunked');
  assert.throws(() => g.fromBase64url('a'), 'not base64');
});

await check('helpers: allowedOrigin uses the defaults, or CORTEX_ORIGINS instead', () => {
  for (const o of ['https://cortex.assetstackai.com', 'https://cortex-1xk.pages.dev', 'http://localhost:5173', 'http://localhost:4322']) {
    assert.equal(g.allowedOrigin(o), o);
  }
  assert.equal(g.allowedOrigin('https://cortex.assetstackai.com/'), 'https://cortex.assetstackai.com');
  for (const o of ['https://evil.example.com', 'https://cortex.assetstackai.com.evil.example.com', 'http://cortex.assetstackai.com', '', null, 'null']) {
    assert.equal(g.allowedOrigin(o), '', String(o));
  }
  const { origins } = g.config({ CORTEX_ORIGINS: ' https://ops.example.com/ , http://localhost:9999' });
  assert.deepEqual(origins, ['https://ops.example.com', 'http://localhost:9999']);
  assert.equal(g.allowedOrigin('https://ops.example.com', origins), 'https://ops.example.com');
  assert.equal(g.allowedOrigin(ORIGIN, origins), '', 'the list replaces the defaults');
  assert.deepEqual(g.config({ CORTEX_ORIGINS: ' , ' }).origins, g.DEFAULT_ORIGINS);
});

await check('helpers: Supabase keys from the JSON env, else the legacy env; apikey always, Bearer only for a JWT', () => {
  const cfg = g.config(ENV);
  assert.deepEqual([cfg.publishableKey, cfg.secretKey], ['sb_publishable_test', 'sb_secret_test']);
  const legacy = g.config(LEGACY_ENV);
  assert.deepEqual([legacy.publishableKey, legacy.secretKey], ['eyJ.anon.placeholder', 'eyJ.service.placeholder']);
  assert.equal(g.config({ SUPABASE_SECRET_KEYS: '{"default": 7}', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.x' }).secretKey, 'eyJ.x');
  assert.equal(g.config({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_a"}', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.x' }).secretKey, 'sb_secret_a');
  assert.deepEqual(g.keyHeaders('sb_secret_test'), { apikey: 'sb_secret_test' });
  assert.deepEqual(g.keyHeaders('eyJ.service.placeholder'), { apikey: 'eyJ.service.placeholder', Authorization: 'Bearer eyJ.service.placeholder' });
});

await check('helpers: driveId reads Docs and Drive links and bare IDs, nothing else', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-x';
  for (const link of [
    id,
    `https://docs.google.com/document/d/${id}/edit?usp=sharing`,
    `https://docs.google.com/document/u/1/d/${id}/edit`,
    `docs.google.com/document/d/${id}`,
    `https://drive.google.com/file/d/${id}/view?usp=drive_link`,
    `https://drive.google.com/drive/folders/${id}`,
    `https://drive.google.com/drive/u/0/folders/${id}?resourcekey=abc`,
    `https://drive.google.com/open?id=${id}`,
    `  ${id}  `,
  ]) assert.equal(g.driveId(link), id, link);
  for (const bad of [
    '', null, 'not a link', 'short', `https://evil.example.com/document/d/${id}`, `http://docs.google.com/document/d/${id}`,
    'https://docs.google.com/document/d/abc/edit', 'https://drive.google.com/drive/my-drive', `${id}/../x`, 'https://drive.google.com/open?id=a%2Fb',
  ]) assert.equal(g.driveId(bad), '', String(bad));
});

await check('helpers: signState / verifyState accept only an unexpired state signed with the client secret', async () => {
  const payload = { uid: 'u-ana', email: 'ana@example.com', origin: ORIGIN, exp: now() + 60, nonce: 'n' };
  const state = await g.signState(payload, SECRET);
  assert.deepEqual(await g.verifyState(state, SECRET), payload);
  assert.equal(await g.verifyState(state, 'another-secret'), null);
  assert.equal(await g.verifyState(state, SECRET, now() + 61), null, 'expired');
  const [body, sig] = state.split('.');
  assert.equal(await g.verifyState(`${b64url(JSON.stringify({ ...payload, uid: 'u-ben' }))}.${sig}`, SECRET), null, 'tampered');
  assert.equal(await g.verifyState(`${body}.${sig.slice(0, -2)}`, SECRET), null, 'truncated signature');
  for (const bad of ['', null, body, `${state}.x`, `${body}.***`]) assert.equal(await g.verifyState(bad, SECRET), null, String(bad));
  assert.equal(await g.verifyState(await g.signState({ ...payload, origin: '' }, SECRET), SECRET), null, 'incomplete');
  assert.ok(g.timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])));
  assert.ok(!g.timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])));
  assert.ok(!g.timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])));
});

await check('helpers: encodeWords keeps each header line within 76 characters and decodes back', () => {
  const subject = 'Rechnung für Oktober — Grüße aus Sydney 🇦🇺 '.repeat(4).trim();
  const header = `Subject: ${g.encodeWords(subject)}`;
  assert.ok(header.split('\r\n').every((l) => l.length <= 76), header);
  assert.ok(header.split('\r\n').slice(1).every((l) => l.startsWith(' =?UTF-8?B?')));
  assert.equal(decodeWords(header), subject);
});

// ── CORS and routing ────────────────────────────────────────────────────────────────────────────────────────────

await check('CORS: a preflight from Cortex gets 204 and the origin echoed', async () => {
  for (const origin of [ORIGIN, 'http://localhost:5173']) {
    const r = await run('send', { method: 'OPTIONS', auth: '', origin });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
    assert.equal(r.headers.get('access-control-allow-methods'), 'POST, GET, OPTIONS');
    assert.equal(r.headers.get('access-control-allow-headers'), 'authorization, x-client-info, apikey, content-type');
    assert.equal(r.headers.get('vary'), 'Origin');
    assert.equal(r.calls.length, 0);
  }
});

await check('CORS: an unknown origin gets no CORS headers, on the preflight or the response', async () => {
  const pre = await run('send', { method: 'OPTIONS', auth: '', origin: 'https://evil.example.com' });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
  assert.equal(pre.headers.get('access-control-allow-methods'), null);
  const res = await run('send', { body: email(), origin: 'https://evil.example.com', routes: { [`${RPC}/google_me`]: () => reply(200, { ...ME, admin: false }) } });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const ours = await run('send', { body: email(), routes: { [`${RPC}/google_me`]: () => reply(200, { ...ME, admin: false }) } });
  assert.equal(ours.headers.get('access-control-allow-origin'), ORIGIN, 'JSON responses carry CORS for Cortex');
  assert.equal(ours.headers.get('content-type'), 'application/json');
});

await check('routing: last path segment; wrong method → 405, unknown route → 404', async () => {
  const short = await run('connect', { body: { origin: ORIGIN }, base: `${SUPABASE}/google` });
  assert.equal(short.status, 200, '/google/connect');
  const get = await run('connect', { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST, OPTIONS');
  assert.equal(get.headers.get('content-type'), 'application/json');
  assert.equal((await run('callback', { body: {} })).status, 405);
  assert.equal((await run('send', { method: 'PUT', body: email() })).status, 405);
  for (const path of ['nope', 'constructor', '__proto__', '']) {
    const r = await run(path, { body: {} });
    assert.equal(r.status, 404, path);
    assert.equal(r.calls.length, 0);
  }
});

await check('settings: a missing setting → 500 naming it, without calling anything', async () => {
  const r = await run('send', { body: email(), env: { ...ENV, GOOGLE_CLIENT_SECRET: '' } });
  assert.equal(r.status, 500);
  assert.match(r.data.error, /GOOGLE_CLIENT_SECRET/);
  assert.equal(r.calls.length, 0);
  const cb = await callback('x', { env: { ...ENV, SUPABASE_SECRET_KEYS: '', SUPABASE_SERVICE_ROLE_KEY: '' } });
  assert.equal(cb.status, 500);
  assert.match(cb.text, /SUPABASE_SECRET_KEYS/);
});

// ── Who is calling ──────────────────────────────────────────────────────────────────────────────────────────────

await check('caller: 401 without Authorization, before calling anything', async () => {
  for (const path of ['connect', 'send', 'contract']) {
    const r = await run(path, { auth: '', body: {} });
    assert.equal(r.status, 401, path);
    assert.equal(typeof r.data.error, 'string');
    assert.equal(r.calls.length, 0);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  }
});

await check('caller: the JWT goes to rpc google_me with the publishable key; PostgREST rejecting it → 401', async () => {
  const ok = await run('connect', { body: { origin: ORIGIN } });
  const [me] = ok.to(`${RPC}/google_me`);
  assert.equal(me.method, 'POST');
  assert.equal(me.headers.get('apikey'), 'sb_publishable_test');
  assert.equal(me.headers.get('authorization'), USER_JWT);
  assert.equal(me.body, '{}');
  for (const [status, body] of [
    [401, { code: 'PGRST301', message: 'JWT expired' }],
    [401, { message: 'Invalid JWT' }],
    [401, { code: '42501', message: 'permission denied for function google_me' }], // the anon role
    [403, { code: 'PGRST303', message: 'JWT claims validation failed' }],
  ]) {
    const r = await run('send', { body: email(), routes: { [`${RPC}/google_me`]: () => reply(status, body) } });
    assert.equal(r.status, 401, JSON.stringify(body));
    assert.equal(r.to(`${RPC}/google_token`).length, 0);
  }
  const legacy = await run('connect', { body: { origin: ORIGIN }, env: LEGACY_ENV });
  assert.equal(legacy.to(`${RPC}/google_me`)[0].headers.get('apikey'), 'eyJ.anon.placeholder');
  assert.equal(legacy.to(`${RPC}/google_me`)[0].headers.get('authorization'), USER_JWT, 'the caller’s JWT, not the key');
});

await check('caller: 403 for an inactive or non-staff account (42501) and for staff who aren’t admins', async () => {
  const inactive = await run('send', { body: email(), routes: { [`${RPC}/google_me`]: () => reply(403, { code: '42501', message: 'Not allowed' }) } });
  assert.equal(inactive.status, 403);
  const staff = await run('contract', { body: {}, routes: { [`${RPC}/google_me`]: () => reply(200, { ...ME, admin: false }) } });
  assert.equal(staff.status, 403);
  assert.match(staff.data.error, /admins/);
  const connect = await run('connect', { body: { origin: ORIGIN }, routes: { [`${RPC}/google_me`]: () => reply(200, { ...ME, admin: false }) } });
  assert.equal(connect.status, 403);
  for (const r of [inactive, staff, connect]) assert.equal(r.to(`${RPC}/google_token`).length + r.to(TOKEN_URL).length, 0);
});

// ── Connect and callback ────────────────────────────────────────────────────────────────────────────────────────

await check('connect: Google’s consent URL with every parameter and a state that verifies', async () => {
  const r = await run('connect', { body: { origin: ORIGIN } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data), ['url']);
  const url = new URL(r.data.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = Object.fromEntries(url.searchParams);
  const { state, ...rest } = p;
  assert.deepEqual(rest, {
    client_id: ENV.GOOGLE_CLIENT_ID,
    redirect_uri: `${SUPABASE}/functions/v1/google/callback`,
    response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    hd: 'assetstackai.com',
    login_hint: 'ana@example.com',
  });
  const payload = await g.verifyState(state, SECRET);
  assert.ok(payload, 'state verifies with the client secret');
  assert.deepEqual([payload.uid, payload.email, payload.origin], ['u-ana', 'ana@example.com', ORIGIN]);
  assert.ok(payload.exp >= now() + 595 && payload.exp <= now() + 605, 'expires in 10 minutes');
  assert.ok(typeof payload.nonce === 'string' && payload.nonce.length >= 16);
  assert.equal(await g.verifyState(state, 'another-secret'), null);
  const again = await run('connect', { body: { origin: ORIGIN } });
  assert.notEqual(new URL(again.data.url).searchParams.get('state'), state, 'a fresh nonce each time');
});

await check('connect: an origin that isn’t Cortex is refused; CORTEX_ORIGINS replaces the defaults', async () => {
  for (const body of [{ origin: 'https://evil.example.com' }, {}, { origin: 42 }]) {
    const r = await run('connect', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.data.error, 'string');
  }
  const env = { ...ENV, CORTEX_ORIGINS: 'https://ops.example.com' };
  const ours = await run('connect', { body: { origin: 'https://ops.example.com' }, origin: 'https://ops.example.com', env });
  assert.equal(ours.status, 200);
  assert.equal(ours.headers.get('access-control-allow-origin'), 'https://ops.example.com');
  assert.equal((await run('connect', { body: { origin: ORIGIN }, env })).status, 400);
});

await check('callback: a tampered, expired, foreign or missing state → the plain expired page, no redirect, no calls', async () => {
  const good = await stateFor();
  const [, sig] = good.split('.');
  const payload = JSON.parse(Buffer.from(good.split('.')[0], 'base64url').toString());
  const states = [
    `${b64url(JSON.stringify({ ...payload, uid: 'u-ben' }))}.${sig}`, // tampered
    await stateFor({ exp: now() - 1 }), // expired
    await g.signState({ ...payload }, 'another-secret'), // not ours
    await stateFor({ origin: 'https://evil.example.com' }), // signed, but not a Cortex origin
    'garbage',
    '',
  ];
  for (const state of states) {
    const r = await callback(state);
    assert.equal(r.status, 400, state);
    assert.equal(r.text, EXPIRED);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(r.headers.get('location'), null);
    assert.equal(r.calls.length, 0);
  }
  const none = await callback('', { query: '?code=auth-code' });
  assert.equal(none.status, 400);
  assert.equal(none.text, EXPIRED);
});

await check('callback: Google’s access_denied → reason=denied, nothing exchanged', async () => {
  const state = await stateFor();
  const r = await callback(state, { query: `?error=access_denied&state=${encodeURIComponent(state)}` });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), settings('error&reason=denied'));
  assert.equal(r.calls.length, 0);
});

await check('callback: a failed exchange, another or unverified account, no refresh token, a failed save → the right reason', async () => {
  const state = await stateFor();
  const exchange = (body, status = 200) => ({ [TOKEN_URL]: () => reply(status, body) });
  const token = (over) => ({ access_token: 'first-access-token', refresh_token: 'new-refresh-token', scope: g.SCOPES, id_token: idToken({}), ...over });
  const cases = [
    ['exchange', exchange({ error: 'invalid_grant', error_description: 'Bad Request' }, 400)],
    ['exchange', { [TOKEN_URL]: () => { throw new TypeError('fetch failed'); } }],
    // The client ID and secret don't match (a GOOGLE_CLIENT_SECRET that isn't an enabled secret of the client).
    ['client', exchange({ error: 'invalid_client', error_description: 'Unauthorized' }, 401)],
    ['client', exchange({ error: 'unauthorized_client' }, 400)],
    ['wrong_account', exchange(token({ id_token: idToken({ email: 'someone@example.com' }) }))],
    ['wrong_account', exchange(token({ id_token: idToken({ email_verified: false }) }))],
    ['wrong_account', exchange(token({ id_token: undefined }))],
    ['no_refresh_token', exchange(token({ refresh_token: undefined }))],
    ['save', { [`${RPC}/google_save`]: () => reply(500, { message: 'boom' }) }],
  ];
  for (const [reason, routes] of cases) {
    const r = await loggedCallback(state, { routes });
    assert.equal(r.status, 302, reason);
    assert.equal(r.headers.get('location'), settings(`error&reason=${reason}`));
    if (['exchange', 'client', 'save'].includes(reason)) failureLogged(r, reason);
    else assert.equal(r.logs.length, 0, `${reason}: nothing logged (it names itself)`);
    if (reason !== 'save') assert.equal(r.to(`${RPC}/google_save`).length, 0, `${reason}: nothing saved`);
    assert.equal(r.to(`${RPC}/calendar_share`).length, 0, `${reason}: a plain connect never shares a calendar`);
  }
  const noCode = await loggedCallback(state, { query: `?state=${encodeURIComponent(state)}` });
  assert.equal(noCode.headers.get('location'), settings('error&reason=exchange'));
  failureLogged(noCode, 'exchange');
  // The log carries Google's and PostgREST's short error, so the cause shows in the function's logs.
  const why = await loggedCallback(state, { routes: exchange({ error: 'invalid_client', error_description: 'Unauthorized' }, 401) });
  assert.equal(why.logs[0], 'google callback: client 401 invalid_client · Unauthorized');
  const db = await loggedCallback(state, { routes: { [`${RPC}/google_save`]: () => reply(403, { code: '42501', message: 'permission denied for function google_save' }) } });
  assert.equal(db.logs[0], 'google callback: save 403 42501 · permission denied for function google_save');
});

await check('callback: success exchanges the code, saves with the secret key and goes back to Settings connected', async () => {
  const state = await stateFor();
  const r = await callback(state, {
    routes: { [TOKEN_URL]: () => reply(200, { access_token: 'first-access-token', refresh_token: 'new-refresh-token', scope: g.SCOPES, id_token: idToken({ email: 'Ana@Example.com', email_verified: 'true' }) }) },
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), settings('connected'));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const [ex] = r.to(TOKEN_URL);
  assert.equal(ex.method, 'POST');
  assert.equal(ex.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(ex.form), {
    code: 'auth-code', client_id: ENV.GOOGLE_CLIENT_ID, client_secret: SECRET,
    redirect_uri: `${SUPABASE}/functions/v1/google/callback`, grant_type: 'authorization_code',
  });
  const [save] = r.to(`${RPC}/google_save`);
  assert.equal(save.method, 'POST');
  assert.equal(save.headers.get('apikey'), 'sb_secret_test');
  assert.equal(save.headers.get('authorization'), null, 'an sb_secret_ key is not a JWT: apikey only');
  assert.deepEqual(save.json(), { p_user: 'u-ana', p_email: 'ana@example.com', p_token: 'new-refresh-token', p_scopes: g.SCOPES });
  assert.ok(!r.headers.get('location').includes('token') && r.text === '', 'no token in the redirect');
  assert.equal(r.to(`${RPC}/calendar_share`).length, 0, 'a plain connect never calls calendar_share');
});

await check('callback: a legacy JWT-style secret key is sent as apikey and as Bearer', async () => {
  const r = await callback(await stateFor(), { env: LEGACY_ENV });
  assert.equal(r.headers.get('location'), settings('connected'));
  const [save] = r.to(`${RPC}/google_save`);
  assert.equal(save.headers.get('apikey'), 'eyJ.service.placeholder');
  assert.equal(save.headers.get('authorization'), 'Bearer eyJ.service.placeholder');
});

// ── Send ────────────────────────────────────────────────────────────────────────────────────────────────────────

await check('send: not connected → 409, without asking Google', async () => {
  const r = await run('send', { body: email(), routes: { [`${RPC}/google_token`]: () => reply(200, null) } });
  assert.equal(r.status, 409);
  assert.deepEqual(r.data, { error: 'Connect your Google account in Settings first.' });
  const [tok] = r.to(`${RPC}/google_token`);
  assert.equal(tok.headers.get('apikey'), 'sb_secret_test');
  assert.equal(tok.headers.get('authorization'), null);
  assert.deepEqual(tok.json(), { p_user: 'u-ana' });
  assert.equal(r.to(TOKEN_URL).length + r.to(GMAIL).length, 0);
});

await check('send: a revoked refresh token (invalid_grant) → 409 reconnect, nothing sent', async () => {
  const r = await run('send', {
    body: email(), routes: { [TOKEN_URL]: () => reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) },
  });
  assert.equal(r.status, 409);
  assert.deepEqual(r.data, { error: 'Reconnect your Google account in Settings.' });
  assert.equal(r.to(GMAIL).length, 0);
});

await check('send: invalid requests → 400 before any token is read', async () => {
  const pdf = (content, over = {}) => ({ attachment: { filename: 'Invoice.pdf', content, type: 'application/pdf', ...over } });
  const tooBig = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1024 * 1024 - 8)]); // 2 MB + 1 byte
  const cases = {
    'no recipients': { to: [] },
    'recipients not a list': { to: 'accounts@example.com' },
    'too many recipients': { to: Array.from({ length: 11 }, (_, i) => `person${i}@example.com`) },
    'a bad address': { to: ['accounts@example.com', 'not-an-email'] },
    'an address with a display name': { to: ['Pat <pat@example.com>'] },
    'CRLF in an address': { to: ['pat@example.com\r\nBcc: someone@example.com'] },
    'CRLF in the subject': { subject: 'Invoice\r\nBcc: someone@example.com' },
    'LF in the subject': { subject: 'Invoice\nBcc: someone@example.com' },
    'no subject': { subject: '   ' },
    'subject too long': { subject: 'x'.repeat(201) },
    'text too long': { text: 'x'.repeat(20001) },
    'attachment not a PDF': pdf(Buffer.from('hello, world').toString('base64')),
    'attachment not base64': pdf('***not base64***'),
    'attachment of another type': pdf(PDF.toString('base64'), { type: 'text/plain' }),
    'attachment too big': pdf(tooBig.toString('base64')),
    'attachment name not .pdf': pdf(PDF.toString('base64'), { filename: 'invoice.exe' }),
    'attachment name only .pdf': pdf(PDF.toString('base64'), { filename: '../.pdf' }),
    'CRLF in the attachment name': pdf(PDF.toString('base64'), { filename: 'Invoice\r\nX-Evil: 1.pdf' }),
  };
  assert.equal(tooBig.length, 2 * 1024 * 1024 + 1);
  for (const [name, over] of Object.entries(cases)) {
    const r = await run('send', { body: email(over) });
    assert.equal(r.status, 400, name);
    assert.equal(typeof r.data.error, 'string', name);
    assert.equal(r.to(`${RPC}/google_token`).length + r.to(TOKEN_URL).length + r.to(GMAIL).length, 0, `${name}: nothing else called`);
  }
  const exactly = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1024 * 1024 - 9)]);
  assert.equal((await run('send', { body: email(pdf(exactly.toString('base64'))) })).status, 200, '2 MB exactly is fine');
  assert.equal((await run('send', { body: email({ attachment: undefined }) })).status, 200, 'the attachment is optional');
  assert.equal((await run('send', { body: email({ to: Array.from({ length: 10 }, (_, i) => `p${i}@example.com`) }) })).status, 200, '10 is fine');
});

await check('send: Gmail gets a correct MIME message from your own address; returns { id, from }', async () => {
  const r = await run('send', { body: email() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { id: 'msg-1', from: 'ana@example.com' });
  assert.ok(!/access-token|refresh-token/.test(r.text), 'no token in the response');

  const [refresh] = r.to(TOKEN_URL);
  assert.deepEqual(Object.fromEntries(refresh.form), {
    client_id: ENV.GOOGLE_CLIENT_ID, client_secret: SECRET, refresh_token: 'stored-refresh-token', grant_type: 'refresh_token',
  });
  const [sent] = r.to(GMAIL);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers.get('authorization'), 'Bearer fresh-access-token');
  assert.equal(sent.headers.get('content-type'), 'application/json');
  const { raw } = sent.json();
  assert.match(raw, /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.ok(!/[^\r]\n/.test(mime) && !/\r[^\n]/.test(mime), 'CRLF line endings only');

  const m = parseMime(mime);
  assert.equal(m.headers.from, '"Ana Example" <ana@example.com>');
  assert.equal(m.headers.to, 'accounts@example.com, pat@example.com');
  assert.equal(m.headers.subject, 'Tax invoice EX-1002 from Example Pty Ltd');
  assert.equal(m.headers['mime-version'], '1.0');
  assert.match(m.headers['content-type'], /^multipart\/mixed; boundary="cortex-[0-9a-f]{32}"$/);
  assert.equal(m.parts.length, 2);

  const [textPart, pdfPart] = m.parts;
  assert.deepEqual(textPart.headers, { 'content-type': 'text/plain; charset=UTF-8', 'content-transfer-encoding': 'base64' });
  assert.equal(assertWrapped(textPart.content, 'text').toString('utf8'), 'Hi,\r\nPlease find attached.\r\n');
  assert.deepEqual(pdfPart.headers, {
    'content-type': 'application/pdf; name="Invoice EX-1002.pdf"',
    'content-disposition': 'attachment; filename="Invoice EX-1002.pdf"',
    'content-transfer-encoding': 'base64',
  });
  assert.ok(pdfPart.content.split('\r\n').length > 1, 'long enough to wrap');
  assert.deepEqual(assertWrapped(pdfPart.content, 'pdf'), PDF);

  const again = parseMime(Buffer.from((await run('send', { body: email() })).to(GMAIL)[0].json().raw, 'base64url').toString());
  assert.notEqual(again.boundary, m.boundary, 'a random boundary');
});

await check('send: a non-ASCII subject and sender name are RFC 2047 encoded; the file name is cleaned', async () => {
  const subject = 'Rechnung für Oktober — Grüße an das Team von Example Pty Ltd (EX-1002)';
  const r = await run('send', {
    body: email({ subject, attachment: { filename: 'Invoice "EX/1002" ü.pdf', content: PDF.toString('base64'), type: 'application/pdf' } }),
    routes: { [`${RPC}/google_me`]: () => reply(200, { ...ME, name: 'Zoë Example' }) },
  });
  assert.equal(r.status, 200);
  const mime = Buffer.from(r.to(GMAIL)[0].json().raw, 'base64url').toString('utf8');
  const m = parseMime(mime);
  assert.match(m.headBlock, /^[\x20-\x7e\r\n]*$/, 'headers are plain ASCII');
  assert.ok(m.headBlock.split('\r\n').every((l) => l.length <= 76 || !l.includes('=?')), 'encoded lines within 76');
  assert.ok(m.headers.subject.startsWith('=?UTF-8?B?'));
  assert.ok(m.headBlock.split('\r\n').some((l) => l.startsWith(' =?UTF-8?B?')), 'folded onto a continuation line');
  assert.equal(decodeWords(m.headers.subject), subject);
  assert.match(m.headers.from, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <ana@example\.com>$/);
  assert.equal(decodeWords(m.headers.from), 'Zoë Example');
  assert.equal(m.parts[1].headers['content-disposition'], 'attachment; filename="Invoice EX1002 .pdf"');
});

await check('send: Google errors → 502 with Google’s message; a missing Gmail scope → 409 reconnect', async () => {
  const bad = await run('send', {
    body: email(), routes: { [GMAIL]: () => reply(400, { error: { code: 400, message: 'Invalid To header', status: 'INVALID_ARGUMENT' } }) },
  });
  assert.equal(bad.status, 502);
  assert.deepEqual(bad.data, { error: 'Invalid To header' });
  const scope = await run('send', {
    body: email(),
    routes: {
      [GMAIL]: () => reply(403, {
        error: {
          code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
        },
      }),
    },
  });
  assert.equal(scope.status, 409);
  assert.match(scope.data.error, /^Reconnect your Google account in Settings/);
  const down = await run('send', { body: email(), routes: { [TOKEN_URL]: () => reply(500, { error: 'internal_failure', error_description: 'Backend Error' }) } });
  assert.equal(down.status, 502);
  assert.deepEqual(down.data, { error: 'Backend Error' });
});

// ── Contract ────────────────────────────────────────────────────────────────────────────────────────────────────

const contract = (over = {}) => ({
  template: `https://docs.google.com/document/d/${TEMPLATE}/edit`,
  folder: `https://drive.google.com/drive/folders/${FOLDER}`,
  name: 'Example Council – Software Subscription Agreement',
  replacements: { Customer: 'Example Council', 'Annual fee': '$4,500', 'Customer ABN': '' },
  ...over,
});

await check('contract: a Google Doc template is copied as is into the folder (shared drives too), then filled in', async () => {
  const r = await run('contract', { body: contract() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, {
    id: NEW_DOC, name: 'Example Council – Software Subscription Agreement', url: `https://docs.google.com/document/d/${NEW_DOC}/edit?usp=drivesdk`,
  });
  const [meta] = r.to(`${DRIVE}/${TEMPLATE}?`);
  assert.equal(meta.method, 'GET');
  assert.equal(meta.url, `${DRIVE}/${TEMPLATE}?fields=id,name,mimeType&supportsAllDrives=true`);
  assert.equal(meta.headers.get('authorization'), 'Bearer fresh-access-token');
  const [copy] = r.to(`${DRIVE}/${TEMPLATE}/copy`);
  assert.equal(copy.method, 'POST');
  const q = new URL(copy.url).searchParams;
  assert.deepEqual([q.get('supportsAllDrives'), q.get('fields')], ['true', 'id,name,webViewLink']);
  assert.deepEqual(copy.json(), { name: 'Example Council – Software Subscription Agreement', parents: [FOLDER] }, 'no conversion');
  const [fill] = r.to(`${DOCS}/${NEW_DOC}:batchUpdate`);
  assert.equal(fill.method, 'POST');
  assert.equal(fill.headers.get('authorization'), 'Bearer fresh-access-token');
  assert.deepEqual(fill.json(), {
    requests: [
      { replaceAllText: { containsText: { text: '{{Customer}}', matchCase: false }, replaceText: 'Example Council' } },
      { replaceAllText: { containsText: { text: '{{Annual fee}}', matchCase: false }, replaceText: '$4,500' } },
      { replaceAllText: { containsText: { text: '{{Customer ABN}}', matchCase: false }, replaceText: '' } },
    ],
  });
  assert.ok(!/access-token|refresh-token/.test(r.text), 'no token in the response');
});

await check('contract: a .docx template is converted to a Google Doc as it is copied; other files are refused', async () => {
  const docx = await run('contract', {
    body: contract({ template: TEMPLATE, folder: `https://drive.google.com/drive/u/0/folders/${FOLDER}` }),
    routes: { [`${DRIVE}/${TEMPLATE}?`]: () => reply(200, { id: TEMPLATE, name: 'Template.docx', mimeType: MIME_DOCX }) },
  });
  assert.equal(docx.status, 200);
  assert.deepEqual(docx.to(`${DRIVE}/${TEMPLATE}/copy`)[0].json(), {
    name: 'Example Council – Software Subscription Agreement', parents: [FOLDER], mimeType: MIME_DOC,
  });
  const pdf = await run('contract', {
    body: contract(), routes: { [`${DRIVE}/${TEMPLATE}?`]: () => reply(200, { id: TEMPLATE, name: 'Template.pdf', mimeType: 'application/pdf' }) },
  });
  assert.equal(pdf.status, 400);
  assert.deepEqual(pdf.data, { error: 'The template must be a Google Doc.' });
  assert.equal(pdf.to(`${DRIVE}/${TEMPLATE}/copy`).length, 0);
});

await check('contract: bad template or folder links → 400 before calling Google', async () => {
  for (const over of [
    { template: 'not a link' },
    { template: `https://evil.example.com/document/d/${TEMPLATE}` },
    { folder: '' },
    { folder: 'https://drive.google.com/drive/my-drive' },
    { name: '  ' },
    { replacements: ['Customer'] },
  ]) {
    const r = await run('contract', { body: contract(over) });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(typeof r.data.error, 'string');
    assert.equal(r.to(`${RPC}/google_token`).length + r.to(DRIVE).length, 0);
  }
});

await check('contract: Drive 404 on the template or the folder → 404 with the sharing hint', async () => {
  const notFound = () => reply(404, { error: { code: 404, message: `File not found: ${TEMPLATE}.`, errors: [{ reason: 'notFound' }] } });
  for (const route of [`${DRIVE}/${TEMPLATE}?`, `${DRIVE}/${TEMPLATE}/copy`]) {
    const r = await run('contract', { body: contract(), routes: { [route]: notFound } });
    assert.equal(r.status, 404, route);
    assert.deepEqual(r.data, { error: 'Template or folder not found, or not shared with your Google account.' });
    assert.equal(r.to(DOCS).length, 0);
  }
});

await check('contract: no replacements → no batchUpdate, and the URL falls back to the Docs link', async () => {
  const r = await run('contract', {
    body: contract({ replacements: undefined }),
    routes: { [`${DRIVE}/${TEMPLATE}/copy`]: () => reply(200, { id: NEW_DOC, name: 'Copy' }) },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { id: NEW_DOC, name: 'Copy', url: `https://docs.google.com/document/d/${NEW_DOC}/edit` });
  assert.equal(r.to(DOCS).length, 0);
});

await check('contract: other Google errors → 502 with Google’s message; not connected → 409', async () => {
  const fill = await run('contract', {
    body: contract(), routes: { [`${DOCS}/${NEW_DOC}:batchUpdate`]: () => reply(400, { error: { code: 400, message: 'Invalid requests[0].replaceAllText' } }) },
  });
  assert.equal(fill.status, 502);
  assert.deepEqual(fill.data, { error: 'Invalid requests[0].replaceAllText' });
  const perm = await run('contract', {
    body: contract(),
    routes: { [`${DRIVE}/${TEMPLATE}/copy`]: () => reply(403, { error: { code: 403, message: 'The user does not have sufficient permissions for file.', errors: [{ reason: 'insufficientFilePermissions' }] } }) },
  });
  assert.equal(perm.status, 502);
  assert.match(perm.data.error, /sufficient permissions/);
  const none = await run('contract', { body: contract(), routes: { [`${RPC}/google_token`]: () => reply(200, null) } });
  assert.equal(none.status, 409);
  assert.equal(none.to(DRIVE).length, 0);
});

// ── Outreach sync ───────────────────────────────────────────────────────────────────────────────────────────────
// Fictional prospects and mailboxes only (example.com / example.org).

const REST = `${SUPABASE}/rest/v1`;
const SHEET_ID = '1OutreachSheet_abcdefghijklmnopqrstuv';
const SHEET = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=777`;
const ADMIN_ID = 'a0000000-0000-4000-8000-0000000000d1';
const JOSH_ID = 'a0000000-0000-4000-8000-0000000000j2';
const PEOPLE = [{ id: ADMIN_ID, name: 'David Example', active: true, role: 'superadmin' }, { id: JOSH_ID, name: 'Josh Example', active: true, role: 'admin' }];
const MAILBOXES = [
  { id: 'mb-david', name: 'David', addresses: ['david@example.com', 'david@old.example.com'] },
  { id: 'mb-josh', name: 'Josh', addresses: ['josh@example.com'] },
  { id: 'mb-sarah', name: 'Sarah', addresses: ['sarah@example.com'] },
];
const NO_OUTREACH = 'You don’t have access to Outreach.';
const SYNC_FAILED = 'Something went wrong with Google. Try again.';
// The agent's columns, in its order, plus `sender`.
const AGENT = [
  'date_logged', 'vertical', 'organisation', 'domain', 'location', 'kdm_name', 'kdm_role', 'kdm_email', 'apollo_email_status',
  'gmail_check', 'apollo_history_check', 'tracker_check', 'eligible', 'tier', 'signal', 'research_hook', 'subject', 'variant',
  'email_id', 'draft_status', 'gmail_draft_id', 'sent_date', 'sent_message_id', 'thread_id', 'sequence_status', 'followup_stage',
  'next_followup_date', 'ooo_until', 'bounced', 'suppress_until', 'reply_status', 'reply_date', 'reply_summary', 'note',
  'meeting_booked_date', 'sender',
];
const P = (o, headers = AGENT) => headers.map((h) => o[h] ?? '');
const TRACKER = [
  AGENT,
  P({ date_logged: '2026-10-12', organisation: 'Example Shire Council', kdm_name: 'Alex Example', kdm_email: 'alex@example.org', draft_status: 'sent', sent_date: '2026-10-13', sent_message_id: 'A1B2C3D4E5F60001', reply_status: 'negative', reply_date: '2026-10-15', sender: 'David@Example.com' }),
  P({ date_logged: '2026-10-12', organisation: 'Example Water', kdm_email: 'bo@example.org', draft_status: 'sent', sent_date: '2026-10-13', sent_message_id: 'a1b2c3d4e5f60002', bounced: 'yes', sender: 'david@example.com' }),
  P({ date_logged: '2026-10-13', organisation: 'Example Ports', kdm_email: 'cy@example.org', draft_status: 'sent', sent_date: '14/10/2026', sent_message_id: 'a1b2c3d4e5f60003', reply_status: 'referral', reply_date: '2026-10-14', meeting_booked_date: '15/10/2026', sender: 'david@old.example.com' }),
  P({ date_logged: '2026-10-13', organisation: 'Example Ports', kdm_email: 'cy2@example.org', draft_status: 'sent', sent_date: '2026-10-14', sent_message_id: 'a1b2c3d4e5f60003', reply_status: 'referral', reply_date: '2026-10-16', sender: 'david@old.example.com' }),
  P({ date_logged: '2026-10-13', organisation: 'Example Rail', kdm_email: 'di@example.org', draft_status: 'sent', sent_date: '2026-10-14 09:30', sent_message_id: 'a1b2c3d4e5f60004', sender: 'josh@example.com' }),
  P({ date_logged: '2026-10-13', organisation: 'Example Roads', kdm_email: 'ed@example.org', draft_status: 'sent', sent_date: '2026-10-14', sent_message_id: 'a1b2c3d4e5f60005', sender: 'old-box@example.com' }),
  P({ date_logged: '2026-10-14', organisation: 'Example Energy', kdm_email: 'fi@example.org', draft_status: 'draft-saved', gmail_draft_id: 'r-555', sender: 'david@example.com' }),
  P({ date_logged: '14/10/2026', organisation: 'Example Health', kdm_email: 'Pat@Example.org', draft_status: 'skipped-colleague' }),
  [],
  ['', '  ', ''],
  P({ vertical: 'Water', note: 'No contact found' }),
  P({ date_logged: '2026-10-12', organisation: 'Example Water Corp', kdm_name: 'Lee Example', draft_status: 'skipped-unverified' }),
  P({ date_logged: '2026-10-12', organisation: 'Example Shire Council', kdm_name: 'Alex Example', kdm_email: 'alex@example.org', draft_status: 'sent', sent_date: '2026-10-13', sent_message_id: 'a1b2c3d4e5f60001', reply_status: 'negative', reply_date: '2026-10-15', reply_summary: 'Not this year', sender: 'david@example.com' }),
];
const NOTES = [
  { mailbox_id: null, pinned: false, body: 'Short subject lines did better this week.', author_id: JOSH_ID, created_at: '2026-10-14T23:30:00+00:00' },
  { mailbox_id: 'mb-david', pinned: true, body: 'Lead with the council’s own asset register.', author_id: ADMIN_ID, created_at: '2026-10-01T02:00:00+00:00' },
  { mailbox_id: 'mb-josh', pinned: false, body: '=SUM(A1) stays text', author_id: 'a0000000-0000-4000-8000-00000000gone', created_at: '2026-10-10T05:15:00+00:00' },
];

// A quoted A1 range ('Tab' or 'Tab'!A1) → { range, title, a1 }
function parseRange(range) {
  const m = /^'((?:[^']|'')*)'(?:!(.*))?$/.exec(range);
  assert.ok(m, `a quoted range: ${range}`);
  return { range, title: m[1].replace(/''/g, "'"), a1: m[2] || '' };
}

// The range in a Sheets values URL → { title, a1, action }
function sheetRange(url) {
  const [path] = url.slice(`${SHEET}/values/`.length).split('?');
  const [encoded, action = ''] = path.split(':');
  return { ...parseRange(decodeURIComponent(encoded)), action };
}

// The tabs one sync wrote back (its one values:batchUpdate, RAW, rows) → [{ title, a1, values }] in order ([] when none).
function writes(r) {
  const calls = r.sheets.filter((c) => c.url === `${SHEET}/values:batchUpdate`);
  assert.ok(calls.length <= 1, 'at most one values:batchUpdate');
  if (!calls.length) return [];
  const { valueInputOption, data, ...rest } = calls[0].json();
  assert.equal(valueInputOption, 'RAW');
  assert.deepEqual(rest, {});
  return data.map(({ range, majorDimension, values, ...more }) => {
    assert.equal(majorDimension, 'ROWS');
    assert.deepEqual(more, {});
    const { title, a1 } = parseRange(range);
    return { title, a1, values };
  });
}
const tabValues = (r, title) => writes(r).find((w) => w.title === title)?.values;
// The tabs one sync cleared (its one values:batchClear) → titles in order ([] when none).
function cleared(r) {
  const calls = r.sheets.filter((c) => c.url === `${SHEET}/values:batchClear`);
  assert.ok(calls.length <= 1, 'at most one values:batchClear');
  return calls.length ? calls[0].json().ranges.map((x) => { const p = parseRange(x); assert.equal(p.a1, '', 'the whole tab'); return p.title; }) : [];
}
// The requests of one sync's spreadsheet batchUpdate(s): addSheet and updateSheetProperties.
const sizeRequests = (r) => r.sheets.filter((c) => c.url === `${SHEET}:batchUpdate`).flatMap((c) => c.json().requests);
// The tabs one sync added (its addSheet requests) → titles in order.
const added = (r) => sizeRequests(r).filter((q) => q.addSheet).map((q) => q.addSheet.properties.title);
// The tabs one sync grew (its updateSheetProperties requests) → sheet ids in order.
const grown = (r) => sizeRequests(r).filter((q) => q.updateSheetProperties).map((q) => q.updateSheetProperties.properties.sheetId);
// Every Sheets call that writes (adds, clears or updates), as "title" lists: never the agent's tab.
const touched = (r) => [...added(r), ...cleared(r), ...writes(r).map((w) => w.title)];
// A tab as Google lists it: a 1,000 × 26 grid (a new tab's) unless given; gridProperties: undefined → none (not a grid).
const gridTab = (p) => ({ gridProperties: { rowCount: 1000, columnCount: 26 }, ...p });
const GRID_FIELDS = 'gridProperties.rowCount,gridProperties.columnCount';
const NO_GID = 'Paste the link of the agent’s tab in Settings → Outreach (open the tab, then copy the address: it ends in #gid=…).';
const GID_GONE = 'The tab in the outreach sheet link isn’t in the sheet any more. Paste the agent’s tab link in Settings → Outreach.';

// PostgREST and Sheets for outreach-sync, on top of the Google defaults (google_token, the token endpoint).
function outreachRoutes({
  access = { view: true, edit: false, admin: false }, settings = { sheet_url: SHEET_URL, sheet_by: ADMIN_ID },
  tabs = [{ sheetId: 0, title: 'Summary', index: 0 }, { sheetId: 777, title: 'Tracker', index: 1 }], values = { Tracker: TRACKER },
  mailboxes = MAILBOXES, notes = NOTES, people = PEOPLE, gone = ['e-gone-1', 'e-gone-2'],
} = {}) {
  return {
    [`${RPC}/outreach_access`]: () => reply(200, access),
    [`${REST}/outreach_settings`]: (c) => (c.method === 'GET' ? reply(200, settings ? [settings] : []) : new Response(null, { status: 204 })),
    [`${REST}/profiles`]: (c) => {
      const q = new URL(c.url).searchParams.get('id') || '';
      const ids = q.startsWith('eq.') ? [q.slice(3)] : q.startsWith('in.(') ? q.slice(4, -1).split(',') : [];
      return reply(200, people.filter((p) => ids.includes(p.id)));
    },
    [`${REST}/outreach_mailboxes`]: () => reply(200, mailboxes),
    [`${REST}/outreach_emails`]: (c) => (c.method === 'POST' ? new Response(null, { status: 201 }) : reply(200, gone.map((id) => ({ id })))),
    [`${REST}/outreach_notes`]: () => reply(200, notes),
    [`${SHEET}?`]: () => reply(200, { sheets: tabs.map((p) => ({ properties: gridTab(p) })) }),
    [`${SHEET}:batchUpdate`]: (c) => reply(200, { spreadsheetId: SHEET_ID, replies: c.json().requests.map(() => ({ addSheet: {} })) }),
    [`${SHEET}/values:batchClear`]: (c) => reply(200, { spreadsheetId: SHEET_ID, clearedRanges: c.json().ranges }),
    [`${SHEET}/values:batchUpdate`]: (c) => reply(200, { spreadsheetId: SHEET_ID, totalUpdatedSheets: c.json().data.length }),
    [`${SHEET}/values/`]: (c) => { // reads only: the write-back goes through values:batchClear / values:batchUpdate
      const { range, title } = sheetRange(c.url);
      assert.equal(c.method, 'GET', 'one tab’s values are only read');
      return reply(200, { range, majorDimension: 'ROWS', ...(values[title] ? { values: values[title] } : {}) });
    },
  };
}

/** One outreach-sync request. `routes` override single answers; console.error is captured (and returned as `logs`). */
async function sync({ routes = {}, ...opts } = {}, runOpts = {}) {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    const r = await run('outreach-sync', { body: {}, routes: { ...outreachRoutes(opts), ...routes }, ...runOpts });
    const patches = r.to(`${REST}/outreach_settings`).filter((c) => c.method === 'PATCH');
    const sheets = r.calls.filter((c) => c.url.startsWith(SHEET));
    const upserts = r.to(`${REST}/outreach_emails`).filter((c) => c.method === 'POST');
    return { ...r, logs, patches, sheets, upserts, rows: upserts.flatMap((c) => c.json()) };
  } finally {
    console.error = original;
  }
}
const syncError = (r) => r.patches.map((c) => c.json());

await check('outreach helpers: sheetFromUrl as src/lib/outreach.js; sheetDate reads ISO and Australian dates only', () => {
  assert.deepEqual(g.sheetFromUrl(SHEET_URL), { id: SHEET_ID, gid: '777' });
  assert.deepEqual(g.sheetFromUrl(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing`), { id: SHEET_ID, gid: '' });
  assert.deepEqual(g.sheetFromUrl(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=5#gid=5`), { id: SHEET_ID, gid: '5' });
  for (const bad of ['', null, 'https://docs.google.com/spreadsheets/d/short/edit', `https://docs.google.com/document/d/${SHEET_ID}/edit`]) {
    assert.deepEqual(g.sheetFromUrl(bad), { id: '', gid: '' }, String(bad));
  }
  const dates = {
    '2026-10-14': '2026-10-14', ' 2026-10-14 ': '2026-10-14', '2026-10-14 09:30:00': '2026-10-14', '2026-10-14T09:30:00Z': '2026-10-14',
    '14/10/2026': '2026-10-14', '4/3/2026': '2026-03-04', '04/03/2026': '2026-03-04', '4/03/2026 9:15:00': '2026-03-04',
    '29/02/2028': '2028-02-29', '31/02/2026': null, '29/02/2026': null, '2026-13-01': null, '2026-02-30': null, '13/13/2026': null,
    '2026-1-4': null, '14-10-2026': null, '2026/10/14': null, '10/14/26': null, 'Oct 14, 2026': null, 'yes': null, '': null,
  };
  for (const [input, want] of Object.entries(dates)) assert.equal(g.sheetDate(input), want, input);
  assert.equal(g.sheetDate(null), null);
});

await check('outreach CORS: a preflight gets 204 and the origin; responses carry CORS; GET → 405', async () => {
  const pre = await run('outreach-sync', { method: 'OPTIONS', auth: '' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'POST, GET, OPTIONS');
  assert.equal(pre.calls.length, 0);
  const evil = await run('outreach-sync', { method: 'OPTIONS', auth: '', origin: 'https://evil.example.com' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const ok = await sync();
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('content-type'), 'application/json');
  const foreign = await sync({}, { origin: 'https://evil.example.com' });
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  const get = await run('outreach-sync', { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST, OPTIONS');
});

await check('outreach access: rpc outreach_access with the caller’s JWT must say view; no view → 403 before anything else', async () => {
  const ok = await sync({ access: { view: true, edit: false, admin: false } });
  assert.equal(ok.status, 200, 'staff with view may sync (not only admins)');
  const [acc] = ok.to(`${RPC}/outreach_access`);
  assert.equal(acc.method, 'POST');
  assert.equal(acc.headers.get('apikey'), 'sb_publishable_test');
  assert.equal(acc.headers.get('authorization'), USER_JWT, 'the caller’s own JWT');
  assert.equal(acc.body, '{}');
  assert.equal(ok.to(`${RPC}/google_me`).length, 0, 'not the admins-only check');
  for (const answer of [() => reply(200, { view: false, edit: false, admin: false }), () => reply(200, null), () => reply(403, { code: '42501', message: 'Not allowed' })]) {
    const r = await sync({ routes: { [`${RPC}/outreach_access`]: answer } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.data, { error: NO_OUTREACH });
    assert.equal(r.calls.length, 1, 'nothing read or written');
  }
  const expired = await sync({ routes: { [`${RPC}/outreach_access`]: () => reply(401, { code: 'PGRST301', message: 'JWT expired' }) } });
  assert.equal(expired.status, 401);
  const anon = await sync({}, { auth: '' });
  assert.equal(anon.status, 401);
  assert.equal(anon.calls.length, 0);
});

await check('outreach settings: read with the secret key; no sheet or no sheet_by → 400, no sync_error, no Google', async () => {
  const ok = await sync();
  const [read] = ok.to(`${REST}/outreach_settings`);
  assert.equal(read.method, 'GET');
  assert.equal(read.url, `${REST}/outreach_settings?id=eq.1&select=sheet_url,sheet_by`);
  assert.equal(read.headers.get('apikey'), 'sb_secret_test');
  const cases = [
    [{ sheet_url: '', sheet_by: ADMIN_ID }, 'Add the outreach sheet in Settings → Outreach.'],
    [null, 'Add the outreach sheet in Settings → Outreach.'],
    [{ sheet_url: SHEET_URL, sheet_by: null }, 'Ask an admin to click Use my Google in Settings → Outreach.'],
  ];
  for (const [settings, error] of cases) {
    const r = await sync({ settings });
    assert.equal(r.status, 400, JSON.stringify(settings));
    assert.deepEqual(r.data, { error });
    assert.equal(r.patches.length, 0, 'no sync_error for a sheet that isn’t set');
    assert.equal(r.to(`${RPC}/google_token`).length + r.sheets.length, 0);
  }
  const notSheets = await sync({ settings: { sheet_url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWx/edit', sheet_by: ADMIN_ID } });
  assert.equal(notSheets.status, 400);
  assert.match(notSheets.data.error, /isn’t a Google Sheets link/);
  assert.deepEqual(syncError(notSheets), [{ sync_error: notSheets.data.error }], 'saved as sync_error');
  assert.equal(notSheets.to(`${RPC}/google_token`).length, 0);
});

await check('outreach Google: the token of the admin who set the sheet; not connected or revoked → 409 naming them', async () => {
  const ok = await sync();
  const [tok] = ok.to(`${RPC}/google_token`);
  assert.deepEqual(tok.json(), { p_user: ADMIN_ID });
  assert.equal(tok.headers.get('apikey'), 'sb_secret_test');
  const [profile] = ok.to(`${REST}/profiles`);
  assert.equal(profile.url, `${REST}/profiles?id=eq.${ADMIN_ID}&select=name,active,role`);
  assert.equal(profile.headers.get('apikey'), 'sb_secret_test');
  assert.ok(ok.calls.indexOf(profile) < ok.calls.indexOf(tok), 'checked before their token is read');
  assert.ok(ok.sheets.every((c) => c.headers.get('authorization') === 'Bearer fresh-access-token'));

  const none = await sync({ routes: { [`${RPC}/google_token`]: () => reply(200, null) } });
  assert.equal(none.status, 409);
  assert.deepEqual(none.data, { error: 'David Example needs to connect Google in Settings → Business.' });
  assert.deepEqual(syncError(none), [{ sync_error: 'David Example needs to connect Google in Settings → Business.' }]);
  assert.equal(none.to(TOKEN_URL).length + none.sheets.length + none.upserts.length, 0);

  const nameless = await sync({ people: [{ id: ADMIN_ID, name: '', active: true, role: 'admin' }], routes: { [`${RPC}/google_token`]: () => reply(200, null) } });
  assert.deepEqual(nameless.data, { error: 'The admin who set the sheet link needs to connect Google in Settings → Business.' });

  const revoked = await sync({ routes: { [TOKEN_URL]: () => reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) } });
  assert.equal(revoked.status, 409);
  assert.deepEqual(revoked.data, { error: 'David Example needs to reconnect Google in Settings → Business.' });
  assert.equal(revoked.sheets.length, 0);
});

await check('outreach admin: the admin who set the sheet must be an active admin; else 409 and their Google token is never read', async () => {
  const inactive = 'David Example is no longer active. Another admin can click Use my Google in Settings → Outreach.';
  const unknown = 'The admin who set the sheet link is no longer active. Another admin can click Use my Google in Settings → Outreach.';
  const demoted = 'David Example is no longer an admin. Another admin can click Use my Google in Settings → Outreach.';
  for (const [people, error] of [
    [[{ id: ADMIN_ID, name: 'David Example', active: false, role: 'admin' }], inactive],
    [[{ id: ADMIN_ID, name: 'David Example', active: true, role: 'staff' }], demoted],
    [[{ id: ADMIN_ID, name: 'David Example', active: true }], demoted], // no role at all
    [[{ id: ADMIN_ID, name: 'David Example' }], inactive], // no active flag at all
    [[], unknown], // the profile is gone
    [[{ id: ADMIN_ID, name: '  ', active: false }], unknown],
  ]) {
    const r = await sync({ people });
    assert.equal(r.status, 409, JSON.stringify(people));
    assert.deepEqual(r.data, { error });
    assert.deepEqual(syncError(r), [{ sync_error: error }], 'saved as sync_error');
    assert.equal(r.to(`${RPC}/google_token`).length + r.to(TOKEN_URL).length + r.sheets.length + r.upserts.length, 0, 'no token, no Google, no rows');
  }
  const down = await sync({ routes: { [`${REST}/profiles`]: () => reply(500, { message: 'boom' }) } });
  assert.equal(down.status, 502, 'can’t tell: refused');
  assert.deepEqual(down.data, { error: 'Could not check who set the outreach sheet.' });
  assert.deepEqual(syncError(down), [{ sync_error: 'Could not check who set the outreach sheet.' }]);
  assert.equal(down.to(`${RPC}/google_token`).length, 0);
});

await check('outreach tab: the link’s tab (its gid), never a guess; the range is quoted and encoded', async () => {
  const tabs = [
    { sheetId: 0, title: 'Summary' }, { sheetId: 1, title: 'notes' }, { sheetId: 5, title: 'Bob’s list' },
    { sheetId: 777, title: "Ana's Tracker" }, { sheetId: 9, title: 'Other' },
  ];
  const values = { "Ana's Tracker": TRACKER, 'Bob’s list': TRACKER };
  const byGid = await sync({ tabs, values });
  assert.equal(byGid.status, 200);
  const [meta, read] = byGid.sheets;
  assert.equal(meta.method, 'GET');
  assert.equal(meta.url, `${SHEET}?fields=sheets.properties`);
  assert.equal(read.method, 'GET');
  assert.equal(read.url, `${SHEET}/values/${encodeURIComponent("'Ana''s Tracker'!A1:AZ")}`);
  assert.equal(byGid.data.stats.tab, "Ana's Tracker");

  // The link's tab wherever it is (?gid= works too); never the first other tab.
  const query = await sync({ tabs, values, settings: { sheet_url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=5`, sheet_by: ADMIN_ID } });
  assert.equal(query.status, 200);
  assert.equal(sheetRange(query.sheets[1].url).title, 'Bob’s list');
});

await check('outreach tab errors: no gid, a gid no longer in the sheet, or Summary / Notes → 400 and sync_error; nothing saved or written', async () => {
  const at = (rest) => ({ sheet_url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit${rest}`, sheet_by: ADMIN_ID });
  const tabs = [{ sheetId: 0, title: 'Summary' }, { sheetId: 1, title: ' notes ' }, { sheetId: 777, title: 'Tracker' }, { sheetId: 5, title: 'Josh' }];
  const ours = (title) => `The outreach sheet link opens Cortex’s ${title} tab. Paste the agent’s tab link in Settings → Outreach.`;
  for (const [rest, error, google] of [
    ['', NO_GID, false], ['?usp=sharing', NO_GID, false], ['#gid=', NO_GID, false],
    ['#gid=404', GID_GONE, true], ['?gid=7770#gid=7770', GID_GONE, true],
    ['#gid=0', ours('Summary'), true], ['?gid=1#gid=1', ours('notes'), true],
  ]) {
    const r = await sync({ tabs, values: { Tracker: TRACKER, Summary: TRACKER, ' notes ': TRACKER }, settings: at(rest) });
    assert.equal(r.status, 400, rest);
    assert.deepEqual(r.data, { error }, rest);
    assert.deepEqual(syncError(r), [{ sync_error: error }], `${rest}: saved as sync_error (no synced_at or stats)`);
    assert.equal(r.to(`${REST}/outreach_emails`).length + r.to(`${REST}/outreach_mailboxes`).length, 0, `${rest}: nothing saved`);
    assert.deepEqual(r.sheets.map((c) => `${c.method} ${c.url.slice(SHEET.length)}`), google ? ['GET ?fields=sheets.properties'] : [],
      `${rest}: ${google ? 'the tab list only' : 'no Google at all'}`);
    if (!google) assert.equal(r.to(`${RPC}/google_token`).length, 0, `${rest}: not even a token`);
  }
  // A mailbox-named tab (no tab of its own then) stays a valid link: covered under the mailbox tabs.
  const old = await sync({ tabs: [{ sheetId: 0, title: 'Summary' }, { sheetId: 1, title: 'Notes' }] });
  assert.deepEqual([old.status, old.data], [400, { error: GID_GONE }], 'only Cortex’s tabs left: the link’s tab is gone');
});

await check('outreach rows: every column mapped by header name, with raw, dates, followup_stage, in_sheet and synced_at', async () => {
  const full = {
    date_logged: '12/10/2026', vertical: 'Local government', organisation: 'Example Shire Council', domain: 'example.org',
    location: 'Bunbury WA', kdm_name: 'Alex Example', kdm_role: 'Asset Manager', kdm_email: 'Alex@Example.org',
    apollo_email_status: 'verified', eligible: 'yes', tier: 'A', signal: 'New asset plan', research_hook: 'Their 2026 plan',
    subject: 'Your asset register', variant: 'B', email_id: 'em-1', draft_status: 'sent', gmail_draft_id: 'r-1',
    sent_date: '2026-10-13 08:01:00', sent_message_id: 'A1B2C3D4E5F6A7B8', thread_id: 'a1b2c3d4e5f6a7b8', sequence_status: 'replied-neutral',
    followup_stage: '2', next_followup_date: '20/10/2026', ooo_until: '2026-10-19', bounced: 'no', reply_status: 'neutral',
    reply_date: '2026-10-14', reply_summary: 'Ask again in Q1', note: 'Warm', meeting_booked_date: '2026-11-03', sender: ' David@Example.com ',
  };
  const r = await sync({ values: { Tracker: [AGENT, P(full)] } });
  assert.equal(r.status, 200);
  const [row] = r.rows;
  const start = row.synced_at;
  assert.match(start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const raw = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, v.trim()]));
  assert.deepEqual(row, {
    row_key: 'alex@example.org|2026-10-12', sender: 'david@example.com', date_logged: '2026-10-12', vertical: 'Local government',
    organisation: 'Example Shire Council', domain: 'example.org', location: 'Bunbury WA', contact_name: 'Alex Example',
    contact_role: 'Asset Manager', contact_email: 'Alex@Example.org', tier: 'A', signal: 'New asset plan', subject: 'Your asset register',
    variant: 'B', status: 'sent', sent_on: '2026-10-13', message_id: 'A1B2C3D4E5F6A7B8', thread_id: 'a1b2c3d4e5f6a7b8',
    sequence_status: 'replied-neutral', followup_stage: 2, next_followup: '2026-10-20', bounced: false, reply_status: 'neutral',
    reply_on: '2026-10-14', reply_summary: 'Ask again in Q1', note: 'Warm', meeting_on: '2026-11-03', raw,
    mailbox_id: 'mb-david', in_sheet: true, synced_at: start,
  });

  const sparse = await sync({ values: { Tracker: [AGENT, P({ kdm_email: 'kim@example.org', date_logged: 'last week', sent_date: 'soon', followup_stage: 'two' })] } });
  assert.deepEqual(sparse.rows[0], {
    row_key: 'kim@example.org|', sender: '', date_logged: null, vertical: '', organisation: '', domain: '', location: '',
    contact_name: '', contact_role: '', contact_email: 'kim@example.org', tier: '', signal: '', subject: '', variant: '', status: '',
    sent_on: null, message_id: '', thread_id: '', sequence_status: '', followup_stage: 0, next_followup: null, bounced: false,
    reply_status: '', reply_on: null, reply_summary: '', note: '', meeting_on: null,
    raw: { date_logged: 'last week', kdm_email: 'kim@example.org', sent_date: 'soon', followup_stage: 'two' },
    mailbox_id: null, in_sheet: true, synced_at: sparse.rows[0].synced_at,
  }, 'unreadable dates → null (and \'\' in the key), a bad stage → 0, empty cells left out of raw');
});

await check('outreach rows: columns in any order and case; sender also from Mailbox, From or sent_from', async () => {
  const head = ['Notes about it', ' KDM_EMAIL ', 'Sent_Message_ID', 'Organisation', 'SENT_DATE', '', 'Mailbox', 'note'];
  const r = await sync({ values: { Tracker: [head, ['keep me', 'zoe@example.org', 'ABC1', 'Example Port Authority', '2026-10-14', 'loose', 'Josh <JOSH@example.com>', 'hello']] } });
  assert.equal(r.status, 200);
  const [row] = r.rows;
  assert.deepEqual([row.row_key, row.contact_email, row.message_id, row.organisation, row.sent_on, row.sender, row.mailbox_id, row.note],
    ['zoe@example.org|', 'zoe@example.org', 'ABC1', 'Example Port Authority', '2026-10-14', 'josh@example.com', 'mb-josh', 'hello']);
  assert.deepEqual(row.raw, {
    'Notes about it': 'keep me', KDM_EMAIL: 'zoe@example.org', Sent_Message_ID: 'ABC1', Organisation: 'Example Port Authority',
    SENT_DATE: '2026-10-14', F: 'loose', Mailbox: 'Josh <JOSH@example.com>', note: 'hello',
  }, 'every non-empty cell under its header (a column letter when the header is empty)');

  for (const header of ['from', 'sent_from', 'Sender']) {
    const s = await sync({ values: { Tracker: [['kdm_email', header], ['p@example.org', 'Sarah@Example.com']] } });
    assert.equal(s.rows[0].sender, 'sarah@example.com', header);
    assert.equal(s.rows[0].mailbox_id, 'mb-sarah', header);
  }
  const first = await sync({ values: { Tracker: [['kdm_email', 'from', 'sender'], ['p1@example.org', 'josh@example.com', 'david@example.com'], ['p2@example.org', 'josh@example.com', '']] } });
  assert.deepEqual(first.rows.map((x) => x.sender), ['david@example.com', 'josh@example.com'], 'sender first, then the others');

  const unknown = await sync({ values: { Tracker: [['Prospect', 'Email'], ['Example', 'x@example.org']] } });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.data, { error: 'The “Tracker” tab has no outreach columns in row 1.' });
  assert.deepEqual(syncError(unknown), [{ sync_error: unknown.data.error }]);
  assert.equal(unknown.upserts.length + unknown.to(`${REST}/outreach_emails`).length, 0, 'nothing marked missing either');
  const empty = await sync({ values: {} });
  assert.equal(empty.status, 400, 'an empty tab');
});

await check('outreach rows: bounced is yes / y / true / 1 (any case), anything else false', async () => {
  const yes = ['yes', 'YES', ' y ', 'Y', 'true', 'TRUE', '1'];
  const no = ['', 'no', 'n', '0', 'false', 'bounced', 'maybe'];
  const values = [['kdm_email', 'bounced'], ...[...yes, ...no].map((v, i) => [`p${i}@example.org`, v])];
  const r = await sync({ values: { Tracker: values } });
  assert.deepEqual(r.rows.map((x) => x.bounced), [...yes.map(() => true), ...no.map(() => false)]);
});

await check('outreach rows: one row per contact, kdm_email|date else organisation|name|date; duplicates and keyless rows counted', async () => {
  const head = ['sent_message_id', 'email_id', 'gmail_draft_id', 'kdm_email', 'date_logged', 'organisation', 'kdm_name', 'note'];
  const rows = [
    ['MSG-1', 'EM-1', 'R-1', 'Ann@Example.org', '2026-10-01', 'Org A', 'Ann', 'one email to two contacts: Ann'],
    ['MSG-1', 'EM-1', 'R-1', 'ben@example.org', '2026-10-01', 'Org A', 'Ben', 'and Ben'],
    ['', '', '', 'cat@example.org', '1/10/2026', 'Org C', 'Cat', 'logged, not drafted yet'],
    ['', '', '', 'dan@example.org', '', 'Org D', 'Dan', 'no date'],
    ['', '', '', 'eve@example.org', 'sometime', 'Org E', 'Eve', 'an unreadable date'],
    ['', '', '', '', '2026-10-01', 'Org F', 'Fay', 'no email'],
    ['', '', '', '', '', '', 'Gus', 'a name alone'],
    ['', '', '', '', '', 'Org H', '', 'an organisation alone'],
    ['MSG-9', 'EM-9', 'R-9', '', '2026-10-01', '', '', 'ids but no contact: skipped'],
    ['', '', '', '', '2026-10-01', '', '', 'a date alone: skipped'],
    ['MSG-1', 'EM-1', 'R-1', 'ann@example.org', '01/10/2026', 'Org A', 'Ann', 'Ann again: the later row wins'],
    ['', 'EM-3', 'R-3', 'cat@example.org', '2026-10-01', 'Org C', 'Cat', 'Cat, now drafted: the same key'],
  ];
  const r = await sync({ values: { Tracker: [head, ...rows] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.rows.map((x) => [x.row_key, x.note]), [
    ['ben@example.org|2026-10-01', 'and Ben'],
    ['dan@example.org|', 'no date'],
    ['eve@example.org|', 'an unreadable date'],
    ['org f|fay|2026-10-01', 'no email'],
    ['|gus|', 'a name alone'],
    ['org h||', 'an organisation alone'],
    ['ann@example.org|2026-10-01', 'Ann again: the later row wins'],
    ['cat@example.org|2026-10-01', 'Cat, now drafted: the same key'],
  ], 'two contacts of one email stay two rows; a row keeps its key as ids appear');
  assert.equal(r.data.stats.duplicates, 2);
  assert.equal(r.data.stats.skipped, 2);
  assert.equal(r.data.stats.rows, 8);
});

await check('outreach counts: emails, not rows (sent_message_id, else the contact, per mailbox), on the Summary and in the stats', async () => {
  const head = ['kdm_email', 'date_logged', 'sent_message_id', 'sent_date', 'bounced', 'reply_status', 'reply_date', 'meeting_booked_date', 'sender'];
  const r = await sync({
    values: {
      Tracker: [
        head,
        // One email (M1) to two contacts: 1 sent, 1 bounce (only the first row bounced), 1 reply on the earliest reply day
        // (the later row's).
        ['a@example.org', '2026-10-10', 'M1', '2026-10-12', 'yes', 'neutral', '2026-10-15', '', 'david@example.com'],
        ['b@example.org', '2026-10-10', 'M1', '2026-10-12', '', 'neutral', '2026-10-14', '2026-10-20', 'david@example.com'],
        // M2: sent on the earliest sent day; a reply date without a reply_status isn't a reply.
        ['c@example.org', '2026-10-10', 'M2', '2026-10-13', '', '', '2026-10-13', '', 'david@example.com'],
        ['d@example.org', '2026-10-10', 'M2', '2026-10-11', '', 'negative', '2026-10-16', '', 'david@example.com'],
        // The same id from another mailbox is another email.
        ['e@example.org', '2026-10-10', 'M2', '2026-10-13', '', '', '', '', 'josh@example.com'],
        // No id: the contact is the email.
        ['f@example.org', '2026-10-10', '', '2026-10-13', '', '', '', '', 'david@example.com'],
        ['g@example.org', '2026-10-10', '', '', '', '', '', '', 'david@example.com'],
      ],
    },
  });
  assert.equal(r.status, 200);
  const summary = tabValues(r, 'Summary');
  assert.deepEqual(summary, [
    ['Date', 'Mailbox', 'Sent', 'Replies', 'Reply rate', 'Bounces', 'Meetings'],
    ['2026-10-20', 'David', 0, 0, '', 0, 1],
    ['2026-10-16', 'David', 0, 1, '', 0, 0],
    ['2026-10-14', 'David', 0, 1, '', 0, 0],
    ['2026-10-13', 'David', 1, 0, '0%', 0, 0],
    ['2026-10-13', 'Josh', 1, 0, '0%', 0, 0],
    ['2026-10-12', 'David', 1, 0, '0%', 1, 0],
    ['2026-10-11', 'David', 1, 0, '0%', 0, 0],
    [],
    ['Total', 'David', 3, 2, '67%', 1, 1],
    ['Total', 'Josh', 1, 0, '0%', 0, 0],
    ['Total', 'Sarah', 0, 0, '', 0, 0],
    ['Total', 'All mailboxes', 4, 2, '50%', 1, 1],
  ]);
  assert.deepEqual(r.data.stats, {
    rows: 7, contacts: 6, sent: 4, replies: 2, bounced: 1, meetings: 1, unassigned: 0, duplicates: 0, skipped: 0, missing: 2, tab: 'Tracker',
    tabs: ['David', 'Josh', 'Sarah'], noTab: [],
  });
  assert.equal(r.rows.length, 7, 'every contact is still its own row in outreach_emails');

  // Both rows carry the same reply: still one reply; a bounced email with no sent day isn't counted as a bounce.
  const two = await sync({
    values: {
      Tracker: [head,
        ['a@example.org', '2026-10-10', 'M1', '2026-10-12', '', 'neutral', '2026-10-14', '', 'david@example.com'],
        ['b@example.org', '2026-10-10', 'M1', '2026-10-12', '', 'neutral', '2026-10-14', '', 'david@example.com'],
        ['h@example.org', '2026-10-10', 'M3', '', 'yes', '', '', '', 'david@example.com']],
    },
  });
  const t = two.data.stats;
  assert.deepEqual([t.rows, t.contacts, t.sent, t.replies, t.bounced], [3, 2, 1, 1, 0]);
});

await check('outreach upsert: 1,201 rows → 3 requests of 500 / 500 / 201 with the secret key, then the missing-rows PATCH', async () => {
  const many = [['kdm_email', 'sent_message_id', 'sent_date', 'sender'], ...Array.from({ length: 1201 }, (_, i) => [`p${i}@example.org`, `m-${i}`, '2026-10-14', 'david@example.com'])];
  const r = await sync({ values: { Tracker: many }, gone: ['e-1', 'e-2', 'e-3'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.upserts.map((c) => c.json().length), [500, 500, 201]);
  const start = r.rows[0].synced_at;
  for (const c of r.upserts) {
    assert.equal(c.url, `${REST}/outreach_emails?on_conflict=row_key`);
    assert.equal(c.headers.get('prefer'), 'resolution=merge-duplicates,return=minimal');
    assert.equal(c.headers.get('apikey'), 'sb_secret_test');
    assert.equal(c.headers.get('authorization'), null);
    assert.equal(c.headers.get('content-type'), 'application/json');
  }
  assert.equal(new Set(r.rows.map((x) => x.row_key)).size, 1201);
  assert.ok(r.rows.every((x) => x.in_sheet === true && x.synced_at === start), 'in_sheet and this sync’s start on every row');
  const keys = JSON.stringify(Object.keys(r.rows[0]).sort());
  assert.ok(r.rows.every((x) => JSON.stringify(Object.keys(x).sort()) === keys), 'the same columns in every row (PostgREST bulk insert)');

  const [patch] = r.to(`${REST}/outreach_emails`).filter((c) => c.method === 'PATCH');
  assert.ok(r.calls.indexOf(patch) > r.calls.indexOf(r.upserts.at(-1)), 'after every upsert');
  assert.equal(patch.url, `${REST}/outreach_emails?synced_at=lt.${start}&in_sheet=eq.true&select=id`);
  assert.deepEqual(patch.json(), { in_sheet: false, synced_at: start }, 'stamped, so an older sync finishing late can’t put them back');
  assert.equal(patch.headers.get('apikey'), 'sb_secret_test');
  assert.equal(patch.headers.get('prefer'), 'return=representation');
  assert.equal(r.data.stats.missing, 3);
  assert.equal(r.data.stats.unassigned, 0);

  const none = await sync({ values: { Tracker: [['kdm_email']] } });
  assert.equal(none.status, 200);
  assert.equal(none.upserts.length, 0, 'no rows → no upsert');
  assert.equal(none.to(`${REST}/outreach_emails`).filter((c) => c.method === 'PATCH').length, 1, 'but every old row is marked missing');
});

await check('outreach mailboxes: the sender’s mailbox (any of its addresses, any case), else Unassigned', async () => {
  const r = await sync();
  assert.equal(r.status, 200);
  assert.equal(r.to(`${REST}/outreach_mailboxes`)[0].url, `${REST}/outreach_mailboxes?select=id,name,addresses&order=position.asc`);
  assert.equal(r.to(`${REST}/outreach_mailboxes`)[0].headers.get('apikey'), 'sb_secret_test');
  const by = Object.fromEntries(r.rows.map((x) => [x.row_key, x.mailbox_id]));
  assert.deepEqual(by, {
    'alex@example.org|2026-10-12': 'mb-david', 'bo@example.org|2026-10-12': 'mb-david', 'cy@example.org|2026-10-13': 'mb-david',
    'cy2@example.org|2026-10-13': 'mb-david', 'di@example.org|2026-10-13': 'mb-josh', 'ed@example.org|2026-10-13': null,
    'fi@example.org|2026-10-14': 'mb-david', 'pat@example.org|2026-10-14': null, 'example water corp|lee example|2026-10-12': null,
  });
  assert.equal(r.rows.find((x) => x.row_key === 'alex@example.org|2026-10-12').reply_summary, 'Not this year', 'the later duplicate');
  const caps = await sync({ mailboxes: [{ id: 'mb-x', name: 'X', addresses: ['Old-Box@Example.com'] }] });
  assert.equal(caps.rows.find((x) => x.row_key === 'ed@example.org|2026-10-13').mailbox_id, 'mb-x');
});

await check('outreach Summary: per day × mailbox, newest first, reply rates, then the all-time totals block', async () => {
  // TRACKER: Example Ports' two contacts share one email (one sent, the earlier reply day only).
  const r = await sync();
  assert.equal(r.status, 200);
  const [update] = writes(r);
  assert.equal(r.sheets.find((c) => c.url === `${SHEET}/values:batchUpdate`).headers.get('content-type'), 'application/json');
  assert.deepEqual(update, {
    title: 'Summary', // the first tab written, from A1
    a1: 'A1',
    values: [
      ['Date', 'Mailbox', 'Sent', 'Replies', 'Reply rate', 'Bounces', 'Meetings'],
      ['2026-10-15', 'David', 0, 1, '', 0, 1],
      ['2026-10-14', 'David', 1, 1, '100%', 0, 0],
      ['2026-10-14', 'Josh', 1, 0, '0%', 0, 0],
      ['2026-10-14', 'Unassigned', 1, 0, '0%', 0, 0],
      ['2026-10-13', 'David', 2, 0, '0%', 1, 0],
      [],
      ['Total', 'David', 3, 2, '67%', 1, 1],
      ['Total', 'Josh', 1, 0, '0%', 0, 0],
      ['Total', 'Sarah', 0, 0, '', 0, 0],
      ['Total', 'Unassigned', 1, 0, '0%', 0, 0],
      ['Total', 'All mailboxes', 5, 2, '40%', 1, 1],
    ],
  });
  // Rounding: 1 of 3 → 33%, 1 of 8 → 13% (half up), 7 of 40 → 18%; a reply without a reply_status isn't one.
  const rows = (n, replied) => Array.from({ length: n }, (_, i) => [`p${n}-${i}@example.org`, '2026-10-14', i < replied ? 'negative' : '', i < replied ? '2026-10-14' : '', 'david@example.com']);
  const rated = await sync({
    mailboxes: [MAILBOXES[0]],
    values: { Tracker: [['kdm_email', 'sent_date', 'reply_status', 'reply_date', 'sender'], ...rows(3, 1), ...rows(8, 1), ...rows(40, 7), ['px@example.org', '2026-10-14', '', '2026-10-14', 'david@example.com']] },
  });
  const values = tabValues(rated, 'Summary');
  assert.deepEqual(values.at(-1), ['Total', 'All mailboxes', 52, 9, '17%', 0, 0]);
  const A = [{ id: 'a', name: 'A' }];
  assert.deepEqual(g.summaryValues([{ row_key: 'k1', mailbox_id: 'a', sent_on: '2026-10-01', reply_on: '2026-10-01', reply_status: 'neutral' }, { row_key: 'k2', mailbox_id: 'a', sent_on: '2026-10-01' }, { row_key: 'k3', mailbox_id: 'a', sent_on: '2026-10-01' }], A)[1],
    ['2026-10-01', 'A', 3, 1, '33%', 0, 0]);
  assert.equal(g.summaryValues(Array.from({ length: 8 }, (_, i) => ({ row_key: `k${i}`, mailbox_id: 'a', sent_on: '2026-10-01', reply_on: i ? null : '2026-10-01', reply_status: i ? '' : 'negative' })), A)[1][4], '13%');
  assert.equal(g.summaryValues(Array.from({ length: 40 }, (_, i) => ({ row_key: `k${i}`, mailbox_id: 'a', sent_on: '2026-10-01', reply_on: '2026-10-01', reply_status: i < 7 ? 'negative' : '' })), A)[1][4], '18%');
  assert.deepEqual(g.summaryValues([], []), [['Date', 'Mailbox', 'Sent', 'Replies', 'Reply rate', 'Bounces', 'Meetings'], [], ['Total', 'All mailboxes', 0, 0, '', 0, 0]]);
});

await check('outreach Notes: pinned first then newest, with mailbox and author names, Sydney time, as plain values', async () => {
  const r = await sync();
  const [notes] = r.to(`${REST}/outreach_notes`);
  assert.equal(notes.url, `${REST}/outreach_notes?select=mailbox_id,pinned,body,author_id,created_at`);
  assert.equal(notes.headers.get('apikey'), 'sb_secret_test');
  const authors = r.to(`${REST}/profiles`).find((c) => c.url.includes('id=in.'));
  const ids = new URL(authors.url).searchParams.get('id');
  assert.deepEqual(ids.slice(4, -1).split(',').sort(), [JOSH_ID, ADMIN_ID, NOTES[2].author_id].sort());
  const [, update] = writes(r);
  assert.deepEqual(update, {
    title: 'Notes', // the second tab written, from A1
    a1: 'A1',
    values: [
      ['Created', 'Mailbox', 'Pinned', 'Author', 'Note'],
      ['2026-10-01 12:00', 'David', 'Yes', 'David Example', 'Lead with the council’s own asset register.'],
      ['2026-10-15 10:30', 'All mailboxes', '', 'Josh Example', 'Short subject lines did better this week.'],
      ['2026-10-10 16:15', 'Josh', '', '', '=SUM(A1) stays text'],
    ],
  });
  const empty = await sync({ notes: [] });
  assert.equal(empty.to(`${REST}/profiles`).filter((c) => c.url.includes('id=in.')).length, 0, 'no authors → no lookup');
  assert.deepEqual(tabValues(empty, 'Notes'), [['Created', 'Mailbox', 'Pinned', 'Author', 'Note']]);
});

await check('outreach mailbox tabs: the agent’s row 1, then exactly the rows saved for each mailbox, as written, in sheet order', async () => {
  // TRACKER: David's rows in the agent's order (Alex's later duplicate in its place), Josh's one, Sarah none; Example
  // Roads (an unknown sender), Example Health and Example Water Corp (no sender) are Unassigned: in no tab.
  const r = await sync();
  assert.equal(r.status, 200);
  assert.deepEqual(writes(r).map((w) => [w.title, w.a1]), [['Summary', 'A1'], ['Notes', 'A1'], ['David', 'A1'], ['Josh', 'A1'], ['Sarah', 'A1']]);
  assert.deepEqual(tabValues(r, 'David'), [AGENT, TRACKER[2], TRACKER[3], TRACKER[4], TRACKER[7], TRACKER[13]]);
  assert.deepEqual(tabValues(r, 'Josh'), [AGENT, TRACKER[5]]);
  assert.deepEqual(tabValues(r, 'Sarah'), [AGENT], 'a mailbox with no rows: row 1 only');
  for (const m of MAILBOXES) {
    assert.equal(tabValues(r, m.name).length - 1, r.rows.filter((x) => x.mailbox_id === m.id).length, `${m.name}: what Cortex counts`);
  }
  assert.equal(r.data.stats.rows - r.data.stats.unassigned, 6, 'every assigned row in exactly one tab');

  // Sender from other headers and as "Name <address>", cells exactly as typed (untrimmed, "=" kept), short rows padded
  // to row 1's width, a row past it kept whole, inactive mailboxes too, the later duplicate in its own place.
  const head = ['KDM_Email', 'date_logged', 'organisation', 'sender', 'Mailbox', 'from', 'note', '', 'reply_status'];
  const lines = [
    ['a@example.org', '2026-10-01', 'Org A', 'David@Example.com', '', '', ' as typed ', '', 'neutral'], // replaced by [6]
    ['b@example.org', '2026-10-01', 'Org B', '', 'Josh <JOSH@example.com>'],
    ['c@example.org', '2026-10-01', 'Org C', '', '', ' Kim@Example.com ', '=SUM(A1)'],
    ['d@example.org', '2026-10-01', 'Org D', 'nobody@example.com'], // Unassigned
    ['', '', '', 'david@example.com', '', '', 'no contact: skipped'],
    [],
    ['A@Example.org', '1/10/2026', 'Org A', 'josh@example.com', '', '', 'a again: the later row wins'],
    ['e@example.org', '', 'Org E', 'Sender <david@example.com>', '', '', '', '', '', 'past row 1'],
  ];
  const boxes = [
    { id: 'mb-david', name: 'David', addresses: ['david@example.com'], active: true },
    { id: 'mb-josh', name: ' Josh ', addresses: ['josh@example.com'], active: true },
    { id: 'mb-sarah', name: 'Sarah', addresses: ['sarah@example.com'], active: true },
    { id: 'mb-kim', name: 'Kim', addresses: ['kim@example.com'], active: false },
  ];
  const pad = (line) => [...line, ...Array(head.length - line.length).fill('')];
  const m = await sync({ mailboxes: boxes, values: { Tracker: [head, ...lines] } });
  assert.equal(m.status, 200);
  assert.deepEqual(writes(m).slice(2), [
    { title: 'David', a1: 'A1', values: [head, lines[7]] },
    { title: 'Josh', a1: 'A1', values: [head, pad(lines[1]), pad(lines[6])] },
    { title: 'Sarah', a1: 'A1', values: [head] },
    { title: 'Kim', a1: 'A1', values: [head, pad(lines[2])] },
  ]);
  assert.deepEqual(added(m), ['Notes', 'David', 'Josh', 'Sarah', 'Kim'], 'the trimmed names');
  assert.deepEqual([m.data.stats.tabs, m.data.stats.noTab], [['David', 'Josh', 'Sarah', 'Kim'], []]);
  assert.deepEqual([m.data.stats.rows, m.data.stats.unassigned, m.data.stats.duplicates, m.data.stats.skipped], [5, 1, 1, 1]);
  for (const b of boxes) {
    const keys = m.rows.filter((x) => x.mailbox_id === b.id).map((x) => x.row_key);
    const tab = tabValues(m, b.name.trim()).slice(1);
    assert.deepEqual(tab.map((line) => `${line[0].toLowerCase()}|${g.sheetDate(line[1]) || ''}`), keys, `${b.name}: the saved rows, in order`);
  }

  // sheetRows keeps its outputs and adds row 1 and each kept row's cells as read; mailboxTabs on its own.
  const parsed = g.sheetRows([head, ...lines]);
  assert.deepEqual(Object.keys(parsed).sort(), ['cells', 'duplicates', 'head', 'known', 'rows', 'skipped']);
  assert.equal(parsed.head, head);
  assert.deepEqual(parsed.cells, [lines[1], lines[2], lines[3], lines[6], lines[7]]);
  assert.deepEqual(parsed.rows.map((x) => x.row_key), ['b@example.org|2026-10-01', 'c@example.org|2026-10-01', 'd@example.org|2026-10-01', 'a@example.org|2026-10-01', 'e@example.org|']);
  assert.deepEqual(g.mailboxTabs({ head: ['a', 'b', 'c'], cells: [['x'], ['y', '', 'z', 'w'], ['u']] },
    [{ mailbox_id: 'm1' }, { mailbox_id: 'm1' }, { mailbox_id: null }], [{ id: 'm1', name: ' One ' }, { id: 'm2', name: 'Two' }], 'Sheet1'), {
    tabs: [{ title: 'One', values: [['a', 'b', 'c'], ['x', '', ''], ['y', '', 'z', 'w']] }, { title: 'Two', values: [['a', 'b', 'c']] }],
    noTab: [],
  });
});

await check('outreach mailbox tabs: never the agent’s tab; Summary / Notes names, duplicates and no name get no tab (noTab)', async () => {
  const SUMMARY_HEAD = ['Date', 'Mailbox', 'Sent', 'Replies', 'Reply rate', 'Bounces', 'Meetings'];
  const odd = [
    { id: 'mb-david', name: 'David', addresses: ['david@example.com', 'david@old.example.com'] },
    { id: 'mb-sum', name: 'summary', addresses: ['sum@example.com'] },
    { id: 'mb-trk', name: ' TRACKER ', addresses: ['josh@example.com'] }, // the agent's tab (the link's gid 777)
    { id: 'mb-dup', name: 'david ', addresses: ['old-box@example.com'] },
    { id: 'mb-blank', name: '  ', addresses: [] },
    { id: 'mb-null', name: null, addresses: [] },
    { id: 'mb-notes', name: 'Notes', addresses: [] },
    { id: 'mb-sarah', name: 'Sarah', addresses: ['sarah@example.com'] },
  ];
  const r = await sync({ mailboxes: odd });
  assert.equal(r.status, 200);
  assert.equal(r.data.stats.tab, 'Tracker');
  assert.deepEqual(r.data.stats.tabs, ['David', 'Sarah']);
  assert.deepEqual(r.data.stats.noTab, [
    { mailbox: 'summary', why: 'reserved' }, { mailbox: 'TRACKER', why: 'agent tab' }, { mailbox: 'david', why: 'duplicate' },
    { mailbox: '', why: 'no name' }, { mailbox: '', why: 'no name' }, { mailbox: 'Notes', why: 'reserved' },
  ]);
  assert.ok(!touched(r).some((t) => t.trim().toLowerCase() === 'tracker'), 'the agent’s tab is never added, cleared or written');
  assert.deepEqual(added(r), ['Notes', 'David', 'Sarah']);
  assert.deepEqual(cleared(r), ['Summary', 'Notes', 'David', 'Sarah']);
  assert.deepEqual(writes(r).map((w) => w.title), ['Summary', 'Notes', 'David', 'Sarah']);
  assert.deepEqual(tabValues(r, 'Summary')[0], SUMMARY_HEAD, 'Summary is still the Summary');
  assert.deepEqual(tabValues(r, 'Notes')[0], ['Created', 'Mailbox', 'Pinned', 'Author', 'Note'], 'Notes is still the Notes');
  assert.deepEqual(tabValues(r, 'David'), [AGENT, TRACKER[2], TRACKER[3], TRACKER[4], TRACKER[7], TRACKER[13]], 'the first David only');
  const by = Object.fromEntries(r.rows.map((x) => [x.row_key, x.mailbox_id]));
  assert.deepEqual([by['di@example.org|2026-10-13'], by['ed@example.org|2026-10-13']], ['mb-trk', 'mb-dup'], 'their rows are still saved, in no tab');

  // The link's gid on a mailbox-named tab: that tab is read, and that mailbox gets no tab, so it is never written (nor
  // grown, however small its grid).
  const josh = await sync({
    tabs: [{ sheetId: 0, title: 'Summary' }, { sheetId: 4, title: 'Tracker' }, { sheetId: 777, title: 'Josh', gridProperties: { rowCount: 2, columnCount: 2 } }],
    values: { Josh: TRACKER },
  });
  assert.equal(josh.status, 200);
  assert.equal(sheetRange(josh.sheets[1].url).title, 'Josh', 'read');
  assert.equal(josh.data.stats.tab, 'Josh');
  assert.deepEqual([josh.data.stats.tabs, josh.data.stats.noTab], [['David', 'Sarah'], [{ mailbox: 'Josh', why: 'agent tab' }]]);
  assert.ok(!touched(josh).includes('Josh'), 'the agent’s tab is never written');
  assert.ok(!grown(josh).includes(777), 'nor resized');
  assert.ok(!touched(josh).includes('Tracker') && !grown(josh).includes(4), 'nor a tab that is nobody’s');

  // The gid wins over a mailbox-named tab placed first; that one is Josh's tab, rewritten.
  const first = await sync({
    tabs: [{ sheetId: 3, title: 'josh' }, { sheetId: 0, title: 'Summary' }, { sheetId: 777, title: 'Tracker', gridProperties: { rowCount: 2, columnCount: 2 } }],
    values: { josh: TRACKER, Tracker: TRACKER },
  });
  assert.equal(first.status, 200);
  assert.equal(sheetRange(first.sheets[1].url).title, 'Tracker', 'the link’s tab, though a mailbox-named tab comes first');
  assert.ok(!touched(first).includes('Tracker') && !grown(first).includes(777), 'the agent’s tab is never written or resized');
  assert.deepEqual(writes(first).map((w) => w.title), ['Summary', 'Notes', 'David', 'josh', 'Sarah']);
  assert.deepEqual(first.data.stats.noTab, []);

  // No gid, even with a mailbox named like the agent's tab: refused before Google, nothing saved or written.
  const noGid = { sheet_url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, sheet_by: ADMIN_ID };
  const only = await sync({ settings: noGid, mailboxes: [...MAILBOXES, { id: 'mb-trk', name: 'tracker', addresses: [] }] });
  assert.deepEqual([only.status, only.data, syncError(only)], [400, { error: NO_GID }, [{ sync_error: NO_GID }]]);
  assert.equal(only.sheets.length + only.upserts.length, 0);
  // With the link's gid on it, it is read and that mailbox gets no tab.
  const withGid = await sync({ mailboxes: [...MAILBOXES, { id: 'mb-trk', name: 'tracker', addresses: [] }] });
  assert.equal(withGid.status, 200);
  assert.deepEqual([withGid.data.stats.tabs, withGid.data.stats.noTab], [['David', 'Josh', 'Sarah'], [{ mailbox: 'tracker', why: 'agent tab' }]]);
  assert.ok(!touched(withGid).some((t) => t.toLowerCase() === 'tracker'));
  // Two mailboxes named like the agent's tab: both 'agent tab' (the stronger reason), neither written.
  const twice = await sync({ mailboxes: [{ id: 'mb-a', name: 'Tracker', addresses: [] }, { id: 'mb-b', name: 'tracker', addresses: [] }] });
  assert.deepEqual(twice.data.stats.noTab, [{ mailbox: 'Tracker', why: 'agent tab' }, { mailbox: 'tracker', why: 'agent tab' }]);
  assert.deepEqual(twice.data.stats.tabs, []);
  assert.deepEqual(writes(twice).map((w) => w.title), ['Summary', 'Notes']);
});

await check('outreach write-back: one addSheet (sized) for every missing tab; then one batchClear and one RAW batchUpdate, after the database', async () => {
  const W = AGENT.length; // a mailbox tab is as wide as the agent's row 1
  const all = await sync({ tabs: [{ sheetId: 777, title: 'Tracker' }] });
  assert.equal(all.status, 200);
  const add = all.sheets.filter((c) => c.url.startsWith(`${SHEET}:batchUpdate`));
  assert.equal(add.length, 1, 'one request, however many tabs are missing');
  assert.equal(add[0].method, 'POST');
  const grid = (rowCount, columnCount) => ({ rowCount, columnCount });
  assert.deepEqual(add[0].json(), {
    requests: [['Summary', grid(1000, 26)], ['Notes', grid(1000, 26)], ['David', grid(1000, W)], ['Josh', grid(1000, W)], ['Sarah', grid(1000, W)]]
      .map(([title, gridProperties]) => ({ addSheet: { properties: { title, gridProperties } } })),
  }, 'at least Google’s 1,000 × 26, and as wide as the agent’s tab');
  const steps = all.sheets.map((c) => {
    if (c.url.startsWith(`${SHEET}/values/`)) {
      const { title, a1, action } = sheetRange(c.url);
      return `${c.method} ${title}${a1 ? `!${a1}` : ''}${action ? `:${action}` : ''}`;
    }
    return `${c.method} ${c.url.slice(SHEET.length)}`;
  });
  assert.deepEqual(steps, [
    'GET ?fields=sheets.properties', 'GET Tracker!A1:AZ', 'POST :batchUpdate', 'POST /values:batchClear', 'POST /values:batchUpdate',
  ], 'the same five Sheets requests however many mailboxes there are');
  const [clear] = all.sheets.filter((c) => c.url === `${SHEET}/values:batchClear`);
  assert.equal(clear.method, 'POST');
  assert.equal(clear.headers.get('content-type'), 'application/json');
  assert.deepEqual(clear.json(), { ranges: ["'Summary'", "'Notes'", "'David'", "'Josh'", "'Sarah'"] }, 'whole tabs, quoted');
  const [update] = all.sheets.filter((c) => c.url === `${SHEET}/values:batchUpdate`);
  assert.equal(update.method, 'POST');
  assert.equal(update.headers.get('content-type'), 'application/json');
  assert.equal(update.headers.get('authorization'), 'Bearer fresh-access-token');
  const body = update.json();
  assert.deepEqual(Object.keys(body), ['valueInputOption', 'data']);
  assert.equal(body.valueInputOption, 'RAW', 'plain values: a cell starting with "=" stays text');
  assert.deepEqual(body.data.map((d) => [d.range, d.majorDimension]), [
    ["'Summary'!A1", 'ROWS'], ["'Notes'!A1", 'ROWS'], ["'David'!A1", 'ROWS'], ["'Josh'!A1", 'ROWS'], ["'Sarah'!A1", 'ROWS'],
  ]);
  const [gone] = all.to(`${REST}/outreach_emails`).filter((c) => c.method === 'PATCH');
  const after = Math.max(all.calls.indexOf(all.upserts.at(-1)), all.calls.indexOf(gone), ...all.to(`${REST}/outreach_notes`).map((c) => all.calls.indexOf(c)));
  assert.ok([add[0], clear, update].every((c) => all.calls.indexOf(c) > after), 'written back after the database (and the notes are read first)');
  assert.ok(all.calls.indexOf(clear) < all.calls.indexOf(update), 'cleared, then written');
  assert.ok(all.calls.indexOf(add[0]) < all.calls.indexOf(clear), 'added, then cleared');

  // Every tab there already, big enough (in any case, with spaces): no batchUpdate, and each keeps its own title.
  const wide = { rowCount: 1000, columnCount: 40 };
  const present = await sync({ tabs: [
    { sheetId: 777, title: 'Tracker' }, { sheetId: 1, title: 'summary' }, { sheetId: 2, title: 'Notes' }, { sheetId: 3, title: 'JOSH', gridProperties: wide },
    { sheetId: 4, title: 'david', gridProperties: wide }, { sheetId: 5, title: ' Sarah ', gridProperties: wide },
  ] });
  assert.equal(present.status, 200);
  assert.equal(present.sheets.filter((c) => c.url.startsWith(`${SHEET}:batchUpdate`)).length, 0, 'no batchUpdate at all');
  assert.deepEqual(cleared(present), ['summary', 'Notes', 'david', 'JOSH', ' Sarah '], 'the existing tabs’ own titles');
  assert.deepEqual(writes(present).map((w) => w.title), ['summary', 'Notes', 'david', 'JOSH', ' Sarah ']);
  assert.deepEqual(present.data.stats.tabs, ['david', 'JOSH', ' Sarah '], 'the titles written');

  const some = await sync({ tabs: [{ sheetId: 0, title: 'Summary' }, { sheetId: 777, title: 'Tracker' }, { sheetId: 3, title: 'Josh', gridProperties: wide }] });
  assert.deepEqual(added(some), ['Notes', 'David', 'Sarah'], 'only the missing ones');
  assert.deepEqual(grown(some), [], 'and nothing that fits');
  assert.deepEqual(cleared(some), ['Summary', 'Notes', 'David', 'Josh', 'Sarah']);
});

await check('outreach write-back: an existing tab too small is grown (never shrunk) in the same batchUpdate; one that fits is left alone', async () => {
  const W = AGENT.length;
  const grow = (sheetId, rowCount, columnCount) => ({ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount, columnCount } }, fields: GRID_FIELDS } });
  // TRACKER needs: Summary 12 rows × 7, Notes 4 × 5, David 6 × W, Josh 2 × W, Sarah 1 × W.
  const r = await sync({ tabs: [
    { sheetId: 777, title: 'Tracker', gridProperties: { rowCount: 1, columnCount: 1 } }, // the agent's: never resized
    { sheetId: 1, title: 'Summary', gridProperties: { rowCount: 5, columnCount: 100 } }, // rows grown, its 100 columns kept
    { sheetId: 2, title: 'Notes', gridProperties: { rowCount: 2, columnCount: 3 } }, // both grown
    { sheetId: 3, title: 'David' }, // 1,000 × 26: as wide as the agent's tab, its 1,000 rows kept
    { sheetId: 4, title: 'Josh', gridProperties: { rowCount: 5000, columnCount: 60 } }, // big enough: untouched
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual([tabValues(r, 'Summary').length, tabValues(r, 'Notes').length, tabValues(r, 'David').length], [12, 4, 6]);
  const calls = r.sheets.filter((c) => c.url === `${SHEET}:batchUpdate`);
  assert.equal(calls.length, 1, 'adding and growing in one request');
  assert.deepEqual(calls[0].json(), {
    requests: [grow(1, 12, 100), grow(2, 4, 5), grow(3, 1000, W), { addSheet: { properties: { title: 'Sarah', gridProperties: { rowCount: 1000, columnCount: W } } } }],
  });
  assert.ok(r.calls.indexOf(calls[0]) < r.calls.indexOf(r.sheets.find((c) => c.url === `${SHEET}/values:batchUpdate`)), 'grown before the write');

  // Exactly big enough → no batchUpdate.
  const fit = await sync({ tabs: [
    { sheetId: 777, title: 'Tracker', gridProperties: { rowCount: 1, columnCount: 1 } }, { sheetId: 1, title: 'Summary', gridProperties: { rowCount: 12, columnCount: 7 } },
    { sheetId: 2, title: 'Notes', gridProperties: { rowCount: 4, columnCount: 5 } }, { sheetId: 3, title: 'David', gridProperties: { rowCount: 6, columnCount: W } },
    { sheetId: 4, title: 'Josh', gridProperties: { rowCount: 2, columnCount: W } }, { sheetId: 5, title: 'Sarah', gridProperties: { rowCount: 1, columnCount: W } },
  ] });
  assert.equal(fit.status, 200);
  assert.equal(fit.sheets.filter((c) => c.url === `${SHEET}:batchUpdate`).length, 0);
  // A tab Google gives no grid for (not a grid tab): its size is unknown, so it is never resized.
  const odd = await sync({ tabs: [
    { sheetId: 777, title: 'Tracker' }, { sheetId: 1, title: 'Summary' }, { sheetId: 2, title: 'Notes' }, { sheetId: 3, title: 'David', gridProperties: undefined },
    { sheetId: 4, title: 'Josh', gridProperties: { rowCount: 2, columnCount: W } }, { sheetId: 5, title: 'Sarah', gridProperties: { rowCount: 1, columnCount: W } },
  ] });
  assert.equal(odd.status, 200);
  assert.equal(odd.sheets.filter((c) => c.url === `${SHEET}:batchUpdate`).length, 0);

  // Summary past 1,000 rows (1,001 sent days): grown when there, added that big when not.
  const days = [['kdm_email', 'sent_date', 'sender'],
    ...Array.from({ length: 1001 }, (_, i) => [`p${i}@example.org`, new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10), 'david@example.com'])];
  const long = await sync({ values: { Tracker: days } }); // Summary there (1,000 × 26)
  assert.equal(long.status, 200);
  assert.equal(tabValues(long, 'Summary').length, 1007, 'row 1, 1,001 days, a blank row, 3 mailboxes and all');
  assert.deepEqual(sizeRequests(long), [
    grow(0, 1007, 26),
    ...[['Notes', 1000], ['David', 1002], ['Josh', 1000], ['Sarah', 1000]].map(([title, rowCount]) => ({ addSheet: { properties: { title, gridProperties: { rowCount, columnCount: 26 } } } })),
  ]);
  const fresh = await sync({ tabs: [{ sheetId: 777, title: 'Tracker' }], values: { Tracker: days } });
  assert.deepEqual(sizeRequests(fresh)[0], { addSheet: { properties: { title: 'Summary', gridProperties: { rowCount: 1007, columnCount: 26 } } } });
});

await check('outreach write-back: another sync added or grew the tabs first → found again and written; still missing or small → the error', async () => {
  const W = AGENT.length;
  const wide = { rowCount: 1000, columnCount: W };
  const taken = () => reply(400, { error: { code: 400, message: 'Invalid requests[0].addSheet: A sheet with the name "Summary" already exists.', status: 'INVALID_ARGUMENT' } });
  const metaThen = (later, first = [{ sheetId: 777, title: 'Tracker' }]) => {
    let n = 0;
    return () => reply(200, { sheets: (n++ ? later : first).map((p) => ({ properties: gridTab(p) })) });
  };
  const theirs = [
    { sheetId: 777, title: 'Tracker' }, { sheetId: 8, title: 'Summary' }, { sheetId: 9, title: 'Notes' },
    { sheetId: 10, title: 'David', gridProperties: wide }, { sheetId: 11, title: 'josh', gridProperties: wide }, { sheetId: 12, title: 'Sarah', gridProperties: wide },
  ];
  const raced = await sync({ routes: { [`${SHEET}?`]: metaThen(theirs), [`${SHEET}:batchUpdate`]: taken } });
  assert.equal(raced.status, 200, JSON.stringify(raced.data));
  assert.equal(raced.sheets.filter((c) => c.url.startsWith(`${SHEET}?`)).length, 2, 'the tabs read again');
  assert.deepEqual(writes(raced).map((w) => w.title), ['Summary', 'Notes', 'David', 'josh', 'Sarah'], 'written, under the titles found');
  assert.deepEqual(cleared(raced), ['Summary', 'Notes', 'David', 'josh', 'Sarah']);
  assert.equal(raced.patches.at(-1).json().sync_error, '');

  // Only growing to do, and the other sync grew it first.
  const small = theirs.map((t) => (t.title === 'David' ? { ...t, gridProperties: { rowCount: 1000, columnCount: 26 } } : t));
  const grewFirst = await sync({ routes: { [`${SHEET}?`]: metaThen(theirs, small), [`${SHEET}:batchUpdate`]: taken } });
  assert.equal(grewFirst.status, 200, JSON.stringify(grewFirst.data));
  assert.deepEqual(grown(grewFirst), [10]);
  assert.deepEqual(writes(grewFirst).map((w) => w.title), ['Summary', 'Notes', 'David', 'josh', 'Sarah']);

  for (const [later, first] of [
    [theirs.slice(0, 2)], [theirs.filter((t) => t.title !== 'Sarah')], [small], // missing, or there but too small
    [small, small],
  ]) {
    const still = await sync({ routes: { [`${SHEET}?`]: metaThen(later, first), [`${SHEET}:batchUpdate`]: taken } });
    assert.equal(still.status, 502, JSON.stringify(later));
    assert.match(still.data.error, /already exists/);
    assert.deepEqual([...cleared(still), ...writes(still)], [], 'nothing cleared or written');
    assert.deepEqual(syncError(still), [{ sync_error: still.data.error }]);
  }
});

await check('outreach settings: synced_at, an empty sync_error and the stats; returns { ok, stats }', async () => {
  const r = await sync();
  assert.equal(r.status, 200);
  const stats = {
    rows: 9, contacts: 6, sent: 5, replies: 2, bounced: 1, meetings: 1, unassigned: 3, duplicates: 1, skipped: 1, missing: 2, tab: 'Tracker',
    tabs: ['David', 'Josh', 'Sarah'], noTab: [],
  };
  assert.deepEqual(r.data, { ok: true, stats });
  assert.equal(r.patches.length, 1);
  const [patch] = r.patches;
  // Only while the link and its reader are the ones this sync read, and no newer sync has saved its results.
  assert.equal(patch.url, `${REST}/outreach_settings?id=eq.1&sheet_url=eq.${encodeURIComponent(SHEET_URL)}&sheet_by=eq.${ADMIN_ID}`
    + `&or=(synced_at.is.null,synced_at.lt.${encodeURIComponent(r.rows[0].synced_at)})`);
  const q = new URL(patch.url).searchParams;
  assert.equal(q.get('sheet_url'), `eq.${SHEET_URL}`);
  assert.equal(q.get('sheet_by'), `eq.${ADMIN_ID}`);
  assert.equal(q.get('or'), `(synced_at.is.null,synced_at.lt.${r.rows[0].synced_at})`);
  assert.equal(patch.headers.get('apikey'), 'sb_secret_test');
  assert.equal(patch.headers.get('prefer'), 'return=minimal');
  assert.deepEqual(patch.json(), { synced_at: r.rows[0].synced_at, sync_error: '', sync_stats: stats });
  assert.ok(r.calls.indexOf(patch) === r.calls.length - 1, 'the last call');
  assert.ok(!/access-token|refresh-token/.test(r.text), 'no token in the response');
});

await check('outreach errors: saved as sync_error and returned; never a token; the database keeps the emails', async () => {
  const unshared = 'The outreach sheet wasn’t found or isn’t shared with David Example.';
  const cases = [
    ['meta 404', { [`${SHEET}?`]: () => reply(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }) }, 404, unshared],
    ['read 403', { [`${SHEET}/values/`]: () => reply(403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }) }, 403, unshared],
    ['scope', { [`${SHEET}?`]: () => reply(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }) },
      409, 'David Example needs to reconnect Google in Settings → Business.'],
    ['API off', { [`${SHEET}?`]: () => reply(403, { error: { code: 403, message: 'Google Sheets API has not been used in project 123 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } }) },
      502, 'Google Sheets API has not been used in project 123 before or it is disabled.'],
    ['mailboxes', { [`${REST}/outreach_mailboxes`]: () => reply(500, { code: 'XX000', message: 'boom' }) }, 502, 'Could not read the outreach mailboxes.'],
    ['upsert', { [`${REST}/outreach_emails`]: () => reply(400, { code: '22007', message: 'invalid input syntax for type date' }) }, 502, 'Could not save the outreach emails.'],
    ['network', { [`${SHEET}?`]: () => { throw new TypeError('fetch failed'); } }, 500, SYNC_FAILED],
  ];
  for (const [name, routes, status, error] of cases) {
    const r = await sync({ routes });
    assert.equal(r.status, status, name);
    assert.deepEqual(r.data, { error }, name);
    assert.deepEqual(syncError(r), [{ sync_error: error }], `${name}: sync_error only (no synced_at or stats)`);
    const guard = new URL(r.patches[0].url).searchParams;
    assert.ok(guard.get('sheet_url') === `eq.${SHEET_URL}` && guard.get('sheet_by') === `eq.${ADMIN_ID}` && /^\(synced_at\.is\.null,synced_at\.lt\./.test(guard.get('or')),
      `${name}: only while the link, its reader and the last results are the ones this sync started with`);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN, name);
    const everything = [r.text, ...r.patches.map((c) => c.body), ...r.logs].join('\n');
    assert.ok(!/access-token|refresh-token/.test(everything), `${name}: no token in the response, sync_error or logs`);
  }
  const upsert = await sync({ routes: { [`${REST}/outreach_emails`]: () => reply(500, {}) } });
  assert.equal(upsert.upserts.length, 1, 'stops at the first failed batch');
  assert.equal(upsert.to(`${REST}/outreach_emails`).filter((c) => c.method === 'PATCH').length, 0, 'nothing marked missing');
  assert.equal(upsert.sheets.length, 2, 'no write-back');

  const denied = () => reply(403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } });
  const readOnly = await sync({ routes: { [`${SHEET}:batchUpdate`]: denied } });
  assert.equal(readOnly.status, 403);
  assert.deepEqual(readOnly.data, { error: 'David Example can’t edit the outreach sheet.' });
  assert.equal(readOnly.upserts.length, 1, 'the emails were saved before the write-back');
  assert.deepEqual(syncError(readOnly), [{ sync_error: 'David Example can’t edit the outreach sheet.' }]);
  // Every tab there already and big enough (no batchUpdate): the batchClear or the values batchUpdate refused → the same message.
  const allTabs = [{ sheetId: 777, title: 'Tracker' }, ...['Summary', 'Notes', 'David', 'Josh', 'Sarah'].map((title, i) => ({
    sheetId: i + 1, title, gridProperties: { rowCount: 1000, columnCount: 40 },
  }))];
  for (const path of ['/values:batchClear', '/values:batchUpdate']) {
    const r = await sync({ tabs: allTabs, routes: { [`${SHEET}${path}`]: denied } });
    assert.equal(r.status, 403, path);
    assert.deepEqual(r.data, { error: 'David Example can’t edit the outreach sheet.' }, path);
    assert.deepEqual(syncError(r), [{ sync_error: 'David Example can’t edit the outreach sheet.' }], path);
    assert.equal(r.sheets.filter((c) => c.url.startsWith(`${SHEET}:batchUpdate`)).length, 0, `${path}: nothing to add`);
    assert.equal(r.upserts.length, 1, `${path}: the emails were saved before the write-back`);
  }
  const clearDown = await sync({ tabs: allTabs, routes: { [`${SHEET}/values:batchClear`]: denied } });
  assert.equal(clearDown.sheets.filter((c) => c.url === `${SHEET}/values:batchUpdate`).length, 0, 'not written when the clear failed');

  // Google echoing the access token in a message: hidden in the response and in sync_error.
  const echo = await sync({ routes: { [`${SHEET}/values/`]: () => reply(400, { error: { code: 400, message: 'Bad token fresh-access-token in\nrequest' } }) } });
  assert.equal(echo.status, 502);
  assert.deepEqual(echo.data, { error: 'Bad token … in request' });
  assert.deepEqual(syncError(echo), [{ sync_error: 'Bad token … in request' }]);

  // The sync_error write failing doesn't hide the error.
  const both = await sync({
    routes: {
      [`${RPC}/google_token`]: () => reply(200, null),
      [`${REST}/outreach_settings`]: (c) => (c.method === 'GET' ? reply(200, [{ sheet_url: SHEET_URL, sheet_by: ADMIN_ID }]) : reply(500, { message: 'down' })),
    },
  });
  assert.equal(both.status, 409);
  assert.deepEqual(both.data, { error: 'David Example needs to connect Google in Settings → Business.' });

  const settingsDown = await sync({ routes: { [`${REST}/outreach_settings`]: () => reply(500, { message: 'down' }) } });
  assert.equal(settingsDown.status, 502);
  assert.deepEqual(settingsDown.data, { error: 'Could not read the outreach settings.' });
  assert.equal(settingsDown.patches.length, 0);
});

// ── Calendar ────────────────────────────────────────────────────────────────────────────────────────────────────
// Fictional people and events only (example.com).

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const CAL_SCOPES = `openid email ${CAL_SCOPE}`;
const CAL_FIELDS = 'nextPageToken,items(id,status,summary,visibility,start,end,eventType,attendees(self,responseStatus))';
const NOT_ADMIN = 'Only admins can use Google from Cortex.';
const CAL_RECONNECT = 'Google Calendar needs reconnecting.';
const STAFF = { ...ME, uid: 'u-sam', name: 'Sam Example', email: 'sam@example.com', admin: false };
const asStaff = { [`${RPC}/google_me`]: () => reply(200, STAFF) };
const U1 = 'c0000000-0000-4000-8000-0000000000a1';
const U2 = 'c0000000-0000-4000-8000-0000000000a2';
const U3 = 'c0000000-0000-4000-8000-0000000000a3';
const calendarPage = (result) => `${ORIGIN}/#/calendar?google=${result}`;
const calState = (over = {}) => stateFor({ purpose: 'calendar', ...over });
const calToken = (over = {}) => ({
  access_token: 'first-access-token', refresh_token: 'new-refresh-token', scope: CAL_SCOPES, token_type: 'Bearer', id_token: idToken({}), ...over,
});
const SECRETS = ['Dial-in PIN 4321', '1 Example St', 'meet.google.com', 'pat@example.com', 'Dentist', 'Salary review', 'Declined workshop', 'Cancelled call', 'Pat’s birthday'];

const EVENTS = [
  {
    id: 'ev-timed', status: 'confirmed', summary: '  Weekly sync with Example Council  ', description: 'Dial-in PIN 4321', location: '1 Example St, Sydney',
    hangoutLink: 'https://meet.google.com/xyz-abcd-efg', visibility: 'default', eventType: 'default',
    start: { dateTime: '2026-10-21T09:30:00+11:00', timeZone: 'Australia/Sydney' }, end: { dateTime: '2026-10-21T10:00:00+11:00', timeZone: 'Australia/Sydney' },
    attendees: [{ self: true, responseStatus: 'accepted', email: 'ana@example.com' }],
  },
  { id: 'ev-overnight', status: 'confirmed', summary: 'Flight to Perth', start: { dateTime: '2026-10-21T23:00:00Z' }, end: { dateTime: '2026-10-22T02:15:00Z' } },
  { id: 'ev-allday', status: 'confirmed', summary: 'Example Expo', start: { date: '2026-10-26' }, end: { date: '2026-10-29' } },
  { id: 'ev-oneday', status: 'confirmed', summary: 'Public holiday', start: { date: '2026-10-30' }, end: { date: '2026-10-31' } },
  { id: 'ev-private', status: 'confirmed', visibility: 'private', summary: 'Dentist', start: { dateTime: '2026-10-22T14:00:00+08:00' }, end: { dateTime: '2026-10-22T15:00:00+08:00' } },
  { id: 'ev-confidential', status: 'confirmed', visibility: 'confidential', summary: 'Salary review', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } },
  { id: 'ev-ooo', status: 'confirmed', eventType: 'outOfOffice', summary: 'Out of office', start: { dateTime: '2026-11-05T00:00:00+04:00' }, end: { dateTime: '2026-11-06T00:00:00+04:00' } },
  { id: 'ev-tentative', status: 'tentative', summary: 'Maybe lunch', start: { dateTime: '2026-10-27T03:00:00Z' }, end: { dateTime: '2026-10-27T04:00:00Z' }, attendees: [{ self: true, responseStatus: 'tentative' }] },
  { id: 'ev-cancelled', status: 'cancelled', summary: 'Cancelled call', start: { dateTime: '2026-10-23T01:00:00Z' }, end: { dateTime: '2026-10-23T02:00:00Z' } },
  { id: 'ev-declined', status: 'confirmed', summary: 'Declined workshop', start: { dateTime: '2026-10-24T01:00:00Z' }, end: { dateTime: '2026-10-24T02:00:00Z' }, attendees: [{ self: true, responseStatus: 'declined' }] },
  { id: 'ev-other-declined', status: 'confirmed', summary: 'Not my decline', start: { dateTime: '2026-10-28T03:00:00Z' }, end: { dateTime: '2026-10-28T03:30:00Z' }, attendees: [{ email: 'pat@example.com', responseStatus: 'declined' }] },
  { id: 'ev-working', status: 'confirmed', eventType: 'workingLocation', summary: 'Home', start: { date: '2026-10-21' }, end: { date: '2026-10-22' } },
  { id: 'ev-birthday', status: 'confirmed', eventType: 'birthday', summary: 'Pat’s birthday', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } },
];
const timed = (google_id, title, start_at, end_at, busy = false) => ({
  google_id, title, busy, all_day: false, start_date: start_at.slice(0, 10), end_date: end_at.slice(0, 10), start_at, end_at,
});
const allDay = (google_id, title, start_date, end_date, busy = false) => ({
  google_id, title, busy, all_day: true, start_date, end_date, start_at: null, end_at: null,
});
const ROWS = [
  timed('ev-timed', 'Weekly sync with Example Council', '2026-10-20T22:30:00.000Z', '2026-10-20T23:00:00.000Z'),
  timed('ev-overnight', 'Flight to Perth', '2026-10-21T23:00:00.000Z', '2026-10-22T02:15:00.000Z'),
  allDay('ev-allday', 'Example Expo', '2026-10-26', '2026-10-28'),
  allDay('ev-oneday', 'Public holiday', '2026-10-30', '2026-10-30'),
  timed('ev-private', '', '2026-10-22T06:00:00.000Z', '2026-10-22T07:00:00.000Z', true),
  allDay('ev-confidential', '', '2026-11-02', '2026-11-02', true),
  timed('ev-ooo', 'Out of office', '2026-11-04T20:00:00.000Z', '2026-11-05T20:00:00.000Z'),
  timed('ev-tentative', 'Maybe lunch', '2026-10-27T03:00:00.000Z', '2026-10-27T04:00:00.000Z'),
  timed('ev-other-declined', 'Not my decline', '2026-10-28T03:00:00.000Z', '2026-10-28T03:30:00.000Z'),
];

// PostgREST and Google for calendar-sync: each claimed person has their own stored refresh token
// (stored-refresh-token-<id>), which the token endpoint swaps for their own access token (fresh-access-token-<id>).
function calendarRoutes({
  claim = [U1], scopes = `${g.SCOPES} ${CAL_SCOPE}`, events = EVENTS, save = () => reply(200, true),
} = {}) {
  return {
    [`${RPC}/calendar_claim`]: () => reply(200, claim),
    [`${RPC}/calendar_save`]: save,
    [`${RPC}/google_token`]: (c) => {
      const user = c.json().p_user;
      return reply(200, { email: 'person@example.com', refresh_token: `stored-refresh-token-${user}`, scopes: typeof scopes === 'function' ? scopes(user) : scopes });
    },
    [TOKEN_URL]: (c) => reply(200, {
      access_token: c.form.get('refresh_token').replace('stored-refresh-token', 'fresh-access-token'), expires_in: 3599, token_type: 'Bearer',
    }),
    [CAL]: typeof events === 'function' ? events : () => reply(200, { kind: 'calendar#events', items: events }),
  };
}

/** One calendar-sync request. → run()'s result plus logs, the window(s) it may have used, the saves and the events calls. */
async function calSync({ body = {}, routes = {}, ...opts } = {}, runOpts = {}) {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    const before = new Date();
    const r = await run('calendar-sync', { body, routes: { ...calendarRoutes(opts), ...routes }, ...runOpts });
    const after = new Date();
    const saves = r.to(`${RPC}/calendar_save`);
    // Sydney's day when the run started: the one before the request or the one after it (a run across midnight).
    const windows = [before, after].map((t) => g.calendarWindow(g.teamToday(t)));
    return { ...r, logs, before, after, windows, saves, saved: saves.map((c) => c.json()), events: r.to(CAL) };
  } finally {
    console.error = original;
  }
}
const personOf = (call) => call.headers.get('authorization').replace('Bearer fresh-access-token-', '');
const noTokens = (r) => {
  const everything = [r.text, ...r.saves.map((c) => c.body), ...r.to(`${RPC}/calendar_claim`).map((c) => c.body), ...r.logs].join('\n');
  assert.ok(!/access-token|refresh-token/.test(everything), 'no Google token in a calendar_save body, the claim, the response or the logs');
};

await check('calendar helpers: hasCalendar wants a calendar scope as a whole entry of the list', () => {
  for (const yes of [CAL_SCOPES, 'https://www.googleapis.com/auth/calendar', `${g.SCOPES} ${CAL_SCOPE}`, `openid\t${CAL_SCOPE}\nemail`, ` ${CAL_SCOPE} `]) {
    assert.equal(g.hasCalendar(yes), true, yes);
  }
  for (const no of [
    '', null, undefined, 'openid email', g.SCOPES, `${CAL_SCOPE}.extra`, 'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonlyx', `x${CAL_SCOPE}`, 'https://www.googleapis.com/auth/calendar/', 'calendar.readonly',
  ]) assert.equal(g.hasCalendar(no), false, String(no));
  assert.equal(g.CALENDAR_SCOPES, CAL_SCOPES);
});

await check('calendar helpers: calendarWindow is last month’s first day to month +11’s last, padded a day each side in UTC', () => {
  assert.deepEqual(g.calendarWindow('2026-10-21'), {
    from: '2026-09-01', to: '2027-09-30', timeMin: '2026-08-31T00:00:00Z', timeMax: '2027-10-02T00:00:00Z',
  });
  assert.deepEqual(g.calendarWindow('2026-01-05'), { from: '2025-12-01', to: '2026-12-31', timeMin: '2025-11-30T00:00:00Z', timeMax: '2027-01-02T00:00:00Z' });
  assert.deepEqual(g.calendarWindow('2026-12-31'), { from: '2026-11-01', to: '2027-11-30', timeMin: '2026-10-31T00:00:00Z', timeMax: '2027-12-02T00:00:00Z' });
  assert.deepEqual(g.calendarWindow('2027-03-01'), { from: '2027-02-01', to: '2028-02-29', timeMin: '2027-01-31T00:00:00Z', timeMax: '2028-03-02T00:00:00Z' }, 'a leap February');
  assert.deepEqual(g.calendarWindow('2026-03-31'), { from: '2026-02-01', to: '2027-02-28', timeMin: '2026-01-31T00:00:00Z', timeMax: '2027-03-02T00:00:00Z' });
  for (const bad of ['', null, '2026-13-01', '2026-02-30', '21/10/2026', '2026-10-21T00:00:00Z']) assert.throws(() => g.calendarWindow(bad), String(bad));
  // Sydney's day (AEDT, UTC+11, in October 2026).
  assert.equal(g.teamToday(new Date('2026-10-21T12:59:00Z')), '2026-10-21');
  assert.equal(g.teamToday(new Date('2026-10-21T13:00:00Z')), '2026-10-22');
});

await check('calendar helpers: meetingRow keeps only the title and times; drops cancelled, declined, working location and birthdays', () => {
  assert.deepEqual(EVENTS.map(g.meetingRow).filter(Boolean), ROWS);
  const dropped = EVENTS.filter((ev) => g.meetingRow(ev) === null).map((ev) => ev.id);
  assert.deepEqual(dropped, ['ev-cancelled', 'ev-declined', 'ev-working', 'ev-birthday']);
  for (const row of EVENTS.map(g.meetingRow).filter(Boolean)) {
    assert.deepEqual(Object.keys(row), ['google_id', 'title', 'busy', 'all_day', 'start_date', 'end_date', 'start_at', 'end_at']);
  }
  const at = (over) => g.meetingRow({ id: 'x', summary: 'T', start: { dateTime: '2026-10-21T01:00:00Z' }, end: { dateTime: '2026-10-21T02:00:00Z' }, ...over });
  assert.equal(at({ summary: 'é'.repeat(250) }).title, 'é'.repeat(200), 'at most 200 characters');
  assert.equal(at({ summary: '😀'.repeat(250) }).title, '😀'.repeat(200), 'characters, not UTF-16 units');
  assert.equal(at({ summary: undefined }).title, '');
  assert.deepEqual([at({ visibility: 'private' }).busy, at({ visibility: 'private' }).title], [true, '']);
  assert.deepEqual([at({ visibility: 'public' }).busy, at({ visibility: 'public' }).title], [false, 'T']);
  assert.deepEqual(at({ end: { dateTime: '2026-10-20T23:00:00Z' } }), timed('x', 'T', '2026-10-21T01:00:00.000Z', '2026-10-21T01:00:00.000Z'), 'an end before the start → the start');
  assert.deepEqual(at({ end: undefined }), timed('x', 'T', '2026-10-21T01:00:00.000Z', '2026-10-21T01:00:00.000Z'));
  assert.deepEqual(at({ start: { date: '2026-10-30' }, end: { date: '2026-10-30' } }), allDay('x', 'T', '2026-10-30', '2026-10-30'), 'never ends before it starts');
  assert.deepEqual(at({ start: { date: '2026-10-30' }, end: {} }), allDay('x', 'T', '2026-10-30', '2026-10-30'));
  assert.deepEqual(at({ start: { date: '2026-12-31' }, end: { date: '2027-01-03' } }), allDay('x', 'T', '2026-12-31', '2027-01-02'));
  assert.deepEqual(at({ start: { date: '2028-02-28' }, end: { date: '2028-03-01' } }), allDay('x', 'T', '2028-02-28', '2028-02-29'));
  assert.equal(at({ attendees: [{ self: true, responseStatus: 'accepted' }, { responseStatus: 'declined' }] }).google_id, 'x');
  for (const bad of [
    null, 'event', {}, { summary: 'no id' }, { id: '', summary: 'T' }, { id: 'x' }, { id: 'x', start: {} }, { id: 'x', start: { date: '2026-02-30' } },
    { id: 'x', start: { dateTime: 'soon' } },
  ]) assert.equal(g.meetingRow(bad), null, JSON.stringify(bad));
});

await check('calendar connect: any staff member; calendar.readonly only, offline, consent, include_granted_scopes, purpose in the state', async () => {
  const r = await run('connect', { body: { origin: ORIGIN, purpose: 'calendar' }, routes: asStaff });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data), ['url']);
  const url = new URL(r.data.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  const { state, ...rest } = Object.fromEntries(url.searchParams);
  assert.deepEqual(rest, {
    client_id: ENV.GOOGLE_CLIENT_ID, redirect_uri: `${SUPABASE}/functions/v1/google/callback`, response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/calendar.readonly', access_type: 'offline', prompt: 'consent',
    include_granted_scopes: 'true', hd: 'assetstackai.com', login_hint: 'sam@example.com',
  });
  const payload = await g.verifyState(state, SECRET);
  assert.deepEqual([payload.uid, payload.email, payload.origin, payload.purpose], ['u-sam', 'sam@example.com', ORIGIN, 'calendar']);
  assert.equal(r.to(`${RPC}/google_token`).length + r.to(TOKEN_URL).length, 0);

  const admin = await run('connect', { body: { origin: ORIGIN, purpose: 'calendar' } });
  assert.equal(new URL(admin.data.url).searchParams.get('scope'), CAL_SCOPES, 'admins connect their calendar the same way');
  const bad = await run('connect', { body: { origin: 'https://evil.example.com', purpose: 'calendar' }, routes: asStaff });
  assert.equal(bad.status, 400, 'the origin is still checked');
  const outsider = await run('connect', { body: { origin: ORIGIN, purpose: 'calendar' }, routes: { [`${RPC}/google_me`]: () => reply(403, { code: '42501', message: 'Not allowed' }) } });
  assert.equal(outsider.status, 403, 'not staff: refused by google_me');
  const anon = await run('connect', { auth: '', body: { origin: ORIGIN, purpose: 'calendar' } });
  assert.deepEqual([anon.status, anon.calls.length], [401, 0]);
});

await check('calendar connect: staff are still refused a plain connect, send and contract; an admin’s plain connect is unchanged', async () => {
  for (const [path, body] of [
    ['connect', { origin: ORIGIN }], ['connect', { origin: ORIGIN, purpose: 'Calendar' }], ['connect', { origin: ORIGIN, purpose: 'business' }],
    ['connect', { origin: ORIGIN, purpose: ['calendar'] }], ['send', email()], ['contract', contract()],
  ]) {
    const r = await run(path, { body, routes: asStaff });
    assert.equal(r.status, 403, `${path} ${JSON.stringify(body.purpose)}`);
    assert.deepEqual(r.data, { error: NOT_ADMIN });
    assert.equal(r.to(`${RPC}/google_token`).length + r.to(TOKEN_URL).length + r.to(GMAIL).length + r.to(DRIVE).length, 0);
  }
  const plain = await run('connect', { body: { origin: ORIGIN } });
  assert.equal(plain.status, 200);
  const q = new URL(plain.data.url).searchParams;
  assert.equal(q.get('scope'), g.SCOPES);
  const payload = await g.verifyState(q.get('state'), SECRET);
  assert.ok(!('purpose' in payload), 'no purpose in a plain connect’s state');
});

const shares = (r) => r.to(`${RPC}/calendar_share`);
const noTokenShared = (r) => assert.ok(shares(r).every((c) => !/access-token|refresh-token|id_token|eyJ/.test(c.body)), 'no token in a calendar_share body');

await check('calendar callback: saved with the secret key and Google’s scopes, then rpc calendar_share opts in → #/calendar?google=connected', async () => {
  for (const scope of [CAL_SCOPES, `${g.SCOPES} ${CAL_SCOPE}`, 'openid email https://www.googleapis.com/auth/calendar']) {
    const r = await callback(await calState(), { routes: { [TOKEN_URL]: () => reply(200, calToken({ scope })) } });
    assert.equal(r.status, 302, scope);
    assert.equal(r.headers.get('location'), calendarPage('connected'));
    const [save] = r.to(`${RPC}/google_save`);
    assert.equal(save.headers.get('apikey'), 'sb_secret_test');
    assert.deepEqual(save.json(), { p_user: 'u-ana', p_email: 'ana@example.com', p_token: 'new-refresh-token', p_scopes: scope });
    const [share, ...more] = shares(r);
    assert.ok(share && !more.length, `${scope}: calendar_share called once`);
    assert.ok(r.calls.indexOf(share) > r.calls.indexOf(save), 'calendar_share comes after google_save');
    assert.equal(share.method, 'POST');
    assert.equal(share.headers.get('apikey'), 'sb_secret_test', 'with the secret key');
    assert.equal(share.headers.get('authorization'), null);
    assert.equal(share.headers.get('content-type'), 'application/json');
    assert.deepEqual(share.json(), { p_user: 'u-ana' }, 'the state’s uid, nothing else');
    assert.equal(r.calls.at(-1), share, 'nothing called after it');
    noTokenShared(r);
  }
  // Another person's state → their uid (from the signed state, not the token).
  const sam = await callback(await calState({ uid: 'u-sam', email: 'sam@example.com' }), {
    routes: { [TOKEN_URL]: () => reply(200, calToken({ id_token: idToken({ email: 'sam@example.com' }) })) },
  });
  assert.equal(sam.headers.get('location'), calendarPage('connected'));
  assert.deepEqual(shares(sam).map((c) => c.json()), [{ p_user: 'u-sam' }]);
  // A legacy JWT-style secret key: apikey and Bearer, as google_save.
  const legacy = await callback(await calState(), { env: LEGACY_ENV, routes: { [TOKEN_URL]: () => reply(200, calToken()) } });
  assert.equal(legacy.headers.get('location'), calendarPage('connected'));
  const [legacyShare] = shares(legacy);
  assert.deepEqual([legacyShare.headers.get('apikey'), legacyShare.headers.get('authorization')], ['eyJ.service.placeholder', 'Bearer eyJ.service.placeholder']);
  // The purpose is signed: a plain state can't be turned into a calendar one.
  const good = await stateFor();
  const [, sig] = good.split('.');
  const body = JSON.parse(Buffer.from(good.split('.')[0], 'base64url').toString());
  const forged = await callback(`${b64url(JSON.stringify({ ...body, purpose: 'calendar' }))}.${sig}`);
  assert.deepEqual([forged.status, forged.text, forged.calls.length], [400, EXPIRED, 0]);
});

await check('calendar callback: no calendar scope in the token → google=calendar_scope and nothing saved; other failures by name (error&reason=<step>)', async () => {
  for (const scope of ['openid email', g.SCOPES, `openid email ${CAL_SCOPE}.extra`, 'openid email https://www.googleapis.com/auth/calendar.events', undefined, '']) {
    const r = await callback(await calState(), { routes: { [TOKEN_URL]: () => reply(200, calToken({ scope })) } });
    assert.equal(r.headers.get('location'), calendarPage('calendar_scope'), String(scope));
    assert.equal(r.to(`${RPC}/google_save`).length, 0, `${scope}: nothing saved`);
    assert.equal(shares(r).length, 0, `${scope}: nothing shared`);
  }
  // A plain connect never checks the calendar scope (unchanged).
  const plain = await callback(await stateFor(), { routes: { [TOKEN_URL]: () => reply(200, calToken({ scope: g.SCOPES })) } });
  assert.equal(plain.headers.get('location'), settings('connected'));
  assert.equal(shares(plain).length, 0);

  const state = await calState();
  const denied = await callback(state, { query: `?error=access_denied&state=${encodeURIComponent(state)}` });
  assert.deepEqual([denied.status, denied.headers.get('location'), denied.calls.length], [302, calendarPage('denied'), 0]);
  const exchange = (body, status = 200) => ({ [TOKEN_URL]: () => reply(status, body) });
  for (const [result, routes] of [
    ['error&reason=exchange', exchange({ error: 'invalid_grant' }, 400)],
    ['error&reason=exchange', { [TOKEN_URL]: () => { throw new TypeError('fetch failed'); } }],
    ['error&reason=client', exchange({ error: 'invalid_client', error_description: 'Unauthorized' }, 401)],
    ['wrong_account', exchange(calToken({ id_token: idToken({ email: 'someone@example.com' }) }))],
    ['wrong_account', exchange(calToken({ id_token: idToken({ email_verified: false }), scope: 'openid email' }))],
    ['no_refresh_token', exchange(calToken({ refresh_token: undefined }))],
    ['error&reason=save', { [TOKEN_URL]: () => reply(200, calToken()), [`${RPC}/google_save`]: () => reply(500, { message: 'boom' }) }],
  ]) {
    const r = await loggedCallback(state, { routes });
    assert.equal(r.status, 302, result);
    assert.equal(r.headers.get('location'), calendarPage(result));
    assert.equal(shares(r).length, 0, `${result}: nothing shared (a failed google_save stops before calendar_share)`);
    if (result.startsWith('error&reason=')) failureLogged(r, result.slice('error&reason='.length));
  }
  const noCode = await loggedCallback(state, { query: `?state=${encodeURIComponent(state)}` });
  assert.equal(noCode.headers.get('location'), calendarPage('error&reason=exchange'));
  assert.equal(shares(noCode).length, 0);
  failureLogged(noCode, 'exchange');
});

await check('calendar callback: calendar_share failing or not returning true → #/calendar?google=error&reason=share (token saved, nothing more)', async () => {
  for (const [label, answer] of [
    ['500', () => reply(500, { code: 'XX000', message: 'boom' })],
    ['403', () => reply(403, { code: '42501', message: 'permission denied' })],
    ['404', () => reply(404, { code: 'PGRST202', message: 'not found' })],
    ['network', () => { throw new TypeError('fetch failed'); }],
    ['false', () => reply(200, false)],
    ['null', () => reply(200, null)],
    ['empty 204', () => new Response(null, { status: 204 })],
    ['"true"', () => reply(200, 'true')],
    ['[true]', () => reply(200, [true])],
    ['not JSON', () => new Response('true!', { status: 200 })],
  ]) {
    const r = await loggedCallback(await calState(), { routes: { [TOKEN_URL]: () => reply(200, calToken()), [`${RPC}/calendar_share`]: answer } });
    assert.equal(r.status, 302, label);
    assert.equal(r.headers.get('location'), calendarPage('error&reason=share'), label);
    failureLogged(r, 'share');
    assert.equal(r.to(`${RPC}/google_save`).length, 1, `${label}: google_save ran first`);
    assert.equal(shares(r).length, 1, `${label}: asked once, no retry`);
    assert.equal(r.calls.at(-1), shares(r)[0], `${label}: nothing called after it`);
    assert.ok(!r.headers.get('location').includes('token') && r.text === '', `${label}: no token in the redirect`);
    noTokenShared(r);
  }
});

await check('calendar callback: a plain connect never calls calendar_share, even when Google hands back calendar.readonly (granted before)', async () => {
  // The regression: after a Calendar disconnect, an admin's plain connect (include_granted_scopes) returns a token that
  // still carries calendar.readonly. It saves and goes back to Settings as before, and must not start sharing again.
  for (const scope of [`${g.SCOPES} ${CAL_SCOPE}`, `${g.SCOPES} https://www.googleapis.com/auth/calendar`, CAL_SCOPES]) {
    const r = await callback(await stateFor(), { routes: { [TOKEN_URL]: () => reply(200, calToken({ scope })) } });
    assert.equal(r.status, 302, scope);
    assert.equal(r.headers.get('location'), settings('connected'), scope);
    const [save] = r.to(`${RPC}/google_save`);
    assert.deepEqual(save.json(), { p_user: 'u-ana', p_email: 'ana@example.com', p_token: 'new-refresh-token', p_scopes: scope });
    assert.equal(shares(r).length, 0, `${scope}: never calendar_share`);
  }
  // Even with calendar_share broken, a plain connect is unaffected (it never asks).
  const broken = await callback(await stateFor(), {
    routes: { [TOKEN_URL]: () => reply(200, calToken({ scope: `${g.SCOPES} ${CAL_SCOPE}` })), [`${RPC}/calendar_share`]: () => reply(500, {}) },
  });
  assert.deepEqual([broken.headers.get('location'), shares(broken).length], [settings('connected'), 0]);
  // Any other purpose in a signed state is a plain connect too.
  for (const purpose of ['Calendar', 'business', 'calendar ', ['calendar'], { calendar: true }, true]) {
    const r = await callback(await stateFor({ purpose }), { routes: { [TOKEN_URL]: () => reply(200, calToken({ scope: `${g.SCOPES} ${CAL_SCOPE}` })) } });
    assert.equal(r.headers.get('location'), settings('connected'), JSON.stringify(purpose));
    assert.equal(shares(r).length, 0, `${JSON.stringify(purpose)}: never calendar_share`);
  }
});

await check('calendar-sync: 401 without a JWT (nothing called), 403 for non-staff, any staff member may sync; CORS; GET → 405', async () => {
  const anon = await calSync({}, { auth: '' });
  assert.deepEqual([anon.status, anon.calls.length], [401, 0]);
  assert.equal(anon.headers.get('access-control-allow-origin'), ORIGIN);
  const expired = await calSync({ routes: { [`${RPC}/google_me`]: () => reply(401, { code: 'PGRST301', message: 'JWT expired' }) } });
  assert.equal(expired.status, 401);
  for (const answer of [() => reply(403, { code: '42501', message: 'Not allowed' }), () => reply(200, null), () => reply(200, { ...STAFF, uid: '' })]) {
    const r = await calSync({ routes: { [`${RPC}/google_me`]: answer } });
    assert.equal(r.status, 403);
    assert.equal(r.calls.length, 1, 'only google_me: nothing claimed');
  }
  const staff = await calSync({ routes: asStaff });
  assert.equal(staff.status, 200, 'staff, not only admins');
  const [me] = staff.to(`${RPC}/google_me`);
  assert.deepEqual([me.headers.get('apikey'), me.headers.get('authorization'), me.body], ['sb_publishable_test', USER_JWT, '{}']);
  assert.equal(staff.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(staff.headers.get('content-type'), 'application/json');
  const pre = await run('calendar-sync', { method: 'OPTIONS', auth: '' });
  assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin'), pre.calls.length], [204, ORIGIN, 0]);
  const get = await run('calendar-sync', { method: 'GET' });
  assert.deepEqual([get.status, get.headers.get('allow')], [405, 'POST, OPTIONS']);
  const bad = await run('calendar-sync', { body: [], routes: calendarRoutes() });
  assert.equal(bad.status, 400, 'a body that isn’t an object');
  assert.equal(bad.to(`${RPC}/calendar_claim`).length, 0);
});

await check('calendar-sync: rpc calendar_claim with the secret key, p_gap 600 (60 when forced); nobody claimed → no Google at all', async () => {
  for (const [body, gap] of [[{}, 600], [{ force: false }, 600], [{ force: 'yes' }, 600], [{ force: 1 }, 600], [{ force: true }, 60]]) {
    const r = await calSync({ body, claim: [] });
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.deepEqual(r.data, { ok: true, claimed: 0, synced: 0, failed: 0 });
    const [claim] = r.to(`${RPC}/calendar_claim`);
    assert.equal(claim.method, 'POST');
    assert.equal(claim.headers.get('apikey'), 'sb_secret_test');
    assert.equal(claim.headers.get('authorization'), null, 'an sb_secret_ key: apikey only');
    assert.deepEqual(claim.json(), { p_gap: gap }, JSON.stringify(body));
    assert.equal(r.to(`${RPC}/google_token`).length + r.to(TOKEN_URL).length + r.events.length + r.saves.length, 0, 'no Google calls, nothing saved');
  }
  const nothing = await calSync({ claim: null });
  assert.deepEqual(nothing.data, { ok: true, claimed: 0, synced: 0, failed: 0 });
  const legacy = await calSync({ claim: [] }, { env: LEGACY_ENV });
  assert.equal(legacy.to(`${RPC}/calendar_claim`)[0].headers.get('authorization'), 'Bearer eyJ.service.placeholder');

  const down = await calSync({ routes: { [`${RPC}/calendar_claim`]: () => reply(500, { code: 'XX000', message: 'boom' }) } });
  assert.equal(down.status, 502);
  assert.deepEqual(down.data, { error: 'Could not start the calendar sync.' });
  assert.ok(down.logs.some((l) => l.startsWith('google/calendar-sync: POST rpc/calendar_claim → 500')), down.logs.join('\n'));
  assert.equal(down.to(`${RPC}/google_token`).length, 0);
});

await check('calendar-sync: events.list on the primary calendar with exactly the agreed query, the person’s own token', async () => {
  const r = await calSync();
  assert.equal(r.status, 200);
  assert.equal(r.events.length, 1);
  const [ev] = r.events;
  assert.equal(ev.method, 'GET');
  assert.equal(ev.headers.get('authorization'), `Bearer fresh-access-token-${U1}`);
  const u = new URL(ev.url);
  assert.equal(`${u.origin}${u.pathname}`, CAL);
  const win = r.windows.find((w) => w.timeMin === u.searchParams.get('timeMin'));
  assert.ok(win, `the window of Sydney’s day: ${u.searchParams.get('timeMin')}`);
  assert.deepEqual([...u.searchParams], [
    ['timeMin', win.timeMin], ['timeMax', win.timeMax], ['singleEvents', 'true'], ['orderBy', 'startTime'], ['maxResults', '2500'],
    ['maxAttendees', '1'], ['showDeleted', 'false'], ['eventTypes', 'default'], ['eventTypes', 'outOfOffice'], ['eventTypes', 'focusTime'],
    ['eventTypes', 'fromGmail'], ['fields', CAL_FIELDS],
  ]);
  const [tok] = r.to(`${RPC}/google_token`);
  assert.deepEqual(tok.json(), { p_user: U1 });
  assert.equal(tok.headers.get('apikey'), 'sb_secret_test');
  assert.equal(r.to(TOKEN_URL)[0].form.get('refresh_token'), `stored-refresh-token-${U1}`);
});

await check('calendar-sync: rpc calendar_save gets the person, the run’s start, the window and only the kept rows; returns the counts', async () => {
  const r = await calSync();
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true, claimed: 1, synced: 1, failed: 0 });
  assert.equal(r.saves.length, 1);
  const [save] = r.saves;
  assert.equal(save.method, 'POST');
  assert.equal(save.headers.get('apikey'), 'sb_secret_test');
  assert.equal(save.headers.get('content-type'), 'application/json');
  const body = r.saved[0];
  assert.deepEqual(Object.keys(body), ['p_user', 'p_started', 'p_from', 'p_to', 'p_rows', 'p_error', 'p_reconnect']);
  const win = r.windows.find((w) => w.from === body.p_from);
  assert.ok(win && body.p_to === win.to, 'the window of Sydney’s day');
  assert.equal(new URL(r.events[0].url).searchParams.get('timeMin'), win.timeMin, 'the same window as events.list');
  assert.match(body.p_started, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(body.p_started) >= r.before.getTime() && Date.parse(body.p_started) <= r.after.getTime(), 'the run’s start');
  assert.deepEqual({ ...body, p_started: '', p_from: '', p_to: '' }, {
    p_user: U1, p_started: '', p_from: '', p_to: '', p_rows: ROWS, p_error: '', p_reconnect: false,
  });
  for (const secret of SECRETS) assert.ok(!save.body.includes(secret), `never sent: ${secret}`);
  assert.ok(r.calls.indexOf(save) > r.calls.indexOf(r.events[0]), 'saved after reading');
  noTokens(r);

  // calendar_save → false (no longer connected staff: their meetings are gone): neither synced nor failed.
  const gone = await calSync({ save: () => reply(200, false) });
  assert.deepEqual(gone.data, { ok: true, claimed: 1, synced: 0, failed: 0 });
  // The claim's ids as objects too, each person once.
  const objects = await calSync({ claim: [{ calendar_claim: U1 }, { calendar_claim: U2 }, U1, '', null] });
  assert.deepEqual(objects.saved.map((b) => b.p_user), [U1, U2]);
  assert.deepEqual(objects.data, { ok: true, claimed: 2, synced: 2, failed: 0 });
  const empty = await calSync({ events: [] });
  assert.deepEqual([empty.saved[0].p_rows, empty.saved[0].p_error, empty.data.synced], [[], '', 1], 'no events is a sync too');
});

await check('calendar-sync: follows nextPageToken with the same query; one row per event id', async () => {
  const pages = {
    '': { items: EVENTS.slice(0, 5), nextPageToken: 'page-2' },
    'page-2': { items: EVENTS.slice(5, 10), nextPageToken: 'page-3' },
    'page-3': { items: [...EVENTS.slice(10), { ...EVENTS[0], summary: 'Weekly sync (moved)' }] },
  };
  const r = await calSync({ events: (c) => reply(200, pages[new URL(c.url).searchParams.get('pageToken') ?? '']) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.events.map((c) => new URL(c.url).searchParams.get('pageToken')), [null, 'page-2', 'page-3']);
  const query = (c) => { const q = new URL(c.url).searchParams; q.delete('pageToken'); return q.toString(); };
  assert.ok(r.events.every((c) => query(c) === query(r.events[0])), 'the same query on every page');
  assert.deepEqual(r.saved[0].p_rows, [{ ...ROWS[0], title: 'Weekly sync (moved)' }, ...ROWS.slice(1)], 'the later copy of an id wins');
  assert.deepEqual(r.data, { ok: true, claimed: 1, synced: 1, failed: 0 });
});

await check('calendar-sync: more than 10 pages → p_error “Too many events”, no rows; 10 exactly is fine', async () => {
  let n = 0;
  const r = await calSync({ events: () => reply(200, { items: EVENTS.slice(0, 2), nextPageToken: `page-${++n}` }) });
  assert.equal(r.status, 200);
  assert.equal(r.events.length, 10, 'stops at 10 pages');
  assert.deepEqual({ ...r.saved[0], p_started: '', p_from: '', p_to: '' }, {
    p_user: U1, p_started: '', p_from: '', p_to: '', p_rows: [], p_error: 'Too many events', p_reconnect: false,
  });
  assert.deepEqual(r.data, { ok: true, claimed: 1, synced: 0, failed: 1 });
  let m = 0;
  const ten = await calSync({ events: () => reply(200, { items: EVENTS.slice(0, 1), ...(++m < 10 ? { nextPageToken: `page-${m}` } : {}) }) });
  assert.equal(ten.events.length, 10);
  assert.deepEqual([ten.saved[0].p_error, ten.saved[0].p_rows.length, ten.data.synced], ['', 1, 1]);
});

await check('calendar-sync: invalid_grant for one person → their p_reconnect true; the next person still syncs; no token anywhere', async () => {
  const r = await calSync({
    claim: [U1, U2],
    routes: {
      [TOKEN_URL]: (c) => (c.form.get('refresh_token').endsWith(U1)
        ? reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
        : reply(200, { access_token: `fresh-access-token-${U2}`, expires_in: 3599 })),
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true, claimed: 2, synced: 1, failed: 1 });
  assert.deepEqual(r.saved.map((b) => [b.p_user, b.p_error, b.p_reconnect, b.p_rows.length]), [
    [U1, CAL_RECONNECT, true, 0], [U2, '', false, ROWS.length],
  ]);
  assert.deepEqual(r.events.map(personOf), [U2], 'only U2’s calendar is read');
  assert.equal(r.saved[0].p_started, r.saved[1].p_started, 'one start for the whole run');
  assert.deepEqual([r.saved[0].p_from, r.saved[0].p_to], [r.saved[1].p_from, r.saved[1].p_to]);
  const tokens = r.to(`${RPC}/google_token`);
  assert.ok(r.calls.indexOf(r.saves[0]) < r.calls.indexOf(tokens[1]), 'one person at a time, in claim order');
  noTokens(r);
});

await check('calendar-sync: a missing calendar scope (stored or at Google) → reconnect; Google errors, a failed save → that person only', async () => {
  // Stored scopes without the calendar: reconnect, without asking Google.
  const stored = await calSync({ claim: [U1, U2], scopes: (u) => (u === U1 ? g.SCOPES : CAL_SCOPES) });
  assert.deepEqual(stored.saved.map((b) => [b.p_user, b.p_error, b.p_reconnect]), [[U1, CAL_RECONNECT, true], [U2, '', false]]);
  assert.deepEqual(stored.to(TOKEN_URL).map((c) => c.form.get('refresh_token')), [`stored-refresh-token-${U2}`]);
  // Not connected any more (no refresh token): reconnect too.
  const none = await calSync({ claim: [U1], routes: { [`${RPC}/google_token`]: () => reply(200, null) } });
  assert.deepEqual([none.saved[0].p_error, none.saved[0].p_reconnect, none.data.failed], ['Google Calendar isn’t connected.', true, 1]);
  // Google says the token lacks the scope.
  const insufficient = () => reply(403, {
    error: { code: 403, message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] },
  });
  const scope = await calSync({ claim: [U1, U2], events: (c) => (personOf(c) === U1 ? insufficient() : reply(200, { items: EVENTS })) });
  assert.deepEqual(scope.saved.map((b) => [b.p_user, b.p_error, b.p_reconnect, b.p_rows.length]), [[U1, CAL_RECONNECT, true, 0], [U2, '', false, ROWS.length]]);

  // Google's own error: its message (the access token cut out, at most 200 characters), not a reconnect.
  const errors = {
    [U1]: () => reply(500, { error: { code: 500, message: `Backend Error for fresh-access-token-${U1}\nretry` } }),
    [U2]: () => { throw new TypeError('fetch failed'); },
    [U3]: () => reply(400, { error: { code: 400, message: 'x'.repeat(300) } }),
  };
  const failing = await calSync({ claim: [U1, U2, U3], events: (c) => errors[personOf(c)]() });
  assert.equal(failing.status, 200);
  assert.deepEqual(failing.data, { ok: true, claimed: 3, synced: 0, failed: 3 });
  assert.deepEqual(failing.saved.map((b) => [b.p_error, b.p_reconnect, b.p_rows]), [
    ['Backend Error for … retry', false, []], ['Something went wrong with Google.', false, []], ['x'.repeat(200), false, []],
  ]);
  noTokens(failing);

  // calendar_save failing for one person: counted, logged without a body, and the next person still syncs.
  const save = await calSync({ claim: [U1, U2], save: (c) => (c.json().p_user === U1 ? reply(500, { code: 'XX000', message: 'boom' }) : reply(200, true)) });
  assert.equal(save.status, 200);
  assert.deepEqual(save.data, { ok: true, claimed: 2, synced: 1, failed: 1 });
  assert.deepEqual(save.saved.map((b) => b.p_user), [U1, U2]);
  assert.ok(save.logs.some((l) => l.startsWith('google/calendar-sync: POST rpc/calendar_save → 500')));
  noTokens(save);
});

// ── Outreach Gmail ──────────────────────────────────────────────────────────────────────────────────────────────
// Fictional prospects only (example.org / example.net). The mailboxes are placeholders on Cortex's own domain, which a
// mailbox connect needs.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const MB_SCOPES = `openid email ${GMAIL_READ}`;
const MB1 = 'b0000000-0000-4000-8000-0000000000b1';
const MB2 = 'b0000000-0000-4000-8000-0000000000b2';
const MB3 = 'b0000000-0000-4000-8000-0000000000b3';
const MB4 = 'b0000000-0000-4000-8000-0000000000b4';
const BOX1 = 'mailbox-one@assetstackai.com';
const BOXES = { [MB1]: BOX1, [MB2]: 'mailbox-two@assetstackai.com', [MB3]: 'mailbox-three@assetstackai.com', [MB4]: 'mailbox-four@assetstackai.com' };
const GMAIL_RECONNECT = 'Reconnect this mailbox’s Gmail in Settings → Outreach.';
const GMAIL_BUSY = 'Gmail is busy. Cortex will try again shortly.';
const GNOW = Date.parse('2026-10-21T00:00:00Z');
const DAY = 86400000;
const AFTER_90 = Math.floor((GNOW - 90 * DAY) / 1000);
const THREAD_FIELDS = 'id,messages(id,labelIds,internalDate,payload(mimeType,headers))';
const HISTORY_FIELDS = 'history(id,messagesAdded(message(id,threadId,labelIds))),nextPageToken,historyId';
const METADATA = ['From', 'To', 'Cc', 'Subject', 'Sender', 'In-Reply-To', 'Content-Type', 'Auto-Submitted', 'X-Autoreply', 'X-Autorespond', 'Precedence', 'X-Failed-Recipients'];
const SAVE_KEYS = ['p_mailbox', 'p_started', 'p_threads', 'p_messages', 'p_cursor', 'p_release', 'p_error', 'p_reconnect'];
const THREAD_KEYS = ['thread_id', 'sender', 'prospect_email', 'prospect_name', 'recipients', 'subject', 'first_at', 'last_sent_at', 'sent_count', 'reply_at', 'reply_message_id', 'auto_at', 'bounce_at'];
const KNOWN = { internal: ['assetstackai.com', 'assetstack.org', 'assetstackai.com.au'], emails: ['kim@example.net', 'ana@example.com'], domains: ['client.example.com'] };
const outreachPage = (result, mailbox = MB1) => `${ORIGIN}/#/settings?tab=outreach&gmail=${result}&mailbox=${mailbox}`;
const params = (c) => new URL(c.url).searchParams;
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const iso = (ms) => new Date(ms).toISOString();
const GSTART = iso(GNOW); // since on a chain's first call, by the fixed clock

// Gmail messages and threads as threads.get?format=metadata returns them.
const gHeaders = (o) => Object.entries(o).filter(([, v]) => v !== undefined).map(([name, value]) => ({ name, value }));
const gm = (id, at, headers, labelIds = ['INBOX'], mimeType = 'text/plain') => ({ id, labelIds, internalDate: String(Date.parse(at)), payload: { mimeType, headers: gHeaders(headers) } });
const sentMsg = (id, at, headers = {}, mimeType) => gm(id, at, { From: `Mailbox One <${BOX1}>`, ...headers }, ['SENT'], mimeType);
const gThread = (id, ...messages) => ({ id, historyId: '1', messages });
const coldFirst = (id, to, subject = 'Asset registers', extra = {}) => sentMsg(id, '2026-10-14T00:00:00Z', { To: to, Subject: subject, ...extra });
// What a full message would carry: never asked for, and never copied anywhere if Google sent it anyway.
const withBody = (m) => ({ ...m, snippet: 'SECRET SNIPPET', payload: { ...m.payload, body: { size: 9, data: 'U0VDUkVUIEJPRFk' }, parts: [{ mimeType: 'text/plain', body: { data: 'U0VDUkVUIEJPRFk' } }] } });
const b64 = (s) => Buffer.from(s).toString('base64');

const THREADS = {
  tA: gThread('tA',
    withBody(sentMsg('mA1', '2026-10-13T22:00:00Z', { To: '"Example, Alex" <Alex@Example.org>', Subject: 'Asset registers for Example Shire' })),
    sentMsg('mA2', '2026-10-15T22:00:00Z', { To: 'alex@example.org', Subject: 'Re: Asset registers for Example Shire', 'In-Reply-To': '<a1@mail.example.org>' }),
    gm('mA3', '2026-10-15T22:01:00Z', { From: 'Alex Example <alex@example.org>', Subject: 'Automatic reply: Asset registers for Example Shire', 'Auto-Submitted': 'auto-replied' }),
    withBody(gm('mA4', '2026-10-16T01:00:00Z', { From: 'Alex Example <alex@example.org>', Subject: 'Re: Asset registers — sounds good, call me' })),
    sentMsg('mA5', '2026-10-16T02:00:00Z', { To: 'alex@example.org', Subject: 'Re: Asset registers for Example Shire' }),
    gm('dA6', '2026-10-16T03:00:00Z', { From: BOX1, To: 'alex@example.org', Subject: 'Draft' }, ['DRAFT'])),
  tB: gThread('tB',
    sentMsg('mB1', '2026-10-14T01:00:00Z', { To: 'Bo Example <bo@example.net>', Cc: 'cy@example.net', Subject: `=?UTF-8?B?${b64('Grüße from AssetStack')}?=` }),
    gm('mB2', '2026-10-14T01:05:00Z', { From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', Subject: 'Delivery Status Notification (Delay)' }),
    gm('mB3', '2026-10-14T02:00:00Z', {
      From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', Subject: 'Delivery Status Notification (Failure)', 'X-Failed-Recipients': 'bo@example.net',
      'Content-Type': 'multipart/report; report-type=delivery-status; boundary="b1"',
    })),
  tC: gThread('tC',
    sentMsg('mC1', '2026-10-14T02:00:00Z', { To: 'Dee Example <dee@example.org>, "Eve, Ops" <eve@example.org>', Subject: 'Quick question about your asset data' }),
    gm('mC2', '2026-10-14T03:00:00Z', { From: 'Dee Example <dee@example.org>', Subject: 'Accepted: Demo @ Thu 22 Oct' }),
    gm('mC3', '2026-10-14T04:00:00Z', { From: 'Example Helpdesk <notifications@example.org>', Subject: 'Ticket 123 received' }),
    gm('mC4', '2026-10-14T05:00:00Z', { From: 'Pat Colleague <pat@assetstackai.com>', Subject: 'Re: Quick question' })),
  tDraftFirst: gThread('tDraftFirst',
    gm('dD1', '2026-10-12T00:00:00Z', { From: BOX1, To: 'fay@example.org', Subject: 'draft' }, ['DRAFT']),
    sentMsg('mD2', '2026-10-14T06:00:00Z', { To: 'fay@example.org', Subject: 'Hello from AssetStack' })),
  tReply: gThread('tReply', coldFirst('mR1', 'gus@example.org', 'RE: catch up')),
  tFwd: gThread('tFwd', coldFirst('mF1', 'gus@example.org', 'Fwd: the deck')),
  tInReplyTo: gThread('tInReplyTo', coldFirst('mI1', 'gus@example.org', 'Asset registers', { 'In-Reply-To': '<x@example.org>' })),
  tCal: gThread('tCal', coldFirst('mK1', 'gus@example.org', 'Demo', { Sender: 'Google Calendar <calendar-notification@google.com>' })),
  tCal2: gThread('tCal2', sentMsg('mK2', '2026-10-14T00:00:00Z', { To: 'gus@example.org', Subject: 'Demo', 'Content-Type': 'text/calendar; method=REQUEST' })),
  tMany: gThread('tMany', coldFirst('mM1', ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `${x}@example.org`).join(', '))),
  tBcc: gThread('tBcc', coldFirst('mBcc1', BOX1, 'To ourselves, prospects in Bcc')),
  tNoTo: gThread('tNoTo', sentMsg('mN1', '2026-10-14T00:00:00Z', { Subject: 'Bcc only' })),
  tKnown: gThread('tKnown', coldFirst('mKn1', 'Kim <KIM@example.net>')),
  tClient: gThread('tClient', coldFirst('mCl1', 'lee@sub.client.example.com')),
  tInternal: gThread('tInternal', coldFirst('mIn1', 'ops@assetstack.org', 'Asset registers', { Cc: 'someone@assetstackai.com' })),
  tNoReply: gThread('tNoReply', coldFirst('mNr1', 'no-reply@example.org')),
  tInbound: gThread('tInbound',
    gm('mIb1', '2026-10-13T00:00:00Z', { From: 'hal@example.org', To: BOX1, Subject: 'Question' }),
    sentMsg('mIb2', '2026-10-13T01:00:00Z', { To: 'hal@example.org', Subject: 'Re: Question' })),
  tPrior: gThread('tPrior', coldFirst('mP1', 'Sam Example <sam@example.org>')),
};
const WHY = {
  tA: 'cold', tB: 'cold', tC: 'cold', tDraftFirst: 'cold', tPrior: 'cold', tReply: 'reply subject', tFwd: 'reply subject', tInReplyTo: 'in reply',
  tCal: 'calendar', tCal2: 'calendar', tMany: 'recipients', tBcc: 'recipients', tNoTo: 'recipients', tKnown: 'known', tClient: 'client domain',
  tInternal: 'recipients', tNoReply: 'no-reply', tInbound: 'not ours',
};
const SENT_PAGES = [
  ['tA', 'tB', 'tA', 'tC', 'tReply', 'tFwd', 'tInReplyTo', 'tCal', 'tCal2'],
  ['tMany', 'tBcc', 'tNoTo', 'tKnown', 'tClient', 'tInternal', 'tNoReply', 'tInbound', 'tPrior', 'tDraftFirst'],
];
const LISTED = [...new Set(SENT_PAGES.flat())];
const ROW_A = {
  thread_id: 'tA', sender: BOX1, prospect_email: 'alex@example.org', prospect_name: 'Example, Alex', recipients: 1,
  subject: 'Asset registers for Example Shire', first_at: '2026-10-13T22:00:00.000Z', last_sent_at: '2026-10-16T02:00:00.000Z', sent_count: 3,
  reply_at: '2026-10-16T01:00:00.000Z', reply_message_id: 'mA4', auto_at: '2026-10-15T22:01:00.000Z', bounce_at: null,
};
const MSGS_A = [
  ['mA1', 'sent', '2026-10-13T22:00:00.000Z'], ['mA2', 'sent', '2026-10-15T22:00:00.000Z'], ['mA3', 'auto', '2026-10-15T22:01:00.000Z'],
  ['mA4', 'reply', '2026-10-16T01:00:00.000Z'], ['mA5', 'sent', '2026-10-16T02:00:00.000Z'],
].map(([message_id, kind, at]) => ({ message_id, thread_id: 'tA', kind, at }));
const ROW_B = {
  thread_id: 'tB', sender: BOX1, prospect_email: 'bo@example.net', prospect_name: 'Bo Example', recipients: 2, subject: 'Grüße from AssetStack',
  first_at: '2026-10-14T01:00:00.000Z', last_sent_at: '2026-10-14T01:00:00.000Z', sent_count: 1, reply_at: null, reply_message_id: '', auto_at: null,
  bounce_at: '2026-10-14T02:00:00.000Z',
};
const MSGS_B = [
  { message_id: 'mB1', thread_id: 'tB', kind: 'sent', at: '2026-10-14T01:00:00.000Z' }, { message_id: 'mB3', thread_id: 'tB', kind: 'bounce', at: '2026-10-14T02:00:00.000Z' },
];
const ROW_C = {
  thread_id: 'tC', sender: BOX1, prospect_email: 'dee@example.org', prospect_name: 'Dee Example', recipients: 2, subject: 'Quick question about your asset data',
  first_at: '2026-10-14T02:00:00.000Z', last_sent_at: '2026-10-14T02:00:00.000Z', sent_count: 1, reply_at: null, reply_message_id: '', auto_at: null, bounce_at: null,
};
const MSGS_C = [{ message_id: 'mC1', thread_id: 'tC', kind: 'sent', at: '2026-10-14T02:00:00.000Z' }];
const ROW_D = {
  thread_id: 'tDraftFirst', sender: BOX1, prospect_email: 'fay@example.org', prospect_name: '', recipients: 1, subject: 'Hello from AssetStack',
  first_at: '2026-10-14T06:00:00.000Z', last_sent_at: '2026-10-14T06:00:00.000Z', sent_count: 1, reply_at: null, reply_message_id: '', auto_at: null, bounce_at: null,
};
const MSGS_D = [{ message_id: 'mD2', thread_id: 'tDraftFirst', kind: 'sent', at: '2026-10-14T06:00:00.000Z' }];
// Never sent anywhere: message text, a reply's subject, the snippet and body Google wasn't asked for.
const NEVER = ['SECRET SNIPPET', 'U0VDUkVUIEJPRFk', 'sounds good', 'call me', 'Automatic reply', 'Ticket 123', 'Delivery Status'];

const gJob = (mb = MB1, over = {}) => ({
  email: BOXES[mb], refresh_token: `gmail-refresh-${mb}`, scopes: MB_SCOPES, client: 'default', addresses: [BOXES[mb], 'old-box@old.example.com'],
  history_id: '', scan_from: null, pending: [], synced_at: null, ready: false, ...over,
});
const boxOf = (c) => c.headers.get('authorization').replace('Bearer gmail-access-', '');
// messages.list pages (?pageToken=pN) of thread ids.
const listPages = (pages) => (c) => {
  const token = params(c).get('pageToken') || '';
  const i = token ? Number(token.slice(1)) : 0;
  return reply(200, {
    messages: (pages[i] || []).map((threadId, n) => ({ id: `${threadId}-m${n}`, threadId })), ...(i + 1 < pages.length ? { nextPageToken: `p${i + 1}` } : {}),
    resultSizeEstimate: 9,
  });
};

// PostgREST and Gmail for outreach-gmail-sync. Each mailbox has its own refresh token (gmail-refresh-<id>), swapped for
// its own access token (gmail-access-<id>), so every Gmail call says whose mailbox it read.
function gmailRoutes({
  access = { view: true, edit: false, admin: false }, claim = [MB1], known = KNOWN, jobs = { [MB1]: gJob(MB1) }, save = () => reply(200, true),
  stored = [], profile = (mb) => reply(200, { emailAddress: BOXES[mb].toUpperCase(), messagesTotal: 42, historyId: `9${mb.slice(-1)}00` }),
  sent = SENT_PAGES, inbound = [[]], list = null, history = () => reply(200, { historyId: '8999' }), threads = THREADS,
  prior = (c, q) => reply(200, q.includes('sam@example.org') ? { messages: [{ id: 'older-1' }] } : { resultSizeEstimate: 0 }),
} = {}) {
  return {
    [`${RPC}/outreach_access`]: () => reply(200, access),
    [`${RPC}/outreach_gmail_claim`]: () => reply(200, claim),
    [`${RPC}/outreach_gmail_known`]: typeof known === 'function' ? known : () => reply(200, known),
    [`${RPC}/outreach_gmail_job`]: (c) => reply(200, jobs[c.json().p_mailbox] ?? null),
    [`${RPC}/outreach_gmail_save`]: save,
    [`${REST}/outreach_threads`]: (c) => {
      const q = params(c);
      const mb = q.get('mailbox_id').replace(/^eq\./, '');
      const ids = q.get('thread_id').replace(/^in\.\(|\)$/g, '').split(',');
      const have = typeof stored === 'function' ? stored(mb) : stored;
      return reply(200, ids.filter((t) => have.includes(t)).map((thread_id) => ({ thread_id })));
    },
    [TOKEN_URL]: (c) => reply(200, { access_token: c.form.get('refresh_token').replace('gmail-refresh-', 'gmail-access-'), expires_in: 3599, token_type: 'Bearer' }),
    [`${GMAIL_API}/profile`]: (c) => profile(boxOf(c), c),
    [`${GMAIL_API}/messages?`]: (c) => {
      const q = params(c).get('q');
      if (q.startsWith('from:')) return prior(c, q);
      if (list) return list(c, q);
      return listPages(q.startsWith('-in:sent') ? inbound : sent)(c);
    },
    [`${GMAIL_API}/history?`]: history,
    [`${GMAIL_API}/threads/`]: (c) => {
      const id = decodeURIComponent(new URL(c.url).pathname.split('/').pop());
      const t = typeof threads === 'function' ? threads(id, c) : threads[id];
      if (t instanceof Response) return t;
      return t === undefined ? reply(404, { error: { code: 404, message: 'Requested entity was not found.' } }) : reply(200, t);
    },
  };
}

/** One outreach-gmail-sync request through handle() with a fixed clock (`now`) and a recorded `sleep`. */
async function gSync({ body = {}, routes = {}, auth = USER_JWT, method = 'POST', limits = {}, now: clock = () => GNOW, ...opts } = {}) {
  const logs = [];
  const sleeps = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    const headers = { Origin: ORIGIN };
    if (auth) headers.Authorization = auth;
    if (body !== undefined && method === 'POST') headers['Content-Type'] = 'application/json';
    const req = new Request(`${SUPABASE}/functions/v1/google/outreach-gmail-sync`, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined });
    const f = fakeFetch({ ...gmailRoutes(opts), ...routes });
    const res = await g.handle(req, { env: ENV, fetch: f.fetch, limits, now: clock, sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(f.unexpected, [], 'no unexpected fetches');
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const saves = f.to(`${RPC}/outreach_gmail_save`);
    return {
      status: res.status, headers: res.headers, text, data, calls: f.calls, to: f.to, logs, sleeps, saves, saved: saves.map((c) => c.json()),
      threads: f.to(`${GMAIL_API}/threads/`), lists: f.to(`${GMAIL_API}/messages?`).filter((c) => !params(c).get('q').startsWith('from:')),
      priors: f.to(`${GMAIL_API}/messages?`).filter((c) => params(c).get('q').startsWith('from:')), gmail: f.to('https://gmail.googleapis.com/'),
    };
  } finally {
    console.error = original;
  }
}
const fetched = (r) => r.threads.map((c) => decodeURIComponent(new URL(c.url).pathname.split('/').pop()));
// No Google token in anything sent to Supabase, the response or the logs; no address or subject in the logs.
function gNoTokens(r) {
  const toSupabase = r.calls.filter((c) => c.url.startsWith(SUPABASE)).map((c) => c.body || '');
  const everything = [r.text, ...toSupabase, ...r.logs].join('\n');
  assert.ok(!/gmail-refresh-|gmail-access-|fresh-access-token|stored-refresh-token/.test(everything), 'no Google token sent to Supabase, returned or logged');
  const logs = r.logs.join('\n');
  assert.ok(!/@/.test(logs), `no address in the logs: ${logs}`);
  for (const s of ['Asset registers', 'Grüße', 'Quick question', 'Hello from AssetStack', ...NEVER]) assert.ok(!logs.includes(s), `no subject in the logs: ${s}`);
}
// Nothing of a message's text in any save: no such key anywhere, and none of NEVER's strings.
function noText(r) {
  const keys = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
  };
  r.saved.forEach(walk);
  for (const k of ['snippet', 'body', 'text', 'raw', 'payload', 'headers', 'parts', 'data', 'html']) assert.ok(!keys.has(k), `no ${k} key in a save`);
  for (const b of r.saves) for (const s of NEVER) assert.ok(!b.body.includes(s), `never saved: ${s}`);
}

await check('gmail helpers: hasGmailRead wants gmail.readonly as a whole entry; clientFor knows only the default client; the limits', () => {
  for (const yes of [MB_SCOPES, GMAIL_READ, ` ${GMAIL_READ} `, `openid\t${GMAIL_READ}\nemail`, `${g.SCOPES} ${GMAIL_READ}`]) assert.equal(g.hasGmailRead(yes), true, yes);
  for (const no of [
    '', null, undefined, 'openid email', g.SCOPES, `${GMAIL_READ}.x`, `x${GMAIL_READ}`, 'https://www.googleapis.com/auth/gmail.metadata',
    'https://www.googleapis.com/auth/gmail.modify', 'gmail.readonly', 'https://mail.google.com/',
  ]) assert.equal(g.hasGmailRead(no), false, String(no));
  assert.equal(g.MAILBOX_SCOPES, MB_SCOPES);
  const cfg = g.config(ENV);
  assert.deepEqual(g.clientFor(cfg, 'default'), { id: ENV.GOOGLE_CLIENT_ID, secret: SECRET, hd: 'assetstackai.com' });
  assert.deepEqual(g.clientFor(cfg), g.clientFor(cfg, 'default'));
  for (const key of ['', 'org', 'Default', 'au', null]) assert.equal(g.clientFor(cfg, key), null, String(key));
  assert.deepEqual(g.GMAIL_LIMITS, {
    deadline: 60000, mailboxes: 3, listPages: 40, historyPages: 20, threadsPerRun: 500, saveEvery: 100, parallel: 6, backoff: 2000,
  });
});

await check('gmail helpers: parseAddresses reads display names (quoted commas, escapes, RFC 2047 B and Q), groups and comments', () => {
  const p = g.parseAddresses;
  assert.deepEqual(p('"Example, Alex" <Alex@Example.org>, bo@example.net'), [{ name: 'Example, Alex', email: 'alex@example.org' }, { name: '', email: 'bo@example.net' }]);
  assert.deepEqual(p('"a, b; c" <c@example.org>; d@example.org'), [{ name: 'a, b; c', email: 'c@example.org' }, { name: '', email: 'd@example.org' }]);
  assert.deepEqual(p(`=?UTF-8?B?${b64('Éloïse Example')}?= <eloise@example.org>`), [{ name: 'Éloïse Example', email: 'eloise@example.org' }]);
  assert.deepEqual(p('=?ISO-8859-1?Q?Andr=E9_Example?= <andre@example.org>'), [{ name: 'André Example', email: 'andre@example.org' }]);
  assert.deepEqual(p('=?utf-8?q?Jos=C3=A9?= =?utf-8?q?_Example?= <jose@example.org>'), [{ name: 'José Example', email: 'jose@example.org' }], 'adjacent encoded words join');
  assert.deepEqual(p(`"=?UTF-8?B?${b64('Zoë, Ops')}?=" <zoe@example.org>`), [{ name: 'Zoë, Ops', email: 'zoe@example.org' }], 'an encoded word inside quotes');
  assert.deepEqual(p('"Quote \\"Q\\" Example" <q@example.org>'), [{ name: 'Quote "Q" Example', email: 'q@example.org' }]);
  assert.deepEqual(p('"<not@example.org>" <real@example.org>'), [{ name: '<not@example.org>', email: 'real@example.org' }]);
  assert.deepEqual(p('pat@example.org (Pat, Example)'), [{ name: '', email: 'pat@example.org' }], 'a comment, commas and all');
  assert.deepEqual(p('Team: a@example.org, B@example.org;, c@example.org'), ['a', 'b', 'c'].map((x) => ({ name: '', email: `${x}@example.org` })));
  assert.deepEqual(p('Alex <alex@example.org>,\r\n bo@example.net'), [{ name: 'Alex', email: 'alex@example.org' }, { name: '', email: 'bo@example.net' }], 'a folded header');
  for (const none of ['undisclosed-recipients:;', '', null, undefined, 'not an address', '<>', '@example.org', 'a@b', '"Pat" <>']) assert.deepEqual(p(none), [], String(none));
  assert.equal(g.decodeHeader(`=?UTF-8?B?${b64('Grüße')}?= from =?UTF-8?Q?Sydney_=F0=9F=87=A6=F0=9F=87=BA?=`), 'Grüße from Sydney 🇦🇺');
  assert.equal(g.decodeHeader('=?x-unknown?B?AAAA?= stays'), '=?x-unknown?B?AAAA?= stays', 'an unknown charset stays as it was');
  assert.equal(g.decodeHeader('Plain = subject ?= here'), 'Plain = subject ?= here');
});

await check('gmail helpers: messageKind sorts each message (ours, bounce, auto, ignored, reply)', () => {
  const ctx = { internal: ['old.example.com'] };
  const m = (headers, labels, mime) => gm('x', '2026-10-14T00:00:00Z', headers, labels, mime);
  const from = (f, more = {}) => m({ From: f, Subject: 'Re: Asset registers', ...more });
  const cases = [
    ['ours', m({ From: BOX1 }, ['SENT'])], ['ours', m({ From: 'Someone Else <x@example.org>' }, ['SENT', 'IMPORTANT'])],
    ['ignored', m({ From: BOX1 }, ['SENT', 'DRAFT'])], ['ignored', m({ From: 'x@example.org' }, ['DRAFT'])], ['ignored', m({ From: 'x@example.org' }, ['CHAT'])],
    ['bounce', from('Mail Delivery Subsystem <MAILER-DAEMON@googlemail.com>', { Subject: 'Delivery Status Notification (Failure)' })],
    ['bounce', from('postmaster@example.org', { Subject: 'Undeliverable: Asset registers' })],
    ['bounce', from('someone@example.org', { 'Content-Type': 'multipart/report; report-type="delivery-status"; boundary="z"' })],
    ['bounce', from('someone@example.org', { 'X-Failed-Recipients': 'alex@example.org' })],
    ['bounce', from('postmaster@assetstackai.com', { Subject: 'Undeliverable' }), 'our own postmaster still bounces'],
    ['ignored', from('mailer-daemon@googlemail.com', { Subject: 'Delivery Status Notification (Delay)' }), 'a delay notice'],
    ['ignored', from('postmaster@example.org', { Subject: 'Warning: message 1Abc delayed 24 hours' })],
    ...['Delivery delayed: Asset registers', 'Delayed Mail (still being retried)', 'Message delayed', 'Warning: delayed message', 'DELIVERY STATUS NOTIFICATION (DELAY)']
      .map((s) => ['ignored', from('mailer-daemon@googlemail.com', { Subject: s }), `a delay notice: ${s}`]),
    // A delay notice is known by how its subject starts, never by "delay" in the subject it quotes.
    ['bounce', from('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', { Subject: 'Undeliverable: Delayed maintenance on your bridges', 'X-Failed-Recipients': 'alex@example.org' }),
      'a bounce quoting “Delayed”'],
    ['bounce', from('mailer-daemon@googlemail.com', { Subject: 'Delivery Status Notification (Failure) for “Sorry for the delay”' }), 'a failure with “delay” later on'],
    ['bounce', from('postmaster@example.org', { Subject: 'Undeliverable: Re: the delay on the asset data' }), 'Undeliverable, delay later on'],
    ['reply', from('alex@example.org', { 'Content-Type': 'multipart/report; report-type=disposition-notification' }), 'not a delivery report'],
    ['auto', from('alex@example.org', { 'Auto-Submitted': 'auto-replied' })], ['auto', from('alex@example.org', { 'Auto-Submitted': 'auto-generated; x=y' })],
    ['reply', from('alex@example.org', { 'Auto-Submitted': 'No' })], ['auto', from('alex@example.org', { 'X-Autoreply': 'yes' })],
    ['auto', from('alex@example.org', { 'X-Autorespond': 'Out of office' })], ['auto', from('alex@example.org', { Precedence: 'auto_reply' })],
    ['auto', from('alex@example.org', { Precedence: 'Bulk' })], ['auto', from('alex@example.org', { Precedence: 'junk' })],
    ['reply', from('alex@example.org', { Precedence: 'list' })],
    ...['Automatic reply: Asset registers', 'Auto-Reply: away', 'AutoReply', 'auto reply', 'Out of Office: back Monday', 'Out of the office', 'OOO until Monday',
      'Abwesenheitsnotiz: x', 'Réponse automatique : absent', `=?UTF-8?B?${b64('Réponse automatique')}?=`].map((s) => ['auto', from('alex@example.org', { Subject: s }), s]),
    ['reply', from('alex@example.org', { Subject: 'oops, wrong file' })], ['reply', from('alex@example.org', { Subject: 'Re: Out of office ideas' })],
    ['ignored', from('Pat <pat@AssetStackAI.com>')], ['ignored', from('x@mail.assetstack.org')], ['ignored', from('x@assetstackai.com.au')],
    ['ignored', from('box@old.example.com'), 'the mailbox’s own other domain'], ['ignored', from('pat@assetstackai.com', { 'Auto-Submitted': 'auto-replied' }), 'an internal auto-reply'],
    ['ignored', from('Google Calendar <calendar-notification@google.com>')], ['ignored', from('alex@example.org', { Sender: 'Google Calendar <calendar-notification@google.com>' })],
    ...['Accepted: Demo @ Thu', 'Declined: Demo', 'Tentatively accepted: Demo', 'Invitation: Demo @ Thu', 'Updated invitation: Demo', 'Canceled event: Demo', 'Cancelled event: Demo']
      .map((s) => ['ignored', from('alex@example.org', { Subject: s }), s]),
    ...['no-reply@example.org', 'noreply@example.org', 'No_Reply@example.org', 'do-not-reply@example.org', 'donotreply@example.org', 'notifications@example.org',
      'notification+abc@example.org', 'notify@example.org'].map((f) => ['ignored', from(f), f]),
    ['auto', from('noreply@example.org', { 'Auto-Submitted': 'auto-replied' }), 'an auto-acknowledgement from a no-reply sender'],
    ['reply', from('Alex Example <alex@example.org>')], ['reply', from('replies@example.org')], ['reply', from('notificationsteam@example.org')],
    ['ignored', m({ Subject: 'No From' })], ['ignored', from('not an address')],
  ];
  for (const [want, msg, label] of cases) {
    const h = Object.fromEntries(msg.payload.headers.map((x) => [x.name, x.value]));
    assert.equal(g.messageKind(msg, ctx), want, label || `${msg.labelIds.join('+')} ${JSON.stringify(h)}`);
  }
  assert.equal(g.messageKind(from('x@old.example.com')), 'reply', 'without the mailbox’s domains it is outside');
  assert.equal(g.messageKind(null), 'ignored');
});

await check('gmail helpers: coldThread — ours first, not a reply, forward or invite, 1–5 new outside To/Cc recipients', () => {
  for (const [id, want] of Object.entries(WHY)) {
    const v = g.coldThread(THREADS[id], KNOWN);
    assert.equal(v.cold ? 'cold' : v.why, want, id);
  }
  assert.deepEqual(g.coldThread(THREADS.tA, KNOWN), { cold: true, prospect: 'alex@example.org', prospectName: 'Example, Alex', recipients: 1, firstAt: '2026-10-13T22:00:00.000Z' });
  assert.deepEqual(g.coldThread(THREADS.tC, KNOWN), { cold: true, prospect: 'dee@example.org', prospectName: 'Dee Example', recipients: 2, firstAt: '2026-10-14T02:00:00.000Z' });
  const to = (list, extra) => gThread('t', coldFirst('m', list, 'Asset registers', extra));
  const five = ['a', 'b', 'c', 'd', 'e'].map((x) => `${x}@example.org`).join(', ');
  assert.equal(g.coldThread(to(five), KNOWN).recipients, 5, 'five is fine');
  assert.equal(g.coldThread(to('a@example.org, A@Example.org', { Cc: 'a@example.org' }), KNOWN).recipients, 1, 'the same address counts once');
  assert.equal(g.coldThread(to(five, { Cc: 'f@example.org' }), KNOWN).why, 'recipients', 'To and Cc together');
  assert.equal(g.coldThread(to(five, { Bcc: 'f@example.org, g@example.org' }), KNOWN).cold, true, 'Bcc is ignored');
  assert.deepEqual(pick(g.coldThread(to('', { Cc: 'Cy <cy@example.org>' }), KNOWN), ['cold', 'prospect', 'prospectName']), { cold: true, prospect: 'cy@example.org', prospectName: 'Cy' }, 'Cc when no To');
  assert.equal(g.coldThread(to('x@old.example.com'), { ...KNOWN, internal: ['old.example.com'] }).why, 'recipients', 'a mailbox’s own other domain');
  assert.deepEqual(pick(g.coldThread(to('Gus <gus@example.org>', { Cc: 'Ops <ops@assetstack.org>, x@mail.assetstackai.com' }), KNOWN), ['cold', 'prospect', 'recipients']),
    { cold: true, prospect: 'gus@example.org', recipients: 1 }, 'a colleague copied in doesn’t count');
  assert.deepEqual(pick(g.coldThread(to('ops@assetstack.org', { Cc: 'Cy <cy@example.org>' }), KNOWN), ['cold', 'prospect', 'recipients']),
    { cold: true, prospect: 'cy@example.org', recipients: 1 }, 'a colleague in To, the prospect in Cc');
  assert.equal(g.coldThread(to(`${five}, ops@assetstack.org`), KNOWN).recipients, 5, 'five outside people and a colleague');
  assert.equal(g.coldThread(to('x@client.example.com'), KNOWN).why, 'client domain');
  assert.equal(g.coldThread(to('x@notclient.example.com'), KNOWN).cold, true, 'a domain, not a suffix of the name');
  assert.equal(g.coldThread(to('x@example.org', { 'In-Reply-To': ' ' }), KNOWN).cold, true, 'a blank In-Reply-To');
  for (const s of ['Re: x', 'RE : x', 'Fw: x', 'FWD: x', ' re: x']) assert.equal(g.coldThread(to('x@example.org', { Subject: s }), KNOWN).why, 'reply subject', s);
  for (const s of ['Regarding your assets', 'Fwding tips', 'Re-thinking asset data']) assert.equal(g.coldThread(to('x@example.org', { Subject: s }), KNOWN).cold, true, s);
  assert.equal(g.coldThread({ id: 'x', messages: [] }, KNOWN).why, 'not ours');
  assert.equal(g.coldThread(null, KNOWN).why, 'not ours');
  // The known lists are lower-cased whatever their case.
  assert.equal(g.coldThread(to('kim@EXAMPLE.net'), { emails: ['KIM@example.NET'] }).why, 'known');
});
await check('gmail helpers: threadRows builds the thread row (our first subject only) and one row per sent, reply, auto-reply and bounce', () => {
  assert.deepEqual(g.threadRows(THREADS.tA, KNOWN), { thread: ROW_A, messages: MSGS_A });
  assert.deepEqual(g.threadRows(THREADS.tB, KNOWN), { thread: ROW_B, messages: MSGS_B });
  assert.deepEqual(g.threadRows(THREADS.tC, KNOWN), { thread: ROW_C, messages: MSGS_C });
  assert.deepEqual(g.threadRows(THREADS.tDraftFirst, KNOWN), { thread: ROW_D, messages: MSGS_D });
  for (const id of ['tA', 'tB', 'tC']) assert.deepEqual(Object.keys(g.threadRows(THREADS[id], KNOWN).thread), THREAD_KEYS);
  // Messages out of order are read oldest first; a second reply is a message but not the thread's reply.
  const shuffled = gThread('tS',
    gm('r2', '2026-10-16T00:00:00Z', { From: 'alex@example.org', Subject: 'second' }), sentMsg('s1', '2026-10-14T00:00:00Z', { To: 'alex@example.org', Subject: 'First' }),
    gm('r1', '2026-10-15T00:00:00Z', { From: 'alex@example.org', Subject: 'first reply' }));
  const s = g.threadRows(shuffled, KNOWN);
  assert.deepEqual([s.thread.subject, s.thread.reply_message_id, s.thread.reply_at], ['First', 'r1', '2026-10-15T00:00:00.000Z']);
  assert.deepEqual(s.messages.map((x) => [x.message_id, x.kind]), [['s1', 'sent'], ['r1', 'reply'], ['r2', 'reply']]);
  // Long names and subjects are cut (by characters).
  const long = g.threadRows(gThread('tL', sentMsg('l1', '2026-10-14T00:00:00Z', { To: `"${'Ž'.repeat(150)}" <z@example.org>`, Subject: '😀'.repeat(250) })), KNOWN).thread;
  assert.deepEqual([long.prospect_name, long.subject], ['Ž'.repeat(100), '😀'.repeat(200)]);
  assert.equal(g.threadRows(THREADS.tInbound, KNOWN), null, 'not ours: no rows');
  assert.equal(g.threadRows({ messages: THREADS.tA.messages }, KNOWN), null, 'no thread id');
});

await check('gmail helpers: threadRows counts one of ours after the first only when its To or Cc holds someone outside (a forward to a colleague isn’t a cold email)', () => {
  const ctx = { ...KNOWN, internal: [...KNOWN.internal, 'old.example.com'] };
  const t = gThread('tW',
    sentMsg('w1', '2026-10-14T00:00:00Z', { To: 'Alex <alex@example.org>', Subject: 'Asset registers' }),
    gm('w2', '2026-10-15T00:00:00Z', { From: 'alex@example.org', Subject: 'Re: Asset registers' }),
    sentMsg('w3', '2026-10-15T01:00:00Z', { To: 'Ops <ops@assetstack.org>', Cc: 'pat@assetstackai.com', Subject: 'Fwd: Re: Asset registers' }),
    sentMsg('w4', '2026-10-15T02:00:00Z', { To: 'alex@example.org', Cc: 'ops@assetstack.org', Subject: 'Re: Asset registers' }),
    sentMsg('w5', '2026-10-15T03:00:00Z', { Subject: 'Re: Asset registers' }),
    sentMsg('w6', '2026-10-15T04:00:00Z', { To: 'ops@assetstack.org', Cc: 'Alex <alex@example.org>', Subject: 'Re: Asset registers' }),
    sentMsg('w7', '2026-10-15T05:00:00Z', { To: 'box@old.example.com', Subject: 'Fwd: Asset registers' }));
  const r = g.threadRows(t, ctx);
  assert.deepEqual(pick(r.thread, ['sent_count', 'last_sent_at', 'reply_at', 'reply_message_id']),
    { sent_count: 3, last_sent_at: '2026-10-15T04:00:00.000Z', reply_at: '2026-10-15T00:00:00.000Z', reply_message_id: 'w2' });
  assert.deepEqual(r.messages.map((x) => [x.message_id, x.kind]), [['w1', 'sent'], ['w2', 'reply'], ['w4', 'sent'], ['w6', 'sent']],
    'the forward to colleagues (w3), nobody in To or Cc (w5) and the mailbox’s own other domain (w7) give nothing');
  // The first message always counts (it is the cold email).
  assert.deepEqual(pick(g.threadRows(THREADS.tInternal, KNOWN).thread, ['sent_count', 'last_sent_at']), { sent_count: 1, last_sent_at: '2026-10-14T00:00:00.000Z' });
});

// ── Mailbox connect ──

const MAILBOX_ROW = { id: MB1, active: true, addresses: ['x@assetstackai.com.au', 'y@mail.assetstackai.com', 'Mailbox-One@AssetStackAI.com', 'other@assetstackai.com'] };
const mbConnect = (body = {}, routes = {}, opts = {}) => run('connect', {
  body: { origin: ORIGIN, purpose: 'mailbox', mailbox: MB1, ...body }, routes: { [`${REST}/outreach_mailboxes`]: () => reply(200, [MAILBOX_ROW]), ...routes }, ...opts,
});

await check('gmail connect: admins only — staff, outsiders and no JWT are refused before the mailbox is read', async () => {
  const staff = await mbConnect({}, asStaff);
  assert.deepEqual([staff.status, staff.data], [403, { error: NOT_ADMIN }]);
  const outsider = await mbConnect({}, { [`${RPC}/google_me`]: () => reply(403, { code: '42501', message: 'Not allowed' }) });
  assert.equal(outsider.status, 403);
  const anon = await mbConnect({}, {}, { auth: '' });
  assert.deepEqual([anon.status, anon.calls.length], [401, 0]);
  for (const r of [staff, outsider]) assert.equal(r.to(`${REST}/outreach_mailboxes`).length + r.to(TOKEN_URL).length, 0);
});

await check('gmail connect: the consent URL — gmail.readonly only, include_granted_scopes=false, consent select_account, hd and the mailbox’s address', async () => {
  const r = await mbConnect({ mailbox: MB1.toUpperCase() });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data), ['url']);
  const url = new URL(r.data.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  const { state, ...rest } = Object.fromEntries(url.searchParams);
  assert.deepEqual(rest, {
    client_id: ENV.GOOGLE_CLIENT_ID, redirect_uri: `${SUPABASE}/functions/v1/google/callback`, response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly', access_type: 'offline', prompt: 'consent select_account',
    include_granted_scopes: 'false', hd: 'assetstackai.com', login_hint: BOX1,
  });
  const payload = await g.verifyState(state, SECRET);
  assert.ok(payload.exp >= now() + 595 && payload.exp <= now() + 605 && payload.nonce.length >= 16);
  assert.deepEqual({ ...payload, exp: 0, nonce: '' }, {
    uid: 'u-ana', email: 'ana@example.com', origin: ORIGIN, exp: 0, nonce: '', purpose: 'mailbox', mailbox: MB1, client: 'default',
  });
  const [read, ...more] = r.to(`${REST}/outreach_mailboxes`);
  assert.ok(read && !more.length, 'the mailbox read once');
  assert.equal(read.method, 'GET');
  assert.equal(read.headers.get('apikey'), 'sb_secret_test', 'with the secret key');
  assert.deepEqual(Object.fromEntries(params(read)), { id: `eq.${MB1}`, select: 'id,active,addresses' });
  assert.equal(r.to(TOKEN_URL).length + r.to(`${RPC}/google_token`).length, 0, 'no token read');
});

await check('gmail connect: a missing or inactive mailbox, one without an @assetstackai.com address, a bad id or origin → 400', async () => {
  const cases = [
    ['That mailbox isn’t in Cortex any more.', {}, () => reply(200, [])],
    ['That mailbox isn’t active.', {}, () => reply(200, [{ ...MAILBOX_ROW, active: false }])],
    ['Connect Gmail needs an @assetstackai.com address on this mailbox for now.', {}, () => reply(200, [{ ...MAILBOX_ROW, addresses: ['x@assetstackai.com.au', 'y@mail.assetstackai.com', 'z@example.com', 'assetstackai.com'] }])],
    ['Connect Gmail needs an @assetstackai.com address on this mailbox for now.', {}, () => reply(200, [{ ...MAILBOX_ROW, addresses: [] }])],
  ];
  for (const [error, body, answer] of cases) {
    const r = await mbConnect(body, { [`${REST}/outreach_mailboxes`]: answer });
    assert.deepEqual([r.status, r.data], [400, { error }]);
  }
  for (const mailbox of ['', 'not-a-uuid', 42, null, `${MB1},x`, `${MB1}&select=*`]) {
    const r = await mbConnect({ mailbox });
    assert.deepEqual([r.status, r.data], [400, { error: 'Choose a mailbox to connect.' }], String(mailbox));
    assert.equal(r.to(`${REST}/outreach_mailboxes`).length, 0, 'never read');
  }
  const evil = await mbConnect({ origin: 'https://evil.example.com' });
  assert.deepEqual([evil.status, evil.to(`${REST}/outreach_mailboxes`).length], [400, 0]);
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    const down = await mbConnect({}, { [`${REST}/outreach_mailboxes`]: () => reply(500, { message: 'boom' }) });
    assert.deepEqual([down.status, down.data], [502, { error: 'Could not read the mailbox.' }]);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logs, ['google/connect: GET outreach_mailboxes → 500  boom']);
});

// ── Mailbox callback ──

const mbState = (over = {}) => stateFor({ purpose: 'mailbox', mailbox: MB1, client: 'default', ...over });
const mbToken = (over = {}) => ({
  access_token: 'first-access-token', refresh_token: 'new-refresh-token', scope: MB_SCOPES, token_type: 'Bearer', id_token: idToken({ email: BOX1 }), ...over,
});
const mbRoutes = (token = mbToken(), answer = () => reply(200, 'ok')) => ({ [TOKEN_URL]: () => reply(200, token), [`${RPC}/outreach_gmail_connect`]: answer });
const connects = (r) => r.to(`${RPC}/outreach_gmail_connect`);
const neverPersonal = (r, label) => assert.equal(r.to(`${RPC}/google_save`).length + r.to(`${RPC}/calendar_share`).length, 0, `${label}: never google_save or calendar_share`);

await check('gmail callback: connected — the code exchanged, rpc outreach_gmail_connect with the secret key → #/settings?tab=outreach&gmail=connected&mailbox=…', async () => {
  const r = await callback(await mbState(), { routes: mbRoutes(mbToken({ id_token: idToken({ email: 'Mailbox-One@AssetStackAI.com', email_verified: 'true' }) })) });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), outreachPage('connected'));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const [ex] = r.to(TOKEN_URL);
  assert.deepEqual(Object.fromEntries(ex.form), {
    code: 'auth-code', client_id: ENV.GOOGLE_CLIENT_ID, client_secret: SECRET, redirect_uri: `${SUPABASE}/functions/v1/google/callback`, grant_type: 'authorization_code',
  });
  const [save, ...more] = connects(r);
  assert.ok(save && !more.length);
  assert.equal(save.method, 'POST');
  assert.deepEqual([save.headers.get('apikey'), save.headers.get('authorization'), save.headers.get('content-type')], ['sb_secret_test', null, 'application/json']);
  assert.deepEqual(save.json(), {
    p_mailbox: MB1, p_email: BOX1, p_token: 'new-refresh-token', p_scopes: MB_SCOPES, p_by: 'u-ana', p_client: 'default',
  }, 'the mailbox’s account (not the admin’s), the state’s admin and client');
  assert.equal(r.calls.at(-1), save, 'nothing after it');
  neverPersonal(r, 'connected');
  assert.ok(!SECRET_BITS.some((x) => r.headers.get('location').includes(x)) && r.text === '', 'no token in the redirect');
  // A legacy JWT-style secret key: apikey and Bearer.
  const legacy = await callback(await mbState(), { env: LEGACY_ENV, routes: mbRoutes() });
  assert.equal(legacy.headers.get('location'), outreachPage('connected'));
  assert.deepEqual([connects(legacy)[0].headers.get('apikey'), connects(legacy)[0].headers.get('authorization')], ['eyJ.service.placeholder', 'Bearer eyJ.service.placeholder']);
  // Google's scope string as given (gmail.readonly with others it may add).
  const wider = await callback(await mbState({ mailbox: MB2 }), { routes: mbRoutes(mbToken({ scope: `${GMAIL_READ} openid https://www.googleapis.com/auth/userinfo.email` })) });
  assert.equal(wider.headers.get('location'), outreachPage('connected', MB2));
  assert.deepEqual(pick(connects(wider)[0].json(), ['p_mailbox', 'p_scopes']), { p_mailbox: MB2, p_scopes: `${GMAIL_READ} openid https://www.googleapis.com/auth/userinfo.email` });
});

await check('gmail callback: denied, wrong_account, gmail_scope (nothing saved), no_refresh_token and error&reason=<step>, each with the mailbox id', async () => {
  const state = await mbState();
  const denied = await callback(state, { query: `?error=access_denied&state=${encodeURIComponent(state)}` });
  assert.deepEqual([denied.status, denied.headers.get('location'), denied.calls.length], [302, outreachPage('denied'), 0]);
  const exchange = (body, status = 200) => ({ [TOKEN_URL]: () => reply(status, body) });
  const cases = [
    ['error&reason=exchange', exchange({ error: 'invalid_grant', error_description: 'Bad Request' }, 400)],
    ['error&reason=exchange', { [TOKEN_URL]: () => { throw new TypeError('fetch failed'); } }],
    ['error&reason=client', exchange({ error: 'invalid_client', error_description: 'Unauthorized' }, 401)],
    ['error&reason=client', exchange({ error: 'unauthorized_client' }, 400)],
    ['wrong_account', exchange(mbToken({ id_token: idToken({ email: BOX1, email_verified: false }) }))],
    ['wrong_account', exchange(mbToken({ id_token: undefined }))],
    ['wrong_account', exchange(mbToken({ id_token: idToken({ email: '' }) }))],
    ...['openid email', g.SCOPES, `openid email ${GMAIL_READ}.x`, 'openid email https://www.googleapis.com/auth/gmail.metadata', '', undefined]
      .map((scope) => ['gmail_scope', exchange(mbToken({ scope }))]),
    ['no_refresh_token', exchange(mbToken({ refresh_token: undefined }))],
    ['wrong_account', mbRoutes(mbToken(), () => reply(200, 'wrong_account'))],
    ...[['no_mailbox', () => reply(200, 'no_mailbox')], ['not_admin', () => reply(200, 'not_admin')], ['null', () => reply(200, null)], ['OK', () => reply(200, 'OK')],
      ['500', () => reply(500, { code: 'XX000', message: 'boom' })], ['403', () => reply(403, { code: '42501', message: 'permission denied for function outreach_gmail_connect' })],
      ['network', () => { throw new TypeError('fetch failed'); }]].map(([label, answer]) => ['error&reason=save', mbRoutes(mbToken(), answer), label]),
  ];
  for (const [result, routes, label = result] of cases) {
    const r = await loggedCallback(state, { routes });
    assert.equal(r.status, 302, label);
    assert.equal(r.headers.get('location'), outreachPage(result), label);
    if (result.startsWith('error&reason=')) failureLogged(r, result.slice('error&reason='.length));
    else assert.equal(r.logs.length, 0, `${label}: nothing logged (it names itself)`);
    const saving = result === 'error&reason=save' || (result === 'wrong_account' && routes[`${RPC}/outreach_gmail_connect`]);
    assert.equal(connects(r).length, saving ? 1 : 0, `${label}: outreach_gmail_connect ${saving ? 'asked once' : 'never asked'}`);
    neverPersonal(r, label);
    assert.ok(!SECRET_BITS.some((x) => r.headers.get('location').includes(x)) && r.text === '', `${label}: no token in the redirect`);
  }
  const answered = await loggedCallback(state, { routes: mbRoutes(mbToken(), () => reply(200, 'not_admin')) });
  assert.equal(answered.logs[0], 'google callback: save 200 answered "not_admin"');
  const db = await loggedCallback(state, { routes: mbRoutes(mbToken(), () => reply(403, { code: '42501', message: 'permission denied for function outreach_gmail_connect' })) });
  assert.equal(db.logs[0], 'google callback: save 403 42501 · permission denied for function outreach_gmail_connect');
  const noCode = await loggedCallback(state, { query: `?state=${encodeURIComponent(state)}` });
  assert.equal(noCode.headers.get('location'), outreachPage('error&reason=exchange'));
  failureLogged(noCode, 'exchange');
  // A client key this function doesn't know: reason client, without asking Google.
  const other = await loggedCallback(await mbState({ client: 'org' }));
  assert.deepEqual([other.headers.get('location'), other.calls.length], [outreachPage('error&reason=client'), 0]);
  failureLogged(other, 'client');
});

await check('gmail callback: a bad mailbox in the state → the expired page; plain and calendar connects are unchanged', async () => {
  for (const mailbox of ['', 'nope', undefined, 42]) {
    const r = await callback(await mbState({ mailbox }));
    assert.deepEqual([r.status, r.text, r.calls.length], [400, EXPIRED, 0], String(mailbox));
  }
  // The purpose and mailbox are signed: a plain state can't be turned into a mailbox one.
  const good = await stateFor();
  const [head, sig] = good.split('.');
  const body = JSON.parse(Buffer.from(head, 'base64url').toString());
  const forged = await callback(`${b64url(JSON.stringify({ ...body, purpose: 'mailbox', mailbox: MB1 }))}.${sig}`);
  assert.deepEqual([forged.status, forged.text, forged.calls.length], [400, EXPIRED, 0]);
  // A plain connect: your own account, google_save, back to Settings → Business; never outreach_gmail_connect.
  const plain = await callback(await stateFor(), { routes: mbRoutes(mbToken({ id_token: idToken({}), scope: `${g.SCOPES} ${GMAIL_READ}` })) });
  assert.equal(plain.headers.get('location'), settings('connected'));
  assert.deepEqual([plain.to(`${RPC}/google_save`).length, connects(plain).length], [1, 0]);
  const notYours = await callback(await stateFor(), { routes: mbRoutes() });
  assert.equal(notYours.headers.get('location'), settings('error&reason=wrong_account'), 'a plain connect still wants your own account');
  // A calendar connect: calendar_share, back to the Calendar page; never outreach_gmail_connect.
  const cal = await callback(await calState(), { routes: { [TOKEN_URL]: () => reply(200, calToken()) } });
  assert.equal(cal.headers.get('location'), calendarPage('connected'));
  assert.deepEqual([shares(cal).length, connects(cal).length], [1, 0]);
});

// ── outreach-gmail-sync ──

await check('gmail sync: 401 without a JWT (nothing called), 403 without Outreach view; staff with view may sync; CORS; GET → 405', async () => {
  const anon = await gSync({ auth: '' });
  assert.deepEqual([anon.status, anon.calls.length], [401, 0]);
  assert.equal(anon.headers.get('access-control-allow-origin'), ORIGIN);
  for (const answer of [() => reply(200, { view: false, edit: false, admin: false }), () => reply(200, null), () => reply(403, { code: '42501', message: 'Not allowed' })]) {
    const r = await gSync({ routes: { [`${RPC}/outreach_access`]: answer } });
    assert.deepEqual([r.status, r.data], [403, { error: NO_OUTREACH }]);
    assert.equal(r.calls.length, 1, 'only outreach_access: nothing claimed');
  }
  const expired = await gSync({ routes: { [`${RPC}/outreach_access`]: () => reply(401, { code: 'PGRST301', message: 'JWT expired' }) } });
  assert.equal(expired.status, 401);
  const staff = await gSync({ claim: [] });
  assert.equal(staff.status, 200, 'view is enough (not only admins)');
  const [acc] = staff.to(`${RPC}/outreach_access`);
  assert.deepEqual([acc.headers.get('apikey'), acc.headers.get('authorization'), acc.body], ['sb_publishable_test', USER_JWT, '{}']);
  assert.equal(staff.to(`${RPC}/google_me`).length, 0);
  assert.deepEqual([staff.headers.get('access-control-allow-origin'), staff.headers.get('content-type')], [ORIGIN, 'application/json']);
  const pre = await run('outreach-gmail-sync', { method: 'OPTIONS', auth: '' });
  assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin'), pre.calls.length], [204, ORIGIN, 0]);
  const get = await run('outreach-gmail-sync', { method: 'GET' });
  assert.deepEqual([get.status, get.headers.get('allow')], [405, 'POST, OPTIONS']);
  const bad = await gSync({ body: [] });
  assert.equal(bad.status, 400, 'a body that isn’t an object');
  assert.equal(bad.to(`${RPC}/outreach_gmail_claim`).length, 0);
});

await check('gmail sync: rpc outreach_gmail_claim with the secret key, p_gap 600 (60 forced), p_limit 3; nothing claimed → no Google calls', async () => {
  for (const [body, gap] of [[{}, 600], [{ force: false }, 600], [{ force: 'yes' }, 600], [{ force: 1 }, 600], [{ force: true }, 60]]) {
    const r = await gSync({ body, claim: [] });
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.deepEqual(r.data, { ok: true, claimed: 0, synced: 0, failed: 0, more: false, pending: 0, since: GSTART });
    const [claim, ...more] = r.to(`${RPC}/outreach_gmail_claim`);
    assert.ok(claim && !more.length);
    assert.equal(claim.method, 'POST');
    assert.deepEqual([claim.headers.get('apikey'), claim.headers.get('authorization')], ['sb_secret_test', null]);
    assert.deepEqual(claim.json(), { p_gap: gap, p_limit: 3 }, JSON.stringify(body));
    assert.equal(r.to(`${RPC}/outreach_gmail_known`).length + r.to(`${RPC}/outreach_gmail_job`).length + r.to(TOKEN_URL).length + r.gmail.length + r.saves.length, 0);
  }
  assert.deepEqual((await gSync({ claim: null })).data, { ok: true, claimed: 0, synced: 0, failed: 0, more: false, pending: 0, since: GSTART });
  const objects = await gSync({ claim: [{ outreach_gmail_claim: MB1 }, MB1, '', null], jobs: { [MB1]: gJob(MB1, { history_id: '8000' }) } });
  assert.deepEqual([objects.data.claimed, objects.to(`${RPC}/outreach_gmail_job`).map((c) => c.json())], [1, [{ p_mailbox: MB1 }]], 'each mailbox once');
  const down = await gSync({ routes: { [`${RPC}/outreach_gmail_claim`]: () => reply(500, { code: 'XX000', message: 'boom' }) } });
  assert.deepEqual([down.status, down.data], [502, { error: 'Could not start the Gmail sync.' }]);
  assert.ok(down.logs.some((l) => l.startsWith('google/outreach-gmail-sync: POST rpc/outreach_gmail_claim → 500')), down.logs.join('\n'));
  assert.equal(down.gmail.length, 0);
});

await check('gmail sync: a first read — profile check, 90 days of sent mail (paged), threads newest first, the cold ones saved with the cursor', async () => {
  const r = await gSync();
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true, claimed: 1, synced: 1, failed: 0, more: false, pending: 0, since: GSTART });
  const [known] = r.to(`${RPC}/outreach_gmail_known`);
  assert.deepEqual([known.method, known.headers.get('apikey'), known.body], ['POST', 'sb_secret_test', '{}']);
  const [job] = r.to(`${RPC}/outreach_gmail_job`);
  assert.deepEqual([job.headers.get('apikey'), job.json()], ['sb_secret_test', { p_mailbox: MB1 }]);
  const [tok] = r.to(TOKEN_URL);
  assert.deepEqual(Object.fromEntries(tok.form), { client_id: ENV.GOOGLE_CLIENT_ID, client_secret: SECRET, refresh_token: `gmail-refresh-${MB1}`, grant_type: 'refresh_token' });
  const [profile] = r.to(`${GMAIL_API}/profile`);
  assert.deepEqual([profile.url, profile.method, profile.headers.get('authorization')], [`${GMAIL_API}/profile`, 'GET', `Bearer gmail-access-${MB1}`]);
  assert.deepEqual(r.lists.map((c) => [...params(c)]), [
    [['q', `in:sent after:${AFTER_90}`], ['maxResults', '500'], ['fields', 'messages(threadId),nextPageToken']],
    [['q', `in:sent after:${AFTER_90}`], ['maxResults', '500'], ['fields', 'messages(threadId),nextPageToken'], ['pageToken', 'p1']],
  ]);
  assert.ok(r.calls.indexOf(profile) < r.calls.indexOf(r.lists[0]) && r.calls.indexOf(r.lists[1]) < r.calls.indexOf(r.threads[0]), 'profile, list, then threads');
  assert.deepEqual([...fetched(r)].sort(), [...LISTED].sort(), 'every listed thread read once');
  assert.deepEqual(fetched(r).slice(0, 6), LISTED.slice(0, 6), 'newest first');
  // Only the stored check and the prior-inbound checks besides; prior only for cold candidates.
  assert.deepEqual(r.to(`${REST}/outreach_threads`).map((c) => Object.fromEntries(params(c))), [
    { select: 'thread_id', mailbox_id: `eq.${MB1}`, thread_id: `in.(${LISTED.join(',')})` },
  ]);
  assert.deepEqual(r.priors.map((c) => params(c).get('q')).sort(), [
    `from:alex@example.org before:${Date.parse('2026-10-13T22:00:00Z') / 1000}`, `from:bo@example.net before:${Date.parse('2026-10-14T01:00:00Z') / 1000}`,
    `from:dee@example.org before:${Date.parse('2026-10-14T02:00:00Z') / 1000}`, `from:fay@example.org before:${Date.parse('2026-10-14T06:00:00Z') / 1000}`,
    `from:sam@example.org before:${Date.parse('2026-10-14T00:00:00Z') / 1000}`,
  ].sort());
  assert.deepEqual([...params(r.priors[0])].map(([k]) => k), ['q', 'maxResults', 'fields']);
  assert.ok(r.priors.every((c) => params(c).get('maxResults') === '1' && params(c).get('fields') === 'messages(id)'));
  // One save: the cold threads (tPrior had written before), their messages, and the cursor.
  assert.equal(r.saves.length, 1);
  const [save] = r.saves;
  assert.deepEqual([save.method, save.headers.get('apikey'), save.headers.get('content-type')], ['POST', 'sb_secret_test', 'application/json']);
  assert.deepEqual(r.saved[0], {
    p_mailbox: MB1, p_started: iso(GNOW + 5000), p_threads: [ROW_A, ROW_B, ROW_C, ROW_D], p_messages: [...MSGS_A, ...MSGS_B, ...MSGS_C, ...MSGS_D],
    p_cursor: { history_id: '9100', scan_from: iso(GNOW - 90 * DAY), pending: [] }, p_release: false, p_error: '', p_reconnect: false,
  });
  assert.equal(r.calls.at(-1), save, 'saved last');
  noText(r);
  gNoTokens(r);
  // The claim's own run_started, when the job gives it, is the run's start.
  const own = await gSync({ jobs: { [MB1]: gJob(MB1, { run_started: '2026-10-21T00:00:01.234567+00:00' }) } });
  assert.equal(own.saved[0].p_started, '2026-10-21T00:00:01.234567+00:00');
});

await check('gmail sync: a first read signed in as another account → reconnect, nothing listed; the list is capped at listPages', async () => {
  const r = await gSync({ profile: () => reply(200, { emailAddress: 'someone@assetstackai.com', historyId: '1' }) });
  assert.deepEqual(r.data, { ok: true, claimed: 1, synced: 0, failed: 1, more: false, pending: 0, since: GSTART });
  assert.deepEqual(r.saved, [{
    p_mailbox: MB1, p_started: iso(GNOW + 5000), p_threads: [], p_messages: [], p_cursor: {}, p_release: false, p_error: 'Signed in as another account.', p_reconnect: true,
  }]);
  assert.equal(r.lists.length + r.threads.length, 0);
  assert.ok(r.logs.some((l) => l === 'google/outreach-gmail-sync: mailbox failed at profile 409'), r.logs.join('\n'));
  gNoTokens(r);
  // Endless pages: listPages of them, then what was found is read.
  let n = 0;
  const capped = await gSync({ limits: { listPages: 3 }, list: () => reply(200, { messages: [{ id: `m${n}`, threadId: `tX${n}` }], nextPageToken: `p${++n}` }) });
  assert.equal(capped.lists.length, 3);
  assert.deepEqual(fetched(capped), ['tX0', 'tX1', 'tX2']);
  assert.deepEqual([capped.saved[0].p_threads, capped.saved[0].p_cursor.pending, capped.data.more], [[], [], false], 'gone from Gmail (404): dropped');
});

const HISTORY_PAGES = {
  '': {
    history: [
      { id: '8001', messages: [{ id: 'n1', threadId: 'tA' }], messagesAdded: [{ message: { id: 'n1', threadId: 'tA', labelIds: ['SENT'] } }] },
      { id: '8002', messagesAdded: [{ message: { id: 'n2', threadId: 'tX', labelIds: ['INBOX', 'UNREAD'] } }] },
      { id: '8003', messagesAdded: [{ message: { id: 'n3', threadId: 'tB', labelIds: ['INBOX', 'CATEGORY_PERSONAL'] } }] },
    ],
    nextPageToken: 'hp2', historyId: '8010',
  },
  hp2: {
    history: [
      { id: '8004', messagesAdded: [
        { message: { id: 'd1', threadId: 'tDraftOnly', labelIds: ['DRAFT'] } }, { message: { id: 'c1', threadId: 'tChat', labelIds: ['CHAT'] } },
        { message: { id: 'n5', threadId: 'tC', labelIds: ['SENT'] } }, { message: { id: 'n6', threadId: 'tY', labelIds: ['SENT', 'DRAFT'] } },
      ] },
    ],
    historyId: '8010',
  },
};
const historyPages = (pages = HISTORY_PAGES) => (c) => reply(200, pages[params(c).get('pageToken') || '']);

await check('gmail sync: incremental — history since the last run; SENT queues its thread, inbound only a stored cold thread; drafts and chats skipped', async () => {
  const r = await gSync({
    jobs: { [MB1]: gJob(MB1, { history_id: '8000', pending: ['tOld', 'tC'], scan_from: iso(GNOW - 90 * DAY), synced_at: '2026-10-20T00:00:00Z', ready: true }) },
    history: historyPages(), stored: ['tB'],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.to(`${GMAIL_API}/history?`).map((c) => [...params(c)]), [
    [['startHistoryId', '8000'], ['historyTypes', 'messageAdded'], ['maxResults', '500'], ['fields', HISTORY_FIELDS]],
    [['startHistoryId', '8000'], ['historyTypes', 'messageAdded'], ['maxResults', '500'], ['fields', HISTORY_FIELDS], ['pageToken', 'hp2']],
  ]);
  assert.equal(r.to(`${GMAIL_API}/profile`).length + r.lists.length, 0, 'no profile or listing');
  const lookups = r.to(`${REST}/outreach_threads`).map((c) => params(c).get('thread_id'));
  assert.deepEqual(lookups, ['in.(tB,tX)', 'in.(tC,tB,tA,tOld)'], 'the inbound threads, then the batch');
  assert.deepEqual(fetched(r), ['tC', 'tB', 'tA', 'tOld'], 'newest first, then the stored queue; tX (not stored) and drafts/chats never');
  assert.deepEqual(r.priors.map((c) => params(c).get('q').split(' ')[0]).sort(), ['from:alex@example.org', 'from:dee@example.org'], 'the stored thread skips the cold rule');
  assert.deepEqual(r.saved, [{
    p_mailbox: MB1, p_started: iso(GNOW + 5000), p_threads: [ROW_C, ROW_B, ROW_A], p_messages: [...MSGS_C, ...MSGS_B, ...MSGS_A],
    p_cursor: { history_id: '8010', pending: [] }, p_release: false, p_error: '', p_reconnect: false,
  }]);
  assert.deepEqual(r.data, { ok: true, claimed: 1, synced: 1, failed: 0, more: false, pending: 0, since: GSTART });
  // A stored cold thread whose rules would now say no (the prospect became a client) is still refreshed.
  const client = await gSync({
    jobs: { [MB1]: gJob(MB1, { history_id: '8000' }) }, stored: ['tA'], known: { ...KNOWN, emails: ['alex@example.org'] },
    history: () => reply(200, { history: [{ id: '8001', messagesAdded: [{ message: { id: 'mA4', threadId: 'tA', labelIds: ['INBOX'] } }] }], historyId: '8002' }),
  });
  assert.deepEqual([client.saved[0].p_threads, client.priors.length], [[ROW_A], 0]);
  // No changes: one save with the new history id.
  const quiet = await gSync({ jobs: { [MB1]: gJob(MB1, { history_id: '8000' }) } });
  assert.deepEqual(quiet.saved.map((b) => [b.p_threads, b.p_cursor]), [[[], { history_id: '8999', pending: [] }]]);
  assert.equal(quiet.threads.length + quiet.to(`${REST}/outreach_threads`).length, 0);
  noText(r);
  gNoTokens(r);
});

await check('gmail sync: history gone (404) → restart from max(last sync − 2 days, 90 days ago); inbound only for stored cold threads', async () => {
  const gone = () => reply(404, { error: { code: 404, message: 'Requested entity was not found.' } });
  const listed = [];
  const list = (c, q) => {
    listed.push(q);
    return q.startsWith('-in:sent') ? reply(200, { messages: [{ id: 'i1', threadId: 'tB' }, { id: 'i2', threadId: 'tZ' }, { id: 'i3', threadId: 'tC' }] })
      : reply(200, { messages: [{ id: 's1', threadId: 'tC' }] });
  };
  const after = Math.floor(Date.parse('2026-10-18T00:00:00Z') / 1000);
  const r = await gSync({
    jobs: { [MB1]: gJob(MB1, { history_id: '7000', synced_at: '2026-10-20T00:00:00Z', scan_from: '2026-07-23T00:00:00.000Z', pending: ['tOld'] }) },
    history: gone, list, stored: ['tB'],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(listed, [`in:sent after:${after}`, `-in:sent after:${after}`]);
  assert.equal(r.to(`${GMAIL_API}/profile`).length, 1, 'the account checked again');
  assert.deepEqual(r.to(`${REST}/outreach_threads`).map((c) => params(c).get('thread_id')), ['in.(tB,tZ,tC)', 'in.(tC,tB,tOld)']);
  assert.deepEqual(fetched(r), ['tC', 'tB', 'tOld']);
  assert.deepEqual(r.saved[0].p_cursor, { history_id: '9100', pending: [] }, 'the stored scan_from stays');
  assert.deepEqual(r.saved[0].p_threads, [ROW_C, ROW_B]);
  // A last sync long ago (or never) → 90 days; no scan_from yet → set.
  for (const syncedAt of ['2026-01-01T00:00:00Z', null, 'garbage']) {
    listed.length = 0;
    const old = await gSync({ jobs: { [MB1]: gJob(MB1, { history_id: '7000', synced_at: syncedAt }) }, history: gone, list });
    assert.deepEqual(listed, [`in:sent after:${AFTER_90}`, `-in:sent after:${AFTER_90}`], String(syncedAt));
    assert.deepEqual(old.saved[0].p_cursor, { history_id: '9100', scan_from: iso(GNOW - 90 * DAY), pending: [] });
  }
  // Signed in as another account on a restart too.
  const other = await gSync({ jobs: { [MB1]: gJob(MB1, { history_id: '7000' }) }, history: gone, profile: () => reply(200, { emailAddress: 'x@example.org', historyId: '1' }) });
  assert.deepEqual(other.saved.map((b) => [b.p_error, b.p_reconnect]), [['Signed in as another account.', true]]);
});

await check('gmail sync: threads.get asks for headers only — format=metadata, the agreed headers, a fields mask without snippet; never full or raw', async () => {
  const r = await gSync();
  assert.ok(r.threads.length > 10);
  for (const c of r.threads) {
    const u = new URL(c.url);
    assert.equal(u.pathname.startsWith('/gmail/v1/users/me/threads/'), true);
    assert.deepEqual([...u.searchParams], [['format', 'metadata'], ...METADATA.map((h) => ['metadataHeaders', h]), ['fields', THREAD_FIELDS]]);
    assert.deepEqual([c.method, c.headers.get('authorization')], ['GET', `Bearer gmail-access-${MB1}`]);
  }
  for (const c of r.gmail) {
    assert.ok(!/snippet|format=(full|raw|minimal)|\/messages\/[^?]/i.test(c.url), c.url);
    assert.equal(c.method, 'GET', 'Gmail is only read');
  }
  assert.equal(r.calls.filter((c) => c.url.startsWith('https://gmail.googleapis.com/') && c.method !== 'GET').length, 0);
});

await check('gmail sync: caps — threadsPerRun and saveEvery split the work; only the last save releases the claim when more is left', async () => {
  const r = await gSync({ limits: { threadsPerRun: 5, saveEvery: 2 } });
  assert.deepEqual(fetched(r), LISTED.slice(0, 5));
  assert.equal(r.saves.length, 3);
  assert.deepEqual(r.saved.map((b) => [b.p_threads.map((t) => t.thread_id), b.p_cursor.pending.length, b.p_release]), [
    [['tA', 'tB'], LISTED.length - 2, false], [['tC'], LISTED.length - 4, false], [[], LISTED.length - 5, true],
  ]);
  assert.deepEqual(r.saved[0].p_cursor, { history_id: '9100', scan_from: iso(GNOW - 90 * DAY), pending: LISTED.slice(2) }, 'the first save carries the new cursor');
  assert.deepEqual([r.saved[1].p_cursor, r.saved[2].p_cursor], [{ pending: LISTED.slice(4) }, { pending: LISTED.slice(5) }], 'later saves only the queue');
  assert.deepEqual(r.data, { ok: true, claimed: 1, synced: 1, failed: 0, more: true, pending: LISTED.length - 5, since: GSTART });
  assert.ok(r.saved.every((b) => b.p_started === r.saved[0].p_started), 'one start for the run');
  // History beyond historyPages: stop at the last record read, more (released) even with nothing queued.
  const capped = await gSync({ jobs: { [MB1]: gJob(MB1, { history_id: '8000' }) }, limits: { historyPages: 1 }, history: historyPages(), stored: [] });
  assert.equal(capped.to(`${GMAIL_API}/history?`).length, 1);
  assert.deepEqual(capped.saved.map((b) => [b.p_cursor, b.p_release]), [[{ history_id: '8003', pending: [] }, true]], 'the last record read, released');
  assert.deepEqual(fetched(capped), ['tA']);
  assert.deepEqual(capped.data, { ok: true, claimed: 1, synced: 1, failed: 0, more: true, pending: 0, since: GSTART });
});

await check('gmail sync: the deadline stops reading (more, claim released); claimed mailboxes share the run’s time', async () => {
  let t = GNOW;
  const clock = () => t;
  const slow = (id) => { t += 10000; return THREADS[id]; };
  const one = await gSync({ now: clock, threads: slow, limits: { deadline: 35000, parallel: 1 } });
  assert.deepEqual(fetched(one), LISTED.slice(0, 4), 'started at 0, 10, 20 and 30 s; not at 40 s');
  assert.deepEqual(one.saved.map((b) => [b.p_threads.map((x) => x.thread_id), b.p_cursor.pending, b.p_release]), [[['tA', 'tB', 'tC'], LISTED.slice(4), true]]);
  assert.deepEqual(pick(one.data, ['synced', 'more', 'pending']), { synced: 1, more: true, pending: LISTED.length - 4 });
  // Six at a time: each checks the clock before it starts.
  t = GNOW;
  const lanes = await gSync({ now: clock, threads: slow, limits: { deadline: 35000 } });
  assert.equal(fetched(lanes).length, 4);
  // Two mailboxes, 40 s: the first gets half; the second what is left.
  t = GNOW;
  const two = await gSync({
    now: clock, threads: slow, limits: { deadline: 40000, parallel: 1 }, claim: [MB1, MB2], jobs: { [MB1]: gJob(MB1), [MB2]: gJob(MB2) },
  });
  assert.deepEqual(two.threads.map(boxOf), [MB1, MB1, MB2, MB2]);
  assert.deepEqual(two.saved.map((b) => [b.p_mailbox, b.p_threads.length, b.p_release]), [[MB1, 2, true], [MB2, 2, true]]);
  assert.deepEqual(pick(two.data, ['claimed', 'synced', 'more', 'pending']), { claimed: 2, synced: 2, more: true, pending: 2 * (LISTED.length - 2) });
  // Past the deadline before a mailbox's threads: its cursor is still saved (released, more).
  t = GNOW;
  const late = await gSync({ now: () => (t += 1000), limits: { deadline: 1000 } });
  assert.deepEqual(late.saved.map((b) => [b.p_threads.length, b.p_cursor.pending.length, b.p_release]), [[0, LISTED.length, true]]);
});

await check('gmail sync: Gmail rate limits — one short back-off, then stop with the claim held and more false (no error); during the listing → error, try later', async () => {
  const limited = (status, body) => () => reply(status, body);
  const rate403 = { error: { code: 403, message: 'User-rate limit exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } };
  for (const [label, answer] of [['429', limited(429, { error: { code: 429, message: 'Too many requests' } })], ['403', limited(403, rate403)]]) {
    let n = 0;
    const once = await gSync({ limits: { parallel: 1, backoff: 1234 }, threads: (id) => (id === 'tB' && n++ === 0 ? answer() : THREADS[id]) });
    assert.deepEqual(once.sleeps, [1234], `${label}: waited once`);
    assert.deepEqual(fetched(once).filter((x) => x === 'tB'), ['tB', 'tB'], `${label}: tried again`);
    assert.deepEqual([once.saved[0].p_threads.map((x) => x.thread_id), once.data.more], [['tA', 'tB', 'tC', 'tDraftFirst'], false]);
    const always = await gSync({ limits: { parallel: 1 }, threads: (id) => (id === 'tC' ? answer() : THREADS[id]) });
    assert.deepEqual(always.sleeps, [2000], `${label}: the default back-off, once`);
    assert.deepEqual(fetched(always), ['tA', 'tB', 'tC', 'tC'], `${label}: nothing read after it`);
    assert.deepEqual(always.saved.map((b) => [b.p_threads.map((x) => x.thread_id), b.p_cursor.pending[0], b.p_release, b.p_error]), [[['tA', 'tB'], 'tC', false, '']],
      `${label}: the chunk saved, the claim held (due again after its gap)`);
    assert.deepEqual(pick(always.data, ['synced', 'failed', 'more', 'pending']), { synced: 1, failed: 0, more: false, pending: LISTED.length - 2 }, `${label}: the chain ends`);
    assert.deepEqual(always.logs, []);
  }
  const listing = await gSync({ list: limited(429, {}) });
  assert.deepEqual(listing.saved.map((b) => [b.p_error, b.p_reconnect, b.p_release, b.p_cursor]), [[GMAIL_BUSY, false, false, {}]]);
  assert.deepEqual(pick(listing.data, ['synced', 'failed', 'more']), { synced: 0, failed: 1, more: false });
  assert.equal(listing.sleeps.length, 1);
});

await check('gmail sync: a Gmail 500, 502, 503 or 504 — one back-off and retry; a thread’s twice is skipped (as a 404, counted in the log) and the run goes on; profile, listing or history → busy; others not retried', async () => {
  for (const status of [500, 502, 503, 504]) {
    const answer = () => reply(status, { error: { code: status, message: 'Backend Error' } });
    let n = 0;
    const once = await gSync({ limits: { parallel: 1, backoff: 1234 }, threads: (id) => (id === 'tB' && n++ === 0 ? answer() : THREADS[id]) });
    assert.deepEqual(once.sleeps, [1234], `${status}: waited once`);
    assert.deepEqual(fetched(once).filter((x) => x === 'tB'), ['tB', 'tB'], `${status}: tried again`);
    assert.deepEqual(once.saved.map((b) => [b.p_threads.map((x) => x.thread_id), b.p_error, b.p_release]), [[['tA', 'tB', 'tC', 'tDraftFirst'], '', false]], `${status}: read normally`);
    assert.deepEqual(once.data, { ok: true, claimed: 1, synced: 1, failed: 0, more: false, pending: 0, since: GSTART });
    const twice = await gSync({ limits: { parallel: 1 }, threads: (id) => (id === 'tC' ? answer() : THREADS[id]) });
    assert.deepEqual([twice.sleeps, fetched(twice).filter((x) => x === 'tC')], [[2000], ['tC', 'tC']], `${status}: one back-off, one retry`);
    assert.deepEqual(fetched(twice).filter((x) => x !== 'tC'), LISTED.filter((x) => x !== 'tC'), `${status}: every other thread still read`);
    assert.deepEqual(twice.saved.map((b) => [b.p_threads.map((x) => x.thread_id), b.p_cursor.pending, b.p_release, b.p_error]), [[['tA', 'tB', 'tDraftFirst'], [], false, '']],
      `${status}: skipped, never left at the front of the queue; no error`);
    assert.deepEqual(twice.data, { ok: true, claimed: 1, synced: 1, failed: 0, more: false, pending: 0, since: GSTART });
    assert.deepEqual(twice.logs, ['google/outreach-gmail-sync: skipped 1 thread(s) after a Gmail server error'], `${status}: a count, nothing else`);
    for (const [step, opts] of [['profile', { profile: answer }], ['list', { list: answer }], ['history', { jobs: { [MB1]: gJob(MB1, { history_id: '8000' }) }, history: answer }]]) {
      const busy = await gSync(opts);
      assert.deepEqual(busy.saved.map((b) => [b.p_error, b.p_reconnect, b.p_release]), [[GMAIL_BUSY, false, false]], `${status} at ${step}`);
      assert.deepEqual([pick(busy.data, ['synced', 'failed', 'more']), busy.sleeps.length], [{ synced: 0, failed: 1, more: false }, 1], `${status} at ${step}`);
      assert.deepEqual(busy.logs, [`google/outreach-gmail-sync: mailbox failed at ${step} rate limited`]);
    }
  }
  // Six at a time, two threads failing: both skipped, one log line counting them.
  const server = () => reply(503, { error: { code: 503, message: 'Backend Error' } });
  const two = await gSync({ threads: (id) => (id === 'tA' || id === 'tC' ? server() : THREADS[id]) });
  assert.deepEqual(two.saved.map((b) => [b.p_threads.map((x) => x.thread_id), b.p_cursor.pending, b.p_release]), [[['tB', 'tDraftFirst'], [], false]]);
  assert.deepEqual([two.sleeps, two.logs], [[2000, 2000], ['google/outreach-gmail-sync: skipped 2 thread(s) after a Gmail server error']]);
  gNoTokens(two);
  // The prior-inbound check of a cold candidate failing the same way skips that thread too.
  const prior = await gSync({ limits: { parallel: 1 }, prior: (c, q) => (q.includes('dee@example.org') ? server() : reply(200, q.includes('sam@example.org') ? { messages: [{ id: 'older-1' }] } : {})) });
  assert.deepEqual(prior.saved.map((b) => [b.p_threads.map((x) => x.thread_id), b.p_cursor.pending]), [[['tA', 'tB', 'tDraftFirst'], []]]);
  assert.deepEqual(prior.logs, ['google/outreach-gmail-sync: skipped 1 thread(s) after a Gmail server error']);
  // The second answer decides: a rate limit then a server error skips the thread; a server error then a rate limit stops.
  let k = 0;
  const thenServer = await gSync({ limits: { parallel: 1 }, threads: (id) => (id === 'tC' ? (k++ === 0 ? reply(429, {}) : server()) : THREADS[id]) });
  assert.deepEqual(thenServer.saved.map((b) => [b.p_threads.map((x) => x.thread_id), b.p_cursor.pending, b.p_release]), [[['tA', 'tB', 'tDraftFirst'], [], false]]);
  let j = 0;
  const thenLimit = await gSync({ limits: { parallel: 1 }, threads: (id) => (id === 'tC' ? (j++ === 0 ? server() : reply(429, {})) : THREADS[id]) });
  assert.deepEqual(thenLimit.saved.map((b) => [b.p_threads.map((x) => x.thread_id), b.p_cursor.pending[0], b.p_release]), [[['tA', 'tB'], 'tC', false]]);
  assert.deepEqual([thenLimit.data.more, thenLimit.logs], [false, []]);
  for (const status of [400, 501]) {
    const r = await gSync({ limits: { parallel: 1 }, threads: (id) => (id === 'tC' ? reply(status, { error: { code: status } }) : THREADS[id]) });
    assert.deepEqual([r.sleeps, fetched(r).filter((x) => x === 'tC')], [[], ['tC']], `${status}: not retried`);
    assert.deepEqual(r.saved.map((b) => [b.p_error, b.p_release]), [[`Gmail returned ${status}.`, false]]);
  }
});

await check('gmail sync: a rate limit holds only that mailbox — the next one is still read; more false even with history or a queue left', async () => {
  const limited = () => reply(429, { error: { code: 429, message: 'Too many requests' } });
  const jobs = { [MB1]: gJob(MB1), [MB2]: gJob(MB2) };
  const r = await gSync({ body: { force: true }, claim: [MB1, MB2], jobs, limits: { parallel: 1 }, threads: (id, c) => (boxOf(c) === MB1 && id === 'tB' ? limited() : THREADS[id]) });
  assert.deepEqual(r.saved.map((b) => [b.p_mailbox, b.p_threads.map((x) => x.thread_id), b.p_cursor.pending.length, b.p_release, b.p_error]), [
    [MB1, ['tA'], LISTED.length - 1, false, ''], [MB2, ['tA', 'tB', 'tC', 'tDraftFirst'], 0, false, ''],
  ]);
  assert.deepEqual(r.data, { ok: true, claimed: 2, synced: 2, failed: 0, more: false, pending: LISTED.length - 1, since: GSTART });
  // Stopped by a rate limit with history still to read: the claim held, more false (the deadline would release, more).
  const history = { jobs: { [MB1]: gJob(MB1, { history_id: '8000' }) }, limits: { historyPages: 1 }, history: historyPages(), stored: [] };
  const held = await gSync({ ...history, threads: (id) => (id === 'tA' ? limited() : THREADS[id]) });
  assert.deepEqual(held.saved.map((b) => [b.p_cursor, b.p_release]), [[{ history_id: '8003', pending: ['tA'] }, false]]);
  assert.deepEqual(pick(held.data, ['synced', 'more', 'pending']), { synced: 1, more: false, pending: 1 });
  let t = GNOW;
  const late = await gSync({ ...history, now: () => (t += 1000), limits: { ...history.limits, deadline: 1000 } });
  assert.deepEqual(late.saved.map((b) => [b.p_cursor, b.p_release]), [[{ history_id: '8003', pending: ['tA'] }, true]]);
  assert.equal(late.data.more, true);
});

await check('gmail sync: since — the chain’s start, made on its first call and passed back; a later forced call’s p_gap is the time since plus 5 s (60 to 600)', async () => {
  const ago = (ms) => iso(GNOW - ms);
  for (const [body, gap, since] of [
    [{}, 600, GSTART], [{ force: true }, 60, GSTART],
    [{ force: true, since: ago(100000) }, 105, ago(100000)], [{ force: true, since: ago(100400) }, 106, ago(100400)],
    [{ force: true, since: ago(56000) }, 61, ago(56000)], [{ force: true, since: ago(30000) }, 60, ago(30000)], [{ force: true, since: GSTART }, 60, GSTART],
    [{ force: true, since: ago(3600000) }, 600, ago(3600000)],
    [{ force: true, since: '2026-10-20T23:58:20+00:00' }, 105, ago(100000)],
    [{ since: ago(100000) }, 600, ago(100000)], [{ force: 'yes', since: ago(100000) }, 600, ago(100000)],
    // Not a time, or in the future: a new chain, starting now.
    [{ force: true, since: 'yesterday' }, 60, GSTART], [{ force: true, since: '' }, 60, GSTART], [{ force: true, since: null }, 60, GSTART],
    [{ force: true, since: GNOW - 100000 }, 60, GSTART], [{ force: true, since: iso(GNOW + 1000) }, 60, GSTART], [{ since: iso(GNOW + 1000) }, 600, GSTART],
  ]) {
    const r = await gSync({ body, claim: [] });
    assert.deepEqual([r.to(`${RPC}/outreach_gmail_claim`).map((c) => c.json()), r.data], [[{ p_gap: gap, p_limit: 3 }], {
      ok: true, claimed: 0, synced: 0, failed: 0, more: false, pending: 0, since,
    }], JSON.stringify(body));
  }
  // 70 s into a chain: a mailbox claimed at its start (MB1) or during it (MB4) isn't due again; a released one (MB2) and
  // one last claimed over a minute before the chain (MB3) are. Without since, MB1 would be due again (p_gap 60).
  const claimedAt = { [MB1]: GNOW, [MB2]: null, [MB3]: GNOW - 61000, [MB4]: GNOW + 30000 };
  const at = GNOW + 70000;
  const due = (gap) => Object.keys(claimedAt).filter((mb) => claimedAt[mb] === null || claimedAt[mb] < at - gap * 1000);
  const routes = { [`${RPC}/outreach_gmail_claim`]: (c) => reply(200, due(c.json().p_gap)) };
  const jobs = { [MB1]: gJob(MB1), [MB2]: gJob(MB2), [MB3]: gJob(MB3), [MB4]: gJob(MB4) };
  const later = await gSync({ body: { force: true, since: GSTART }, now: () => at, routes, jobs });
  assert.deepEqual([later.to(`${RPC}/outreach_gmail_claim`)[0].json().p_gap, later.saved.map((b) => b.p_mailbox), later.data.since], [75, [MB2, MB3], GSTART]);
  const fresh = await gSync({ body: { force: true }, now: () => at, routes, jobs });
  assert.deepEqual([fresh.saved.map((b) => b.p_mailbox), fresh.data.since], [[MB1, MB2, MB3], iso(at)], 'a new chain');
});

await check('gmail sync: a full claim (p_limit mailboxes) answers more, so Sync now reaches a 4th due mailbox; fewer claimed and none with more → more false', async () => {
  const jobs = { [MB1]: gJob(MB1), [MB2]: gJob(MB2), [MB3]: gJob(MB3), [MB4]: gJob(MB4) };
  const due = [MB1, MB2, MB3, MB4];
  // The database: the due mailboxes, p_limit at a time; a claimed one isn't due again.
  const routes = { [`${RPC}/outreach_gmail_claim`]: (c) => reply(200, due.splice(0, c.json().p_limit)) };
  const first = await gSync({ body: { force: true }, jobs, routes });
  assert.deepEqual(first.to(`${RPC}/outreach_gmail_claim`).map((c) => c.json()), [{ p_gap: 60, p_limit: 3 }]);
  assert.deepEqual(first.data, { ok: true, claimed: 3, synced: 3, failed: 0, more: true, pending: 0, since: GSTART }, 'others may be due');
  assert.deepEqual(first.saved.map((b) => [b.p_mailbox, b.p_release]), [[MB1, false], [MB2, false], [MB3, false]], 'none of the three has more');
  const second = await gSync({ body: { force: true }, jobs, routes });
  assert.deepEqual(second.data, { ok: true, claimed: 1, synced: 1, failed: 0, more: false, pending: 0, since: GSTART });
  assert.deepEqual(second.saved.map((b) => b.p_mailbox), [MB4]);
  assert.deepEqual((await gSync({ body: { force: true }, jobs, routes })).data, { ok: true, claimed: 0, synced: 0, failed: 0, more: false, pending: 0, since: GSTART });
  // Two claimed of three, neither with more: done. Two of two: more.
  assert.deepEqual((await gSync({ claim: [MB1, MB2], jobs })).data, { ok: true, claimed: 2, synced: 2, failed: 0, more: false, pending: 0, since: GSTART });
  const full = await gSync({ claim: [MB1, MB2], jobs, limits: { mailboxes: 2 } });
  assert.deepEqual([full.to(`${RPC}/outreach_gmail_claim`)[0].json().p_limit, full.data.more], [2, true]);
  gNoTokens(first);
});

await check('gmail sync: save bodies carry only the agreed keys — no snippet, body or text anywhere, no token', async () => {
  const runs = [
    await gSync(), await gSync({ limits: { saveEvery: 1, threadsPerRun: 4 } }),
    await gSync({ jobs: { [MB1]: gJob(MB1, { history_id: '8000' }) }, history: historyPages(), stored: ['tB'] }),
    await gSync({ routes: { [TOKEN_URL]: () => reply(400, { error: 'invalid_grant' }) } }),
  ];
  for (const r of runs) {
    assert.ok(r.saves.length >= 1);
    for (const b of r.saved) {
      assert.deepEqual(Object.keys(b), SAVE_KEYS);
      for (const t of b.p_threads) assert.deepEqual(Object.keys(t), THREAD_KEYS);
      for (const m of b.p_messages) {
        assert.deepEqual(Object.keys(m), ['message_id', 'thread_id', 'kind', 'at']);
        assert.ok(['sent', 'reply', 'auto', 'bounce'].includes(m.kind));
        assert.ok(b.p_threads.some((t) => t.thread_id === m.thread_id), 'a message of a thread in the same save');
      }
      assert.ok(Object.keys(b.p_cursor).every((k) => ['history_id', 'scan_from', 'pending'].includes(k)), JSON.stringify(Object.keys(b.p_cursor)));
      assert.ok(!Object.keys(b).some((k) => /day/.test(k)) && !b.p_threads.some((t) => Object.keys(t).some((k) => /day|kind/.test(k))), 'days are the database’s');
    }
    noText(r);
    gNoTokens(r);
  }
});

await check('gmail sync: one mailbox’s failure never stops the others; reconnect for invalid_grant or a missing scope', async () => {
  const jobs = { [MB1]: gJob(MB1), [MB2]: gJob(MB2), [MB3]: gJob(MB3) };
  const r = await gSync({
    claim: [MB1, MB2, MB3], jobs,
    routes: {
      [TOKEN_URL]: (c) => (c.form.get('refresh_token').endsWith(MB1)
        ? reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
        : reply(200, { access_token: c.form.get('refresh_token').replace('gmail-refresh-', 'gmail-access-') })),
    },
    profile: (mb) => (mb === MB2 ? reply(400, { error: { code: 400, message: `Bad request for ${BOXES[MB2]}` } }) : reply(200, { emailAddress: BOXES[mb], historyId: '1' })),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true, claimed: 3, synced: 1, failed: 2, more: true, pending: 0, since: GSTART }, 'a full claim: more');
  assert.deepEqual(r.saved.map((b) => [b.p_mailbox, b.p_error, b.p_reconnect, b.p_threads.length]), [
    [MB1, GMAIL_RECONNECT, true, 0], [MB2, 'Gmail returned 400.', false, 0], [MB3, '', false, 4],
  ]);
  assert.ok(r.calls.indexOf(r.saves[0]) < r.calls.indexOf(r.to(TOKEN_URL)[1]), 'one mailbox at a time, in claim order');
  assert.equal(r.to(`${RPC}/outreach_gmail_known`).length, 1, 'known read once per run');
  assert.deepEqual(r.logs, ['google/outreach-gmail-sync: mailbox failed at token 409', 'google/outreach-gmail-sync: mailbox failed at profile 502']);
  gNoTokens(r);

  // Stored scopes without gmail.readonly, no token, an unknown client: reconnect without asking Google.
  for (const over of [{ scopes: 'openid email' }, { refresh_token: '' }, { client: 'org' }, { email: 'not an address' }]) {
    const s = await gSync({ jobs: { [MB1]: gJob(MB1, over) } });
    assert.deepEqual(s.saved.map((b) => [b.p_error, b.p_reconnect]), [[GMAIL_RECONNECT, true]], JSON.stringify(over));
    assert.equal(s.to(TOKEN_URL).length + s.gmail.length, 0);
  }
  // Google says the token lacks the scope.
  const insufficient = await gSync({ profile: () => reply(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }) });
  assert.deepEqual(insufficient.saved.map((b) => [b.p_error, b.p_reconnect]), [[GMAIL_RECONNECT, true]]);
  // A thread that fails mid-run: the error saved (nothing of the unsaved chunk), the cursor kept for next time.
  const broken = await gSync({ limits: { parallel: 1 }, threads: (id) => (id === 'tC' ? reply(400, { error: { code: 400 } }) : THREADS[id]) });
  assert.deepEqual(broken.saved.map((b) => [b.p_threads, b.p_cursor, b.p_error, b.p_release]), [[[], {}, 'Gmail returned 400.', false]]);
  const network = await gSync({ profile: () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(network.saved.map((b) => b.p_error), ['Something went wrong with Gmail.']);
});

await check('gmail sync: no connection, a mailbox gone mid-run, a failed save or a failed known read — counted, never fatal', async () => {
  // No connection (job null): skipped, nothing saved, the next one still syncs.
  const none = await gSync({ claim: [MB1, MB2], jobs: { [MB2]: gJob(MB2) } });
  assert.deepEqual(none.data, { ok: true, claimed: 2, synced: 1, failed: 0, more: false, pending: 0, since: GSTART });
  assert.deepEqual(none.saved.map((b) => b.p_mailbox), [MB2]);
  // outreach_gmail_save → false (disconnected or inactive meanwhile): stop that mailbox, neither synced nor failed.
  const gone = await gSync({ limits: { saveEvery: 2 }, save: () => reply(200, false) });
  assert.deepEqual([gone.saves.length, gone.data.synced, gone.data.failed], [1, 0, 0]);
  assert.equal(fetched(gone).length, 2, 'nothing read after it');
  // A save failing: counted, logged without a body; the error save is tried; the next mailbox still syncs.
  const failing = await gSync({
    claim: [MB1, MB2], jobs: { [MB1]: gJob(MB1), [MB2]: gJob(MB2) },
    save: (c) => (c.json().p_mailbox === MB1 ? reply(500, { code: 'XX000', message: 'boom' }) : reply(200, true)),
  });
  assert.deepEqual(failing.data, { ok: true, claimed: 2, synced: 1, failed: 1, more: false, pending: 0, since: GSTART });
  assert.deepEqual(failing.saved.map((b) => [b.p_mailbox, b.p_error]), [[MB1, ''], [MB1, 'Could not save the Gmail sync.'], [MB2, '']]);
  assert.ok(failing.logs.some((l) => l.startsWith('google/outreach-gmail-sync: POST rpc/outreach_gmail_save → 500')));
  gNoTokens(failing);
  // rpc outreach_gmail_known failing: every claimed mailbox gets the error, without reading its connection or Gmail.
  const blind = await gSync({ claim: [MB1, MB2], jobs: { [MB1]: gJob(MB1), [MB2]: gJob(MB2) }, known: () => reply(500, { message: 'boom' }) });
  assert.deepEqual(blind.data, { ok: true, claimed: 2, synced: 0, failed: 2, more: false, pending: 0, since: GSTART });
  assert.deepEqual(blind.saved.map((b) => [b.p_mailbox, b.p_error, b.p_reconnect, b.p_release]), [[MB1, 'Could not read Cortex’s contacts.', false, false], [MB2, 'Could not read Cortex’s contacts.', false, false]]);
  assert.equal(blind.to(`${RPC}/outreach_gmail_job`).length + blind.gmail.length + blind.to(TOKEN_URL).length, 0);
  // An errored mailbox's queue still counts as pending.
  const queued = await gSync({ jobs: { [MB1]: gJob(MB1, { history_id: '8000', pending: ['t1', 't2', 'bad id!'] }) }, history: () => reply(500, {}) });
  assert.deepEqual(pick(queued.data, ['failed', 'pending']), { failed: 1, pending: 2 });
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
