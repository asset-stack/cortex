// Checks the google Edge Function (supabase/functions/google/index.ts) without a network: node scripts/test-google.mjs
// The function is plain JavaScript in a .ts file (so it can be pasted into the Supabase dashboard); a load hook hands it
// to Node as an ES module. PostgREST and Google are a fake fetch that answers per URL and records every call.
// Covers CORS, the caller check, connect / callback (signed state, your own account only), send (validation and the
// MIME message Gmail gets) and contract (Drive copy, .docx conversion, placeholders). Exits non-zero when any check fails.
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
    ['wrong_account', exchange(token({ id_token: idToken({ email: 'someone@example.com' }) }))],
    ['wrong_account', exchange(token({ id_token: idToken({ email_verified: false }) }))],
    ['wrong_account', exchange(token({ id_token: undefined }))],
    ['no_refresh_token', exchange(token({ refresh_token: undefined }))],
    ['save', { [`${RPC}/google_save`]: () => reply(500, { message: 'boom' }) }],
  ];
  for (const [reason, routes] of cases) {
    const r = await callback(state, { routes });
    assert.equal(r.status, 302, reason);
    assert.equal(r.headers.get('location'), settings(`error&reason=${reason}`));
    if (reason !== 'save') assert.equal(r.to(`${RPC}/google_save`).length, 0, `${reason}: nothing saved`);
  }
  const noCode = await callback(state, { query: `?state=${encodeURIComponent(state)}` });
  assert.equal(noCode.headers.get('location'), settings('error&reason=exchange'));
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

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
