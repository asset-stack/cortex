# Cortex backend: Supabase design (contract)

Cortex runs in one of two modes, chosen at build time:

| Mode | When | Data | Sign-in |
|---|---|---|---|
| **demo** | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` not set (CI, the preview link) | `localStorage`, seeded from `src/data/seed.js` | none; "Viewing as" switcher + Reset |
| **live** | both env vars set (Cloudflare Pages) | Supabase Postgres, realtime | Google, `@assetstackai.com` only |

The UI never talks to Supabase directly. Every screen keeps using `useStore()` → `{ state, actions }`
with the **same state shape** in both modes. In live mode a sync engine turns each state change into
row writes, and realtime row changes from other staff back into state.

```
action ──▶ next state ──flatten()──▶ rows ──diff(prevRows)──▶ ops ──queue/flush──▶ Supabase
                ▲                                                                     │
                └──────────── assemble(rows) ◀── apply row ◀── realtime postgres_changes ┘
```

## 1. State shape (both modes)

```js
{
  version: 1,
  mode: 'demo' | 'live',                 // not persisted; set by the provider
  me: '<user id>',                       // live: auth.uid()
  users: [{ id, name, initials, color, email, role: 'admin'|'member', active: true }],
  org: { businessName, abn, address, email, phone, bankAccountName, bsb, accountNumber,
         paymentTermsDays: 30, invoicePrefix: 'INV-' },
  boards: { projects|admin|marketing: { groups: [{ id, name, color,
            items: [{ id, name, values: { owner, status, ... }, done,
                      updates: [{ id, user, text, ts }], subtasks: [{ id, text, done }] }] }] } },
  deals:   [{ id, name, sector, value, priority, stage, contact /* owner user id */, next, clientId? }],
  clients: [{ id, name, group, status, priority, next, sector, contact /* user id */, team: [userId],
              lastContact /* 'YYYY-MM-DD' | '' */, demo, keyContact, email, demoUrl, avatar,
              abn, billingAddress,
              notes: [{ id, user, text, ts }], tasks: [{ id, text, done }],
              invoices: [{ id, number, issued, due, status, lines: [{ id, desc, qty, rate }] }],
              access: [{ id, name, email, role }] }],
  contacts:  [{ id, name, org, email, stage, status, last }],
  emails:    [{ id, kind, contactId?, contact, subject, snippet, ts }],
  sequences: [{ id, name, steps, enrolled, replyRate }],
  approvals: [{ id, contactId?, contact, subject, body, by, ts }],
  channels:  [{ id, name, members: [userId] }],
  messages:  [{ id, channel, user, text, ts }],
  lastRead:  { [userId]: { [channelId]: isoTs } },   // live: only the current user's map
}
```

Array order is meaningful and is stored as `position` (0-based index) where the table has one.
Ids are `crypto.randomUUID()` for everything created at runtime (both modes). Seed ids are only
ever used in demo mode.

## 2. Tables (`supabase/migrations/0001_cortex.sql`)

All in schema `public`. `id uuid primary key default gen_random_uuid()` unless noted. Every table
also has `updated_at timestamptz not null default now()` and `updated_by uuid default auth.uid()`
maintained by a `touch()` trigger (the sync engine never sends these two columns).

| table | columns (besides id/updated_*) | state source |
|---|---|---|
| `profiles` | `id uuid pk → auth.users on delete cascade`, `email text unique not null`, `name text not null`, `initials text not null`, `color text not null`, `role text not null default 'member' check in ('admin','member')`, `active bool not null default true`, `created_at timestamptz default now()` | `users[]` |
| `admin_emails` | `email text pk` (setup only; not synced) | — |
| `org_settings` | `id int pk default 1 check (id = 1)`, `business_name, abn, address, email, phone, bank_account_name, bsb, account_number, invoice_prefix text not null default ''` (`invoice_prefix` default `'INV-'`), `payment_terms_days int not null default 30` | `org` |
| `board_groups` | `board_key text not null check in ('projects','admin','marketing')`, `name text`, `color text`, `position int` | `boards[k].groups[]` |
| `items` | `board_key text not null`, `group_id uuid not null → board_groups cascade`, `position int`, `name text`, `values jsonb not null default '{}'`, `done bool not null default false` | `groups[].items[]` |
| `item_updates` | `item_id → items cascade`, `user_id uuid → profiles`, `text text`, `created_at timestamptz` | `items[].updates[]` (newest first in state; order by `created_at desc`) |
| `subtasks` | `item_id → items cascade`, `position int`, `text text`, `done bool` | `items[].subtasks[]` |
| `clients` | `name, group_name, status, priority, next_step, sector text`, `contact_id uuid null → profiles`, `team uuid[] not null default '{}'`, `last_contact date null`, `demo, key_contact, email, demo_url, avatar, abn, billing_address text not null default ''`, `position int` | `clients[]` |
| `deals` | `name, sector, priority, stage, next_step text`, `value numeric not null default 0`, `owner_id uuid null → profiles`, `client_id uuid null → clients on delete set null`, `position int` | `deals[]` |
| `client_notes` | `client_id → clients cascade`, `user_id → profiles`, `text text`, `created_at timestamptz` | `clients[].notes[]` (newest first) |
| `client_tasks` | `client_id cascade`, `position int`, `text text`, `done bool` | `clients[].tasks[]` |
| `invoices` | `client_id cascade`, `number text not null unique`, `issued date`, `due date`, `status text`, `position int` | `clients[].invoices[]` |
| `invoice_lines` | `invoice_id → invoices cascade`, `position int`, `description text`, `qty text`, `rate text` (kept as typed, e.g. `'1,000'`) | `invoices[].lines[]` |
| `client_access` | `client_id cascade`, `position int`, `name, email, role text` | `clients[].access[]` |
| `contacts` | `name, org, email, stage, status text`, `last_at timestamptz`, `position int` | `contacts[]` |
| `emails` | `kind text`, `contact_id uuid null → contacts on delete set null`, `contact text`, `subject text`, `snippet text`, `ts timestamptz` | `emails[]` (newest first) |
| `sequences` | `name text`, `steps int`, `enrolled int`, `reply_rate numeric`, `position int` | `sequences[]` |
| `approvals` | `contact_id uuid null → contacts on delete set null`, `contact text`, `subject text`, `body text`, `by_id uuid → profiles`, `ts timestamptz` | `approvals[]` (newest first) |
| `channels` | `name text not null unique`, `created_by uuid not null default auth.uid()` | `channels[]` |
| `channel_members` | **pk (`channel_id → channels cascade`, `user_id → profiles cascade`)**, no `id` | `channels[].members[]` |
| `messages` | `channel_id → channels cascade`, `user_id → profiles`, `text text`, `ts timestamptz not null default now()` | `messages[]` (oldest first) |
| `read_state` | **pk (`user_id → profiles cascade`, `channel_id → channels cascade`)**, `last_read_at timestamptz`, no `id` | `lastRead[me]` |

Text columns default to `''` and are `not null` unless noted, so the state never sees `null` for text.
`date` columns map `''` ⇄ `null`. Timestamps are normalised to `new Date(x).toISOString()` on the way in.

### Security (RLS on every table)
- `public.is_staff()`: `security definer`, true when `auth.uid()` has an **active** profile whose email
  ends in `@assetstackai.com`. `public.is_admin()`: `is_staff()` and `role = 'admin'`.
  `public.is_member(channel uuid)`: current user is in `channel_members` for it.
- Default for business tables (boards, items, clients, deals, invoices, contacts, …): `select/insert/update/delete` to `authenticated` **using/with check `is_staff()`**.
- `profiles`: select `is_staff()`; update: `is_admin()` or own row. A `protect_profile` trigger stops non-admins changing `role`, `active` or `email`. No insert/delete policy (rows come from the signup trigger).
- `org_settings`: select `is_staff()`; update `is_admin()`; no insert/delete (seeded row id 1).
- `channels`: select when `is_member(id)` or `created_by = auth.uid()`; insert with `created_by = auth.uid()` and `is_staff()`; update/delete `is_admin()` or creator.
- `channel_members`: select when `is_staff()` and (`user_id = auth.uid()` or `is_member(channel_id)`); insert when `is_staff()` and (`is_member(channel_id)` or the caller created the channel); delete own row or `is_admin()`.
- `messages`: select `is_member(channel_id)`; insert `is_member(channel_id)` and `user_id = auth.uid()`; update/delete own.
- `item_updates`, `client_notes`: select `is_staff()`; insert `user_id = auth.uid()`; update/delete own or admin.
- `read_state`: all operations only where `user_id = auth.uid()`.
- `admin_emails`: no policies (not readable by clients).

### Triggers / setup
- `handle_new_user` (after insert on `auth.users`, `security definer`): **raises an exception** when the email domain is not `assetstackai.com` (blocks the sign-up); otherwise inserts the profile (name from `raw_user_meta_data->>'full_name'` or the email's local part, two-letter initials, a colour from a fixed palette by hash, `role = 'admin'` when the email is in `admin_emails`) and adds the user to the `general` channel.
- `touch()` on every table; `protect_profile` on `profiles`.
- Seed (empty start): `org_settings` row 1; board groups `projects`: Active, Backlog · `admin`: To do · `marketing`: This month; channel `general`.
- `alter publication supabase_realtime add table …` for every synced table.
- `supabase/setup-admins.sql`: `insert into public.admin_emails (email) values ('you@assetstackai.com') on conflict do nothing;` plus an `update profiles set role='admin' where email in (...)` for people who already signed in.

## 3. Sync engine (`src/data/backend/`)

- `client.js`: `export const LIVE` (both env vars present), `export const supabase` (null in demo),
  `export const ALLOWED_DOMAIN = 'assetstackai.com'`. Client created with `auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: true }`
  (PKCE so the OAuth return uses `?code=` and doesn't collide with the `#/route` hash router).
- `schema.js` (pure, no Supabase import):
  - `TABLES`: ordered parent → child, each `{ name, key: (row) => string, onConflict? }`
    (`channel_members` key `channel_id:user_id`, `read_state` key `user_id:channel_id`).
  - `flatten(state) → { [table]: Map<key, row> }`: DB-column rows, snake_case, `''`→`null` for dates/uuid fks, positions from array index. `read_state` only for `state.me`. Never emits `updated_at/updated_by`.
  - `assemble(rowsByTable, { me }) → state fields` (everything except `version/mode/me`). Must satisfy **`flatten(assemble(flatten(s)))` deep-equals `flatten(s)`** for any valid state.
  - `diff(prev, next) → ops[]`: `{ table, op: 'upsert'|'delete', key, row }` comparing rows by `JSON.stringify` with sorted keys.
- `sync.js`: `createSync({ supabase, onStatus })` →
  - `queue(ops)`: coalesce by `table+key` (last write wins, delete beats upsert), flush 400 ms after the last change.
  - flush: upserts grouped per table in `TABLES` order (parents first), deletes in reverse order (children first); composite tables use `onConflict`. On error: `onStatus({ state: 'error', message })`, keep the failed ops queued and retry with backoff (2 s, 5 s, 10 s, max 30 s).
  - `isPending(table, key)`.
  - `loadAll() → rowsByTable` (one `select *` per table).
  - `subscribe(onChange)` one realtime channel, `postgres_changes` `*` on every table; calls `onChange({ table, eventType, row /* new or old */ })`.
  - `onStatus` states: `'saved' | 'saving' | 'error' | 'offline'`.

## 4. Store (`src/data/store.jsx`)

- `mutate(fn)` runs **synchronously against a `stateRef`** (not inside a `setState` updater), so every action's logic runs once. Demo mode then saves to `localStorage` as today; live mode additionally does `ops = diff(rowsRef, flatten(next))`, `rowsRef = flatten(next)`, `sync.queue(ops)`.
- Live realtime change: skip if `sync.isPending(table, key)`; otherwise apply to `rowsRef` (upsert/delete), `setState({ ...assemble(rowsRef, { me }), version: 1, mode: 'live', me })`.
- New actions (both modes): `updateProfile(userId, patch)`, `updateOrg(patch)`,
  `importRecords(kind, records, options) → { added, skipped }` with `kind` in `'clients' | 'contacts' | 'deals' | 'tasks'`
  (records already normalised to state shape by `src/lib/importers.js`; `options = { board, groupId, groupName }` for tasks; skips names that already exist, case-insensitive),
  `signOut()` (live).
- `setMe` and `reset` are demo-only (no-ops in live).
- Extra context value `sync: { state, message }` for a small status indicator.

## 5. Auth (`src/components/auth/AuthGate.jsx`)
Live mode only (demo renders children directly). States: loading → signed out (Cortex card, **Sign in with Google**, note "Use your @assetstackai.com account") → signed in but no active profile ("Your account isn't active yet. Ask an admin.", Sign out) → app.
`signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { hd: 'assetstackai.com', prompt: 'select_account' } } })`.
Domain-rejected sign-ups come back with an error in the URL; show "Only @assetstackai.com Google accounts can sign in."
