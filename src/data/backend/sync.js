// Live-mode sync engine (docs/BACKEND.md §3). The store queues row ops from diff(); this writes them to
// Supabase in FK-safe order, retries with backoff, and streams other people's changes back over realtime.
// Takes the client as an argument (no client.js import) so scripts/test-sync.mjs can drive it with a fake.
import { TABLES, normalizeRow, stable } from './schema.js';

const DEBOUNCE_MS = 400;
const BACKOFF_MS = [2000, 5000, 10000, 30000];
const GIVE_UP = 3; // times the database may refuse a row before it is dropped and handed back to the store
const ECHO_TTL_MS = 30000; // how long a write of ours waits for its realtime echo
const PAGE = 1000; // PostgREST's default max rows per request
const CHUNK = 100; // ids per delete request, keeps URLs short

const pkOf = (table) => (table.onConflict ? table.onConflict.split(',') : ['id']);
// Errors about a row's data rather than the request (bad value, constraint, refused by RLS).
const rowError = (err) => !err.offline && /^(22|23)|^42501$/.test(err.code || '');
// The tables each one nests under (parent chain): deleting a row there cascades into this table.
const LATER = Object.fromEntries(TABLES.filter((t) => t.later).map((t) => [t.name, t.later]));
const ANCESTORS = Object.fromEntries(TABLES.map((t) => {
  const out = [];
  for (let p = t.parent?.[0]; p; p = TABLES.find((x) => x.name === p)?.parent?.[0]) out.push(p);
  return [t.name, out];
}));
const opId = (table, key) => `${table}|${key}`;
// The columns a foreign-key error (23503) is about: PostgREST's details say "Key (plan_id)=(…) is not present in
// table …"; without them, the default constraint name <table>_<column>_fkey. [] when neither says.
function fkColumns(table, err) {
  const key = /Key \(([^)]*)\)=/.exec(err.details || '')?.[1];
  if (key) return key.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const name = new RegExp(`"${table}_(\\w+)_fkey"`).exec(err.message || '')?.[1];
  return name ? [name] : [];
}
// PostgREST's "no such table" (its schema cache doesn't have it; Postgres's own code before PostgREST checked).
const notFound = (err) => /^(PGRST205|42P01)$/.test(err?.code || '')
  || /could not find the table|relation "[^"]*" does not exist/i.test(err?.message || '');
// Last write wins, except a later upsert never brings back a deleted row.
const coalesce = (older, newer) => (older?.op === 'delete' && newer.op === 'upsert' ? older : newer);
const listOf = (m, k) => { if (!m.has(k)) m.set(k, []); return m.get(k); };
// What the realtime echo of a write carries, in comparable form: the canonical row, or 'delete'.
const sigOf = (table, row) => (row ? stable(normalizeRow(table, row)) : 'delete');

export function createSync({ supabase, onStatus = () => {}, onRealtime = () => {}, onRejected = () => {} }) {
  const queued = new Map(); // opId → op, waiting for the next flush
  const sending = new Map(); // opId → op, in flight
  const tries = new Map(); // opId → times the database refused that row so far
  const unechoed = new Map(); // opId → [{ sig, at }], oldest first: our writes whose realtime echo hasn't arrived
  let timer = null;
  let retryTimer = null;
  let attempt = 0;
  let running = null;
  let again = false;
  let failure = null; // { state: 'error' | 'offline', message } until a flush succeeds
  let notice = null; // { state: 'error', message } after a row was given up, until the next change
  let realtimeDown = false;
  let disposed = false; // set by dispose(): nothing new is scheduled, so a stopped engine stops writing
  let reported = '';
  const missing = new Set(); // `since` tables the database doesn't have yet (their migration hasn't run)

  function report() {
    const next = failure
      || (queued.size || sending.size ? { state: 'saving' } : realtimeDown ? { state: 'offline' } : notice || { state: 'saved' });
    const sig = `${next.state}|${next.message || ''}`;
    if (sig !== reported) { reported = sig; onStatus(next); }
  }

  // A column a migration adds to an existing table (TABLES `later`) is left out of writes until that migration's new
  // table is there, so an app released before its migration still saves the rest of the row.
  const withoutLater = (op) => {
    const drop = (LATER[op.table] || []).filter((l) => missing.has(l.table)).flatMap((l) => l.columns);
    if (!drop.length || !op.row) return op;
    const row = { ...op.row };
    drop.forEach((c) => { delete row[c]; });
    return { ...op, row };
  };

  function queue(ops) {
    ops = ops?.filter((op) => !missing.has(op.table)).map(withoutLater); // a table that isn't there takes no writes
    if (!ops?.length || disposed) return;
    ops.forEach((op) => {
      const id = opId(op.table, op.key);
      queued.set(id, coalesce(queued.get(id), op));
      tries.delete(id); // a new version of the row gets its own tries
    });
    notice = null;
    // Offline, the scheduled retry picks these up. Otherwise a row that keeps failing mustn't hold them back.
    if (!retryTimer || failure?.state !== 'offline') {
      clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    }
    report();
  }

  const isPending = (table, key) => queued.has(opId(table, key)) || sending.has(opId(table, key));
  const hasPending = () => queued.size > 0 || sending.size > 0;

  // Sends everything queued now; resolves when done (or failed and scheduled for retry).
  function flush() {
    if (running) { again = true; return running; }
    if (disposed) return Promise.resolve();
    clearTimeout(timer); timer = null;
    running = (async () => {
      // Another flush() asked for during the write sends what was queued meanwhile, unless we're offline.
      do {
        again = false;
        clearTimeout(retryTimer); retryTimer = null;
        await sendQueued();
      } while (again && queued.size && (!retryTimer || failure?.state !== 'offline'));
    })().finally(() => { running = null; });
    return running;
  }

  async function sendQueued() {
    if (!queued.size) { report(); return; }
    const batch = [...queued.values()];
    queued.clear();
    batch.forEach((op) => sending.set(opId(op.table, op.key), op));
    report();
    const { failed, dropped } = await write(batch);
    sending.clear();
    const failedOps = new Set(failed.map((f) => f.op));
    batch.forEach((op) => { if (!failedOps.has(op)) tries.delete(opId(op.table, op.key)); });
    remember(batch.filter((op) => !failedOps.has(op) && !dropped.includes(op)));

    // Keep failed ops unless a newer change to the same row arrived meanwhile. A row the database keeps refusing
    // (a name taken by a group you can't see, a duplicate invoice number) is given up and handed to the store.
    const rejected = [];
    let error = null;
    let retry = false;
    failed.forEach(({ op, err, waiting }) => {
      const id = opId(op.table, op.key);
      const newer = queued.get(id);
      if (!newer && err && rowError(err) && !waiting) {
        const n = (tries.get(id) || 0) + 1;
        tries.set(id, n);
        if (n >= GIVE_UP) { tries.delete(id); rejected.push({ ...op, error: err }); return; }
      }
      queued.set(id, newer ? coalesce(op, newer) : op);
      error ||= err;
      retry = true;
    });
    if (error) failure = { state: error.offline ? 'offline' : 'error', message: error.message };
    else { attempt = 0; failure = null; }
    if (rejected.length) {
      notice = { state: 'error', message: rejected[0].error.message };
      onRejected(rejected); // the store puts those rows back as the database has them
    }
    // Deletes held back for a row that was then given up have nothing left to wait for.
    if (retry && !disposed) retryTimer = setTimeout(flush, error ? BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)] : DEBOUNCE_MS);
    report();
  }

  // Runs a request; a thrown error or { error } becomes { message, code, details, offline }.
  async function attemptRequest(fn) {
    try {
      const res = (await fn()) || {};
      if (!res.error) return null;
      const offline = res.status === 0 || (typeof navigator !== 'undefined' && navigator.onLine === false);
      return { message: res.error.message || 'Save failed', code: res.error.code, details: res.error.details || '', offline };
    } catch (e) {
      return { message: e?.message || 'Save failed', offline: typeof navigator !== 'undefined' && navigator.onLine === false };
    }
  }

  // → { failed: [{ op, err, waiting }] (err is null for a delete held back), dropped: [op] }
  async function write(batch) {
    const upserts = new Map();
    const deletes = new Map();
    batch.forEach((op) => listOf(op.op === 'delete' ? deletes : upserts, op.table).push(op));
    const failed = [];
    const dropped = [];
    const refused = new Set(); // opIds of upserts refused in this batch
    const held = new Set(); // tables whose deletes wait for the retry

    // Parents first, so a child never points at a row that isn't there yet.
    for (const table of TABLES) {
      const ops = upserts.get(table.name);
      if (!ops) continue;
      const err = await attemptRequest(() => upsertRows(table, ops.map((o) => o.row)));
      if (!err) continue;
      // One bad row (a channel name taken by a group you can't see) fails the whole request: send the rows one
      // at a time so the rest still save and only the bad one keeps retrying.
      let rejected = [[ops, err]];
      if (ops.length > 1 && rowError(err)) {
        rejected = [];
        for (const op of ops) {
          const e = await attemptRequest(() => upsertRows(table, [op.row]));
          if (e) rejected.push([[op], e]);
        }
      }
      const [parent, col] = table.parent || [];
      const writing = (id) => Boolean(id) && (refused.has(id) || queued.has(id));
      rejected.forEach(([list, e]) => list.forEach((op) => {
        const fk = e.code === '23503' ? fkColumns(table.name, e).filter((c) => c in op.row) : [];
        // A missing parent this client isn't still writing was deleted by someone else, and the cascade took this
        // row with it: the write can never succeed, so drop it instead of retrying (and holding deletes) forever.
        const parentId = parent && (!fk.length || fk.includes(col)) && opId(parent, String(op.row[col]));
        // A link the database clears on delete (a billing plan, a routine) points at a row deleted elsewhere: the
        // database set it null on the saved row, so this write goes again with it null too.
        const link = fk.length === 1 && table.setNull?.[fk[0]] && op.row[fk[0]] ? fk[0] : '';
        const linkId = link && opId(table.setNull[link], String(op.row[link]));
        const waiting = e.code === '23503' && (writing(parentId) || writing(linkId));
        if (e.code === '23503' && parentId && !waiting) { dropped.push(op); return; }
        refused.add(opId(table.name, op.key));
        if (linkId && !waiting) {
          op.row = { ...op.row, [link]: null };
          failed.push({ op, err: null }); // sent again on the next flush, not counted as a refusal
        } else {
          failed.push({ op, err: e, waiting });
        }
        // The failed row may be moving to a new parent, and deleting its old parent now would cascade it away.
        // A unique clash (23505) is the exception: a delete in this batch may be what frees the value.
        if (e.code !== '23505') ANCESTORS[table.name].forEach((name) => held.add(name));
      }));
    }

    // Children first, then parents.
    for (const table of [...TABLES].reverse()) {
      const ops = deletes.get(table.name);
      if (!ops || table.update) continue; // profiles / org_settings are never deleted from here
      if (held.has(table.name)) { ops.forEach((op) => failed.push({ op, err: null })); continue; }
      const err = await attemptRequest(() => deleteRows(table, ops.map((o) => o.row)));
      if (err) ops.forEach((op) => failed.push({ op, err }));
    }
    return { failed, dropped };
  }

  async function upsertRows(table, rows) {
    if (table.update) {
      for (const { id, ...patch } of rows) {
        const res = await supabase.from(table.name).update(patch).eq('id', id);
        if (res.error) return res;
      }
      return {};
    }
    const options = table.onConflict ? { onConflict: table.onConflict, ignoreDuplicates: Boolean(table.ignoreDuplicates) } : undefined;
    return supabase.from(table.name).upsert(rows, options);
  }

  // Single key: `in` over chunks of ids. Composite key: one request per first-column value.
  async function deleteRows(table, rows) {
    const [a, b] = pkOf(table);
    const groups = new Map();
    rows.forEach((r) => listOf(groups, b ? r[a] : '').push(b ? r[b] : r[a]));
    for (const [first, values] of groups) {
      for (let i = 0; i < values.length; i += CHUNK) {
        let q = supabase.from(table.name).delete();
        if (b) q = q.eq(a, first);
        const res = await q.in(b || a, values.slice(i, i + CHUNK));
        if (res.error) return res;
      }
    }
    return {};
  }

  // Writes that went through, so their realtime echoes can be recognised (staleEcho). Entries whose echo never
  // came (a membership that already existed, a row RLS hides from us) expire.
  function remember(ops) {
    const now = Date.now();
    unechoed.forEach((list, id) => {
      const live = list.filter((e) => now - e.at < ECHO_TTL_MS);
      if (live.length) unechoed.set(id, live); else unechoed.delete(id);
    });
    ops.forEach((op) => listOf(unechoed, opId(op.table, op.key)).push({ sig: sigOf(op.table, op.op === 'delete' ? null : op.row), at: now }));
  }

  // True when a realtime change (row, or null for a delete) is the echo of one of our writes that a newer write
  // of ours has replaced since: applying it would undo the newer edit. Echoes arrive in commit order, so the
  // matching entry and any older ones (whose echoes never came) are used up.
  function staleEcho(table, key, row) {
    const id = opId(table, key);
    const list = unechoed.get(id);
    if (!list) return false;
    const sig = sigOf(table, row);
    const now = Date.now();
    const i = list.findIndex((e) => e.sig === sig && now - e.at < ECHO_TTL_MS);
    if (i < 0) return false; // someone else's change
    list.splice(0, i + 1);
    if (!list.length) unechoed.delete(id);
    return list.length > 0;
  }

  // Which tables with a `since` migration the database doesn't have yet. Those are left out of the subscription, the
  // load and every write, so a release that gets ahead of its migration loses that feature, not the workspace. Run
  // before subscribe(). Any other error is left to loadAll. → the missing table names
  async function probe() {
    await Promise.all(TABLES.filter((t) => t.since).map(async (table) => {
      let error = null;
      try { ({ error } = (await supabase.from(table.name).select(pkOf(table)[0]).range(0, 0)) || {}); } catch { /* loadAll says */ }
      if (notFound(error)) missing.add(table.name); else missing.delete(table.name);
    }));
    return [...missing];
  }

  // One `select *` per table (paged past PostgREST's row cap) → { [table]: Map<key, row> }, rows normalised. A `since`
  // table that isn't there (yet) loads as no rows; any other failure fails the load.
  async function loadAll() {
    const entries = await Promise.all(TABLES.map(async (table) => {
      const rows = new Map();
      for (let from = 0; !missing.has(table.name);) {
        let q = supabase.from(table.name).select('*', { count: 'exact' });
        pkOf(table).forEach((col) => { q = q.order(col); });
        const { data, error, count } = await q.range(from, from + PAGE - 1);
        if (error && table.since && notFound(error)) { missing.add(table.name); rows.clear(); break; }
        if (error) throw new Error(`Loading ${table.name} failed: ${error.message}`);
        data.forEach((raw) => { const row = normalizeRow(table.name, raw); rows.set(table.key(row), row); });
        from += data.length;
        if (!data.length || from >= (count ?? from)) break;
      }
      return [table.name, rows];
    }));
    return Object.fromEntries(entries);
  }

  // One realtime channel for every synced table. Deletes carry only the primary key, so `row` is the old
  // record as sent; inserts and updates are normalised like loadAll rows. The topic is unique per call so a
  // quick unsubscribe/resubscribe (React StrictMode) never reuses a channel that is still closing.
  // `wait` holds SUBSCRIBED until changes are actually streaming, so a reload after it misses nothing.
  function subscribe(onChange) {
    const channel = supabase.channel(`cortex-sync-${Math.random().toString(36).slice(2, 10)}`, {
      config: { postgres_changes_options: { wait: true } },
    });
    TABLES.filter((table) => !missing.has(table.name)).forEach((table) => channel.on('postgres_changes', { event: '*', schema: 'public', table: table.name }, (p) => {
      const row = p.eventType === 'DELETE' ? p.old : normalizeRow(table.name, p.new);
      onChange({ table: table.name, eventType: p.eventType, key: table.key(row), row });
    }));
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') realtimeDown = false;
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') realtimeDown = true;
      onRealtime(status);
      report();
    });
    return () => { realtimeDown = false; supabase.removeChannel(channel); };
  }

  // Back online: retry now instead of waiting out the backoff.
  const onOnline = () => { if (queued.size) { attempt = 0; flush(); } };
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);

  function dispose() {
    disposed = true;
    clearTimeout(timer); timer = null;
    clearTimeout(retryTimer); retryTimer = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
  }

  return { queue, flush, isPending, hasPending, staleEcho, probe, missing: () => [...missing], loadAll, subscribe, dispose };
}
