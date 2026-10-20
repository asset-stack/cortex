# Cortex backend: Supabase design (contract)

## Phase 2: team workflow

The full contract is [`docs/PHASE2.md`](PHASE2.md); migration `supabase/migrations/0002_team_workflow.sql` runs
once on top of `0001` (applied in production, never edited), `0003_timezones_projects_view.sql` on top of `0002`
([PHASE2.md §8](PHASE2.md#8-0003-time-zones-and-projects-view-only)), `0004_clients_google.sql` on top of `0003`
([PHASE2.md §9](PHASE2.md#9-0004-client-contacts-contracts-credits-and-google-invoice-email-contract-docs): client
contacts and contracts, credits, the admins' Google accounts and the `google` Edge Function), `0005_work_tools.sql`
([PHASE2.md §10](PHASE2.md#10-0005-each-persons-tools-in-my-work): each person's Tools), `0006_boards.sql`
([PHASE2.md §11](PHASE2.md#11-0006-boards-under-projects-and-marketing): boards under Projects and Marketing, each
person's own Projects page) and `0007_outreach.sql`
([PHASE2.md §12](PHASE2.md#12-0007-outreach--cold-email-per-mailbox-synced-with-the-agents-sheet): Outreach, the
cold email the agent sends from each mailbox, read from its Google Sheet; and
[§13](PHASE2.md#13-0007-boards-under-outreach-and-clients): boards under Outreach and Clients). The rest of this file is phase 1,
corrected where 0002–0007 changed it.

- **Roles**: `superadmin | admin | staff` (phase 1's `member` became `staff`). Admins (superadmin or admin) edit
  every module and see finance; only the SuperAdmin changes roles, active flags and module access, and the last
  active SuperAdmin can't be demoted or deactivated. `admin_emails.role` sets the role at sign-up (else staff).
- **Module access**: modules `projects`, `marketing`, `outreach`, `pipeline`, `clients`, each `none | view | edit`.
  Admins always edit; staff get a `module_access` override or the default (projects and marketing edit, pipeline
  and clients view, outreach none; projects was view from 0003 until 0006). One rule set on each side: SQL
  `module_level` / `can_view` / `can_edit` (every module table's RLS), JS `src/lib/access.js` (`useAccess()`; nav,
  read-only screens, store actions).
  My Work, team chat and the timesheet are always available; Settings is admins only.
- **Boards**: the Admin board merged into **Projects** (`board_key in ('projects','marketing')`; the seeded
  *To do* group became *Admin*). `items.values.people` (user ids) replaced `values.owner`. Since 0006 each module holds
  several boards (`boards` table): team boards (admins add, rename, order and delete them) and one personal Projects
  page per person (the SuperAdmin sees everyone's, an admin their own and staff's, staff their own). Groups and items
  carry `board_id`, and their RLS follows the board (`board_level` / `can_view_board` / `can_edit_board`).
- **New tables** (all synced, RLS on, in realtime): `module_access`, `routines`, `todos`, `billing_plans`,
  `client_usage`, `bank_statements`, `payments`, `expenses`, `subscriptions`, `time_entries`. Bank statements,
  payments, expenses and subscriptions are admins only; todos and time entries are your own (admins see all).
  `routine_runs` (not synced, no policies) is `ensure_todos`' run log.
- **New columns**: `contacts.owner_id`, `deals.contact_id`, `invoices.plan_id / sent_at / paid_on`;
  `billing_plans.anchor_day` (synced) and `billed_periods` (the database's own).
- **Automation**: RPCs `ensure_todos(day)` (daily routines, Monday bank-screenshot reminder) and
  `generate_due_invoices()` (admins); trigger `contact_pipeline` (Replied / Meeting booked → deal + follow-up
  to-do); triggers `protect_invoice_status` / `protect_invoice_insert` (only admins approve, send, void or mark
  paid). Business dates (invoices) use `team_today()`, Sydney's day (0003; was Perth); a follow-up to-do lands on
  its owner's own day, `user_today(owner)` from `profiles.timezone` (0003). Demo mode runs the same rules in
  `src/lib/automations.js`.
- **Outreach** (0007): `outreach_mailboxes`, `outreach_notes` and `outreach_settings` (the sheet's link) are synced
  and in realtime; `outreach_emails` is **server-written**: only the `google` function's `outreach-sync` route writes
  it (secret key), from the agent's Google Sheet, and the app reads it on demand through `useStore().outreach` (§4),
  never in synced state. Everything is read with Outreach view; mailboxes and the link are written by admins, notes
  with Outreach edit.
- **Storage**: private bucket `finance` (bank screenshots, receipts), admins only.
- **Demo team**: David (superadmin), Josh (admin), Hello (staff), all `@example.com`.

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
  users: [{ id, name, initials, color, email, role: 'superadmin'|'admin'|'staff', active: true }],
  org: { businessName, abn, address, email, phone, bankAccountName, bsb, accountNumber,
         paymentTermsDays: 30, invoicePrefix: 'INV-' },
  // 0006: an array (was { projects|marketing: { groups } }). Projects, Marketing, Outreach, then Clients; personal boards first (by
  // owner's name), then team boards in order. A personal board has name '' and owner set (title from boardTitle()).
  boards: [{ id, module: 'projects'|'marketing'|'outreach'|'clients' /* 0007 adds the last two */, name, owner /* '' | userId */,
             groups: [{ id, name, color,
               items: [{ id, name, values: { people /* [userId] */, status, ... }, done,
                         updates: [{ id, user, text, ts }], subtasks: [{ id, text, done }] }] }] }],
  deals:   [{ id, name, sector, value, priority, stage, contact /* owner user id */, next, clientId?, contactId }],
  clients: [{ id, name, group, status, priority, next, sector, contact /* user id */, team: [userId],
              lastContact /* 'YYYY-MM-DD' | '' */, demo, demoUrl, platformUrl /* 0004 */, avatar,
              abn, billingAddress,
              // 0004 (replaces keyContact / email): the client's people; invoices go to billing ones
              contacts: [{ id, name, role, email, phone, billing }],
              contracts: [{ id, status, title, docId, docUrl, startDate, endDate, annualFee, paymentTerms, userLimit,
                            platform, customisations, mobileApp, governingLaw, createdBy, sentBy, sentAt, signedAt }],
              notes: [{ id, user, text, ts }], tasks: [{ id, text, done }],
              invoices: [{ id, number, issued, due, status, planId, sentAt, paidOn, sentTo, lines: [{ id, desc, qty, rate }] }],
              access: [{ id, name, email, role }] }],
  contacts:  [{ id, name, org, email, stage, status, last, owner /* user id | '' */ }],
  emails:    [{ id, kind, contactId?, contact, subject, snippet, ts }],
  sequences: [{ id, name, steps, enrolled, replyRate }],
  approvals: [{ id, contactId?, contact, subject, body, by, ts }],
  channels:  [{ id, name, members: [userId] }],
  messages:  [{ id, channel, user, text, ts }],
  lastRead:  { [userId]: { [channelId]: isoTs } },   // live: only the current user's map
  // 0005: tools: [{ id, user, name, url, username, how, notes, createdBy }]  (each person's logins and links)
  // 0007 (docs/PHASE2.md §12): Outreach. contacts stay (the Pipeline automation); emails, sequences and approvals
  // are no longer shown in the UI but are still synced.
  mailboxes:     [{ id, name, addresses /* [lower-case address] */, owner /* userId | '' */, active }],  // in order
  outreachNotes: [{ id, mailbox /* '' = all mailboxes */, pinned, body, author, createdAt }],        // newest first
  outreachSheet: '<the sheet link>',   // absent in live mode for someone without Outreach access
  outreachEmails: [ … ],               // demo only; live mode reads outreach_emails through useStore().outreach
  // phase 2: moduleAccess, todos, routines, payments, bankStatements, expenses, subscriptions, timeEntries,
  // clients[].plans and clients[].usage (docs/PHASE2.md §2)
}
```

Array order is meaningful and is stored as `position` (0-based index) where the table has one. Clients,
contacts, a client's invoices and expenses are added at the top, so their positions count from the end
(`length - 1 - index`) and adding one leaves the other rows untouched. To-dos and time entries are numbered
within one person's day.
Ids are `crypto.randomUUID()` for everything created at runtime (both modes). Seed ids are only
ever used in demo mode.

## 2. Tables (`supabase/migrations/0001_cortex.sql`)

All in schema `public`. `id uuid primary key default gen_random_uuid()` unless noted. Every table
also has `updated_at timestamptz not null default now()` and `updated_by uuid default auth.uid()`
maintained by a `touch()` trigger (the sync engine never sends these two columns).

| table | columns (besides id/updated_*) | state source |
|---|---|---|
| `profiles` | `id uuid pk → auth.users on delete cascade`, `email text unique not null`, `name text not null`, `initials text not null`, `color text not null`, `role text not null default 'staff' check in ('superadmin','admin','staff')` (0002; was `'member'`, `('admin','member')`), `active bool not null default true`, `created_at timestamptz default now()`, `timezone text not null default 'Australia/Sydney'` (0003; a real IANA name, checked by a trigger) | `users[]` |
| `admin_emails` | `email text pk`, `role text not null default 'admin' check in ('superadmin','admin')` (0002) (setup only; not synced) | — |
| `org_settings` | `id int pk default 1 check (id = 1)`, `business_name, abn, address, email, phone, bank_account_name, bsb, account_number, invoice_prefix text not null default ''` (`invoice_prefix` default `'INV-'`), `payment_terms_days int not null default 30` | `org` |
| `boards` (0006) | `module text not null check in ('projects','marketing')` (0007: also `'outreach'`, `'clients'`), `name text` (`''` for a personal board), `owner_id uuid null → profiles cascade` (a personal board: one per person, Projects only), `position int` (team boards within their module; personal boards 0) | `boards[]` |
| `board_groups` | `board_key text not null check in ('projects','marketing')` (0007: also `'outreach'`, `'clients'`; `items.board_key` the same) (0002 merged `admin` into `projects`), `board_id uuid not null` (0006; `(board_id, board_key)` → `boards (id, module)` cascade), `name text`, `color text`, `position int` | `boards[].groups[]` |
| `items` | `board_key text not null`, `board_id uuid not null` (0006; its group's board), `group_id uuid not null → board_groups cascade` (0006: `(group_id, board_id)` → `board_groups (id, board_id)`), `position int`, `name text`, `values jsonb not null default '{}'` (`people`: user ids; 0002 replaced `owner`), `done bool not null default false` | `groups[].items[]` |
| `item_updates` | `item_id → items cascade`, `user_id uuid → profiles`, `text text`, `created_at timestamptz` | `items[].updates[]` (newest first in state; order by `created_at desc`) |
| `subtasks` | `item_id → items cascade`, `position int`, `text text`, `done bool` | `items[].subtasks[]` |
| `clients` | `name, group_name, status, priority, next_step, sector text`, `contact_id uuid null → profiles`, `team uuid[] not null default '{}'`, `last_contact date null`, `demo, key_contact, email, demo_url, avatar, abn, billing_address text not null default ''`, `position int`; 0004: `platform_url text`, and `key_contact` / `email` are no longer synced (moved into `client_contacts`) | `clients[]` |
| `deals` | `name, sector, priority, stage, next_step text`, `value numeric not null default 0`, `owner_id uuid null → profiles`, `client_id uuid null → clients on delete set null`, `contact_id uuid null → contacts on delete set null` (0002), `position int` | `deals[]` |
| `client_notes` | `client_id → clients cascade`, `user_id → profiles`, `text text`, `created_at timestamptz` | `clients[].notes[]` (newest first) |
| `client_tasks` | `client_id cascade`, `position int`, `text text`, `done bool` | `clients[].tasks[]` |
| `invoices` | `client_id cascade`, `number text not null unique`, `issued date`, `due date`, `status text`, `position int`; 0002: `plan_id uuid null → billing_plans on delete set null`, `sent_at timestamptz null`, `paid_on date null` | `clients[].invoices[]` |
| `invoice_lines` | `invoice_id → invoices cascade`, `position int`, `description text`, `qty text`, `rate text` (kept as typed, e.g. `'1,000'`) | `invoices[].lines[]` |
| `client_access` | `client_id cascade`, `position int`, `name, email, role text` | `clients[].access[]` |
| `contacts` | `name, org, email, stage, status text`, `last_at timestamptz`, `owner_id uuid null → profiles on delete set null` (0002), `position int` | `contacts[]` |
| `emails` | `kind text`, `contact_id uuid null → contacts on delete set null`, `contact text`, `subject text`, `snippet text`, `ts timestamptz` | `emails[]` (newest first) |
| `sequences` | `name text`, `steps int`, `enrolled int`, `reply_rate numeric`, `position int` | `sequences[]` |
| `approvals` | `contact_id uuid null → contacts on delete set null`, `contact text`, `subject text`, `body text`, `by_id uuid → profiles`, `ts timestamptz` | `approvals[]` (newest first) |
| `channels` | `name text not null unique`, `created_by uuid not null default auth.uid()` | `channels[]` |
| `channel_members` | **pk (`channel_id → channels cascade`, `user_id → profiles cascade`)**, no `id` | `channels[].members[]` |
| `messages` | `channel_id → channels cascade`, `user_id → profiles`, `text text`, `ts timestamptz not null default now()` | `messages[]` (oldest first) |
| `read_state` | **pk (`user_id → profiles cascade`, `channel_id → channels cascade`)**, `last_read_at timestamptz`, no `id` | `lastRead[me]` |

Text columns default to `''` and are `not null` unless noted, so the state never sees `null` for text.
`date` columns map `''` ⇄ `null`. Timestamps are normalised to `new Date(x).toISOString()` on the way in.
0002 adds `module_access`, `routines`, `todos`, `billing_plans`, `client_usage`, `bank_statements`, `payments`,
`expenses`, `subscriptions` and `time_entries` (columns in `docs/PHASE2.md` §3); `time` columns map `'HH:MM'` ⇄
`null`.

0007 (Outreach; full columns in `docs/PHASE2.md` §12):

| table | columns (besides id/updated_*) | state source |
|---|---|---|
| `outreach_mailboxes` | `name text`, `addresses text[]` (every address the mailbox sends as, lower case), `owner_id uuid null → profiles on delete set null`, `active bool`, `position int` | `mailboxes[]` |
| `outreach_notes` | `mailbox_id uuid null → outreach_mailboxes cascade` (null = all mailboxes), `pinned bool`, `body text`, `author_id → profiles on delete set null`, `created_at timestamptz` | `outreachNotes[]` (newest first) |
| `outreach_settings` | `id int pk default 1 check (id = 1)` (seeded), `sheet_url text`, `sheet_by uuid null → profiles on delete set null` (the admin who last saved the link, the same one included: Use my Google; a trigger sets it); the sync's results `synced_at timestamptz`, `sync_error text`, `sync_stats jsonb` are the function's (a signed-in save can only clear them: the error on any save, all three for a new link) | `outreachSheet` (only `sheet_url`) |
| `outreach_emails` | `row_key text unique`, `mailbox_id uuid null → outreach_mailboxes on delete set null` (null = Unassigned), `sender`, the sheet's fields (`date_logged`, `organisation`, `contact_*`, `status`, `sent_on`, `thread_id`, `bounced`, `reply_status`, `reply_on`, `meeting_on`, …), `in_sheet bool`, `raw jsonb`, `synced_at` | **not synced**: server-written by the sheet sync, read through `useStore().outreach` |

### Security (RLS on every table)
- `public.is_staff()`: `security definer`, true when `auth.uid()` has an **active** profile whose email
  ends in `@assetstackai.com`. `public.is_admin()`: `is_staff()` and `role in ('superadmin','admin')` (0002;
  was `role = 'admin'`). `public.is_superadmin()` (0002): `is_staff()` and `role = 'superadmin'`.
  `public.is_member(channel uuid)`: current user is in `channel_members` for it.
- Module tables (0002; phase 1 used `is_staff()` for all of them): select **`can_view(module)`**, insert/update/delete
  **`can_edit(module)`**. `module_level(m)` is `'edit'` for admins, else the caller's `module_access` override or the
  staff default, and `'none'` unless `is_staff()`. Outreach: `contacts, emails, sequences, approvals`. Pipeline:
  `deals`. Clients: `clients, client_notes, client_tasks, invoices, invoice_lines, client_access, billing_plans,
  client_usage`. Boards (0006; 0002 used the module, `board_key`): `boards` select `can_view(module)` (a personal one
  also `sees_person(owner_id)`), insert/update/delete team boards only and `is_admin()`; `board_groups, items` select
  `can_view_board(board_id)`, write `can_edit_board(board_id)`; `item_updates, subtasks` by their item's board
  (`item_board_id(item_id)`). `board_level(board)` is a team board's module level, or `'edit'` on a personal board
  for whoever `sees_person()` its owner (yourself; staff's for admins; everyone's for the SuperAdmin) while they can
  view Projects (`can_view('projects')`), else `'none'`.
- Outreach (0007): every table select `can_view('outreach')`. `outreach_mailboxes` and `outreach_settings` (update
  only; a trigger keeps everything but `sheet_url` for the function) write `is_admin()`. `outreach_notes` insert as
  yourself with `can_edit('outreach')`, update/delete by the author or an admin with `can_edit('outreach')` (a trigger
  pins the author and date). `outreach_emails`: no write grants or policies for `authenticated`; the `google` function
  writes it with the secret key. RPCs `outreach_daily` / `outreach_breakdown` are `security invoker` (RLS applies),
  `outreach_access()` tells the function whether the caller may view or edit Outreach.
- Finance (0002): `bank_statements, payments, expenses, subscriptions` and the `finance` storage bucket: `is_admin()` only.
  `todos`: select/insert/update own (`assignee_id`) or admin, delete creator or admin. `time_entries`: write own only,
  select own or admin. `routines`: select `is_staff()`, write admin. `module_access`: select own or admin, write
  `is_superadmin()`.
- `profiles`: select `is_staff()`; update: `is_admin()` or own row. A `protect_profile` trigger stops anyone but a superadmin changing `role`, `active` or `email` (0002; was admins), and refuses to demote or deactivate the last active superadmin (even from the SQL editor, where the other checks are skipped). No insert/delete policy (rows come from the signup trigger).
- `org_settings`: select `is_staff()`; update `is_admin()`; no insert/delete (seeded row id 1).
- Upserts are checked against insert policies even when the row exists, so `profiles` (own row or admin) and `org_settings` (admin) carry narrow upsert-only policies that resolve to the update path; they never allow a row the rules above forbid. The sync engine writes `profiles` / `org_settings` with plain updates anyway. `channel_members` has no update policy: the sync engine upserts it with `ignoreDuplicates` (on conflict do nothing), and an update could otherwise move someone else's membership.
- `channels`: select when `is_member(id)` or `created_by = auth.uid()`; insert with `created_by = auth.uid()` and `is_staff()`; update/delete `is_admin()` or creator.
- `channel_members`: select when `is_staff()` and (`user_id = auth.uid()` or `is_member(channel_id)` or the caller created the channel); insert when `is_staff()` and (`is_member(channel_id)` or the caller created the channel); delete own row or `is_admin()`. (Select needs the creator clause because PostgREST writes use `RETURNING`: a new channel's memberships go up in one upsert, before the creator counts as a member.)
- `messages`: select `is_member(channel_id)`; insert `is_member(channel_id)` and `user_id = auth.uid()`; update/delete own.
- `item_updates`, `client_notes`: select `can_view` of their module (updates: of their board since 0006); insert `user_id = auth.uid()`; update/delete own or admin; every write also needs `can_edit` of the module (0002; updates: `can_edit_board` since 0006).
- `read_state`: all operations only where `user_id = auth.uid()`.
- `admin_emails`: no policies (not readable by clients).

### Triggers / setup
- `handle_new_user` (after insert on `auth.users`, `security definer`): **raises an exception** when the email domain is not `assetstackai.com` (blocks the sign-up); otherwise inserts the profile (name from `raw_user_meta_data->>'full_name'` or the email's local part, two-letter initials, a colour from a fixed palette by hash, the role listed in `admin_emails`, else `'staff'` (0002)) and adds the user to the `general` channel.
- `touch()` on every table; `protect_profile` on `profiles`. 0002 adds `protect_invoice_status` and `protect_todo`
  (`created_by` can't be forged), `contact_pipeline` on `contacts`, and the RPCs `ensure_todos` / `generate_due_invoices`.
  0007 adds `protect_outreach_note` (a note's author and date), `protect_outreach_settings` (the app changes only the
  sheet's link; `sheet_by` becomes whoever saves it, the same link included, and a save clears the last error) and
  `keep_newer_sync` (an older sync never overwrites a newer one's `outreach_emails` rows).
- Seed (empty start): `org_settings` row 1; board groups `projects`: Active, Backlog · `admin`: To do (0002 moves it to `projects` as *Admin*) · `marketing`: This month; channel `general`. 0006 adds the starting boards and puts the Projects groups on *General*, the Marketing ones on *Posting schedule*; triggers `add_personal_board` (new profiles) and `place_on_board` (fills a missing `board_id`).
- `alter publication supabase_realtime add table …` for every synced table.
- `supabase/setup-admins.sql` (run after 0002): `insert into public.admin_emails (email, role) values ('you@assetstackai.com', 'superadmin'), … on conflict (email) do update set role = excluded.role;` plus updates that promote people who already signed in to their listed role (never demote).

## 3. Sync engine (`src/data/backend/`)

- `client.js`: `export const LIVE` (both env vars present), `export const supabase` (null in demo),
  `export const ALLOWED_DOMAIN = 'assetstackai.com'`. Client created with `auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: true }`
  (PKCE so the OAuth return uses `?code=` and doesn't collide with the `#/route` hash router).
- `schema.js` (pure, no Supabase import):
  - `TABLES`: ordered parent → child, each `{ name, key: (row) => string, onConflict? }`
    (`channel_members` key `channel_id:user_id`, `read_state` key `user_id:channel_id`, `module_access` key
    `user_id:module`). `outreach_emails` is deliberately not in `TABLES` (0007): it is never loaded, diffed or written
    by the sync engine.
  - `flatten(state) → { [table]: Map<key, row> }`: DB-column rows, snake_case, `''`→`null` for dates/uuid fks, positions from array index (from the end for clients, contacts, invoices and expenses; per person and day for todos and time entries). `read_state` only for `state.me`. Never emits `updated_at/updated_by`.
  - `assemble(rowsByTable, { me }) → state fields` (everything except `version/mode/me`). Must satisfy **`flatten(assemble(flatten(s)))` deep-equals `flatten(s)`** for any valid state.
  - `diff(prev, next) → ops[]`: `{ table, op: 'upsert'|'delete', key, row }` comparing rows by `JSON.stringify` with sorted keys.
- `sync.js`: `createSync({ supabase, onStatus, onRealtime?, onRejected? })` →
  - `queue(ops)`: coalesce by `table+key` (last write wins, delete beats upsert), flush 400 ms after the last change.
  - flush: upserts grouped per table in `TABLES` order (parents first), deletes in reverse order (children first); composite tables use `onConflict`. On error: `onStatus({ state: 'error', message })`, keep the failed ops queued and retry with backoff (2 s, 5 s, 10 s, max 30 s). New changes still go out 400 ms after the last one (with the failed ops) unless the failure was offline. A request refused for a row's data (constraint, RLS) is re-sent row by row so one bad row doesn't hold back the rest, and only deletes in that row's parent tables wait for its retry.
  - A child refused for a missing parent (`23503` naming its parent column, or no column) that this client isn't still writing is dropped: someone else deleted the parent and the cascade took the row too. A row refused because a link the database clears on delete (`setNull` in `TABLES`, e.g. `invoices.plan_id`, `todos.routine_id`) points at a row deleted elsewhere is sent again with that link null, as the database left it. A row refused for its data 3 times (not counting a child waiting for its parent) is given up: `onRejected([{ table, op, key, row, error }])` is called once and the status shows `'error'` with the message until the next change. A newer change to the row starts its count again.
  - `isPending(table, key)`, `hasPending()` (anything queued or in flight).
  - `staleEcho(table, key, row | null)`: true when a realtime change is the echo of one of our writes that a newer write of ours has since replaced (sent rows are remembered per row, oldest first, for 30 s; matching uses them up).
  - `dispose()`: nothing is scheduled afterwards, so a stopped engine stops writing.
  - `loadAll() → rowsByTable` (one `select *` per table).
  - `subscribe(onChange)` one realtime channel, `postgres_changes` `*` on every table (`postgres_changes_options: { wait: true }`, so `SUBSCRIBED` means changes are streaming); calls `onChange({ table, eventType, row /* new or old */ })` and passes each channel status to `onRealtime(status)`.
  - `onStatus` states: `'saved' | 'saving' | 'error' | 'offline'`.

## 4. Store (`src/data/store.jsx`)

- `mutate(fn)` runs **synchronously against a `stateRef`** (not inside a `setState` updater), so every action's logic runs once. Demo mode then saves to `localStorage` as today; live mode additionally does `ops = diff(rowsRef, flatten(next))`, `rowsRef = flatten(next)`, `sync.queue(ops)`.
- Live realtime change: skip if `sync.staleEcho(…)` or `sync.isPending(table, key)`; otherwise apply to `rowsRef` (upsert/delete), `setState({ ...assemble(rowsRef, { me }), version: 1, mode: 'live', me })`.
- Resync (reload every table and merge) after each realtime `SUBSCRIBED` (the first join can land after the first load's selects; a rejoin follows an outage) and after an offline status, once nothing is queued or in flight. Rows that change locally or over realtime while it loads keep their newer version; rows missing from the reload are dropped only when nothing local changed meanwhile.
- `onRejected`: a duplicate invoice number or channel name (`23505`) gets the next free one; any other row goes back to what the database holds (or is removed if it never saved).
- New actions (both modes): `updateProfile(userId, patch)`, `updateOrg(patch)`,
  `importRecords(kind, records, options) → { added, skipped }` with `kind` in `'clients' | 'contacts' | 'deals' | 'tasks'`
  (records already normalised to state shape by `src/lib/importers.js`; `options = { board /* board id (0006) */, groupId, groupName }` for tasks; skips names that already exist, case-insensitive),
  `signOut({ force }) → { unsaved }` (live): waits up to 3 s for edits to save; if some still haven't, returns `{ unsaved: true }` without signing out unless `force`.
- Phase 2 actions (access, My Work, routines, billing, money in, expenses, software costs, timesheets) are in
  `docs/PHASE2.md` §5; board actions (they take a board id since 0006) in §11. Every action refuses (returns `false`) what `src/lib/access.js` says the user can't do;
  live mode leaves automations to the database (`rpc` and triggers), demo mode runs `src/lib/automations.js`.
- `setMe` and `reset` are demo-only (no-ops in live).
- Extra context value `sync: { state, message }` for a small status indicator.
- Extra context value `google: { ready, demo, connected, email, connectedAt }` (0004): the signed-in admin's own Google
  connection, read from `google_me()` (not synced state; demo: `{ demo: true, connected: false }`). Google work goes
  through `src/integrations/google.js` → the store's `invoke()` → the `google` Edge Function.
- Extra context value `outreach` (0007), the read API for the agent's emails, which are not in state (both modes;
  every call resolves to `{ ok, … }` or `{ ok: false, error }`, never throws):
  `live`; `daily(from, to)` → `{ rows: [{ day, mailbox, sent, replies, bounces, meetings }] }` (live: RPC
  `outreach_daily`); `breakdown(from, to)` → `{ rows: [{ mailbox, kind: 'status' | 'reply', value, n }] }` (RPC
  `outreach_breakdown`); `emails({ mailbox /* null = all, '' = Unassigned */, from, to, search, only /* 'sent' |
  'replies' | 'logged' */, limit, offset })` → `{ rows, more }` (a paged select on `outreach_emails`, rows through
  `emailFromRow()`); `status()` → `{ sheetUrl, sheetBy, syncedAt, error, stats }` (`outreach_settings`, after saving any pending edit); `sync()` → the
  `google/outreach-sync` route (`actions.syncOutreach()`; refused in demo mode). Demo mode answers the same calls from
  `state.outreachEmails` with the same rules (`src/lib/outreach.js`).

## 5. Auth (`src/components/auth/AuthGate.jsx`)
Live mode only (demo renders children directly). States: loading → signed out (Cortex card, **Sign in with Google**, note "Use your @assetstackai.com account") → signed in but no active profile ("Your account isn't active yet. Ask an admin.", Sign out) → app.
`signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { hd: 'assetstackai.com', prompt: 'select_account' } } })`.
Domain-rejected sign-ups come back with an error in the URL; show "Only @assetstackai.com Google accounts can sign in."
