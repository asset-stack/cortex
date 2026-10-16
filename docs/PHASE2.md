# Cortex phase 2: team workflow (contract)

Builds on `docs/BACKEND.md` (phase 1, migration `0001` is **already applied in production**). Everything
here is additive: new migration `supabase/migrations/0002_team_workflow.sql`, never edits to `0001`.
Same rules as phase 1: one state shape for demo and live modes, all data through `useStore()`,
RLS on every table, repo is public (no real people/client data, keys or bank details in files).

## 0. Decisions from the owner
- Team: **SuperAdmin** (David), **Admin** (Josh), **Staff** (the ops role, mailbox `hello@`). Real names/emails
  live only in the database (`admin_emails` / profiles), never in the repo. Demo seed uses
  `David` (superadmin), `Josh` (admin), `Hello` (staff) with `@example.com` emails.
- **My Work** is each person's own daily to-do list: work assigned by admins, board items they are on,
  daily marketing routines generated automatically, and automation items. Admins can view and add to
  anyone's schedule.
- **Projects** and **Admin** boards merge into one **Projects** board; work is assigned by tagging people
  (multi-person column, and an `@Name` in a task update adds that person). Staff edited it until `0003`; since
  then they **view** it (§8). Since `0006` Projects holds several team boards plus each person's own page (§11).
- **Marketing** board: shared, everyone edits ("marketing machine" detail comes later). Since `0006` it is split
  into boards: Daily Automation, Posting schedule, Campaigns, Events (§11).
- **Outreach**: admins only by default; the SuperAdmin can switch it on (view/edit) per staff member.
- **Pipeline**: everyone views, admins edit. **Automation**: a contact moving to *Replied* or
  *Meeting booked* creates (or advances) a deal in Pipeline, plus a follow-up to-do for its owner.
- **Clients** (third stage): staff **view** clients, invoices and client usage, but cannot approve, mark
  paid, or see money-in (bank screenshots, payments), expenses or software costs.
  Billing plans generate invoices **Awaiting approval**; **Approve** sends via Gmail once connected,
  otherwise marks it *Approved* and the PDF is sent manually ("Mark as sent").
  Weekly bank-statement screenshot upload → mark invoices paid. Expenses with receipts.
  Usage = client platform usage per month **and** our software subscriptions.
- **Timesheet**: at **16:30 in each user's own time zone** on weekdays, staff (non-admin) are prompted to
  fill hourly blocks, pre-filled from what they did that day. Admins can review everyone's.

## 1. Roles and module access

Roles: `'superadmin' | 'admin' | 'staff'` (`member` from phase 1 becomes `staff`).
`isAdminRole(role)` = superadmin or admin.

Modules with access levels `'none' | 'view' | 'edit'`:

| module | superadmin / admin | staff default |
|---|---|---|
| `projects` | edit | **view** (0003; was edit) |
| `marketing` | edit | edit |
| `outreach` | edit | **none** |
| `pipeline` | edit | **view** |
| `clients` | edit | **view** (never money-in, expenses, software costs; never approve / mark paid / send) |

My Work, team chat and the timesheet are always available. Settings is admins only; inside it,
**roles, active flag and module access can be changed by the SuperAdmin only**.
Admins (superadmin/admin) always have edit; overrides only apply to staff.

Effective level for a user = admin role → `'edit'`; else the `module_access` override if present, else the
staff default above. One implementation per side:
- SQL: `public.module_level(p_module text) returns text` for `auth.uid()`; `public.can_view(m)`, `public.can_edit(m)`.
- JS: `src/lib/access.js` → `roleOf(state, userId)`, `isAdminRole(role)`, `isSuperadmin(state, userId?)`,
  `moduleLevel(state, module, userId = state.me)`, `canView(state, module, userId?)`, `canEdit(...)`,
  and React hook `useAccess()` → `{ role, isAdmin, isSuper, level(module), canView(module), canEdit(module) }`
  (0006 adds `seesPerson(userId)`, `canViewBoard(board)`, `canEditBoard(board)`: §11).
  `MODULES` and `STAFF_DEFAULTS` exported from there.

Since 0006 Projects and Marketing boards each have a level (§11): a team board has its module's level; a person's own
Projects page is edit for whoever may open it.

UI rules: nav hides modules at `none`; a hidden route falls back to My Work. At `view`, pages render
read-only (no add buttons, pickers disabled, no drag, inputs readOnly). Store actions also refuse edits
the user can't make (defence in depth); RLS is the real enforcement.

## 2. State shape additions (both modes)

```js
users: [{ ..., role: 'superadmin'|'admin'|'staff' }],
moduleAccess: [{ userId, module, level }],            // overrides only (staff)
boards: [{ id, module, name, owner, groups }],          // 0006 (§11); was { projects, marketing } ('admin' merged
                                                        // into projects in 0002)
//   item.values.people: [userId]   replaces values.owner (string)
todos: [{ id, assignee, createdBy, title, notes, day /* 'YYYY-MM-DD' */, start /* 'HH:MM'|'' */,
          minutes, category, source /* 'manual'|'routine'|'automation' */, routineId /* ''|id */,
          ref /* e.g. 'contact:<id>' | 'deal:<id>' | 'item:<id>' | 'bank:<YYYY-MM-DD>' | '' */,
          done, doneAt /* iso | '' */ }],
routines: [{ id, title, category, minutes, assignee, weekdays /* [1..7], 1 = Monday */, start, active }],
routineRuns: ['<day>|<routineId>|<userId>'],            // demo only: ensureTodosLocal's run log (live: routine_runs)
contacts: [{ ..., owner /* userId | '' */ }],          // statuses: New, Sent, Opened, Replied, Meeting booked, No reply
deals:    [{ ..., contactId /* '' | id */ }],
clients:  [{ ..., plans: [{ id, description, amount, frequency /* 'monthly'|'quarterly'|'annually' */, nextDate,
                         anchorDay /* 1..31 billing day, 0 = nextDate's day */, active }],
             usage: [{ id, month /* 'YYYY-MM-01' */, assets, sites, seats, notes }] }],
//   invoice: { ..., status: 'Draft'|'Awaiting approval'|'Approved'|'Sent'|'Paid'|'Overdue'|'Void',
//              planId: ''|id, sentAt: ''|iso, paidOn: ''|'YYYY-MM-DD' }
payments:       [{ id, invoiceId, clientId, amount, receivedOn, reference, statementId }],
bankStatements: [{ id, weekStart, filePath, note, uploadedBy, createdAt }],
expenses:       [{ id, date, vendor, category, amount /* inc GST */, gst, clientId, receiptPath, notes, createdBy }],
subscriptions:  [{ id, name, vendor, category, amount, cycle /* 'monthly'|'annually' */, renewsOn, active, notes }],
timeEntries:    [{ id, user, day, start /* 'HH:MM' */, minutes, category, note, source /* 'manual'|'suggested' */ }],
```
Empty strings, never `null`, for absent text/ids/dates in state (as phase 1). Money and counts are numbers.
Lists that live views read newest-first are stored with the same position convention as phase 1.

Work categories (`src/data/boards.js` → `CATEGORIES`, label → colour): `Email marketing`, `LinkedIn`,
`Demos`, `Meetings`, `Outreach`, `Projects`, `Marketing`, `Clients`, `Admin`, `Other`.

## 3. Database (`supabase/migrations/0002_team_workflow.sql`)

Additive and safe to run once on the live database (which may already hold rows). Wrap in a transaction.
- `profiles.role`: drop old check, `update profiles set role='staff' where role='member'`, new check
  `('superadmin','admin','staff')`, default `'staff'`. `admin_emails` gains `role text not null default 'admin'
  check in ('superadmin','admin')`; `handle_new_user` uses it (else `'staff'`).
- `is_admin()` → role in (superadmin, admin). New `is_superadmin()`. `protect_profile`: only a superadmin
  may change `role`, `active`, `email` (admins can still edit names/colours of anyone; staff their own).
  Prevent removing the last active superadmin (raise).
- `module_access (user_id uuid → profiles cascade, module text check in ('projects','marketing','outreach','pipeline','clients'), level text check in ('none','view','edit'), pk (user_id, module))`. RLS: select own rows or `is_admin()`; insert/update/delete `is_superadmin()`.
- `module_level/can_view/can_edit` (security definer, stable, fixed search_path).
- **Re-scope existing policies** (drop + recreate):
  - outreach: `contacts, emails, sequences, approvals` → select `can_view('outreach')`, write `can_edit('outreach')`.
  - pipeline: `deals` → select `can_view('pipeline')`, write `can_edit('pipeline')`.
  - clients: `clients, client_notes, client_tasks, invoices, invoice_lines, client_access, billing_plans, client_usage`
    → select `can_view('clients')`, write `can_edit('clients')`; `client_notes` keeps own-row update/delete rules.
  - boards: `board_groups, items` → by `board_key` (`projects`/`marketing` module); `item_updates, subtasks` →
    via their item's board (helper `item_board(item uuid)` security definer). An item's `board_key` is its group's
    (foreign key `(group_id, board_key)` → `board_groups (id, board_key)`, on update/delete cascade). 0006 scopes
    all four by board instead (§11).
- Board merge: `board_groups`/`items` with `board_key='admin'` move to `projects` (group renamed `Admin` when it
  was the seeded `To do`); new check `board_key in ('projects','marketing')`.
  `items.values`: `owner` (string) → `people` (json array of user ids; empty array when no owner).
- `contacts.owner_id uuid null → profiles on delete set null`; `deals.contact_id uuid null → contacts on delete set null`.
- `invoices`: add `plan_id uuid null → billing_plans on delete set null`, `sent_at timestamptz null`, `paid_on date null`.
  Function `protect_invoice_status`: only admins may set status to `Approved`, `Sent`, `Paid` or `Void`, or change `paid_on`;
  trigger `protect_invoice_status` before update, `protect_invoice_insert` after insert (only rows really inserted).
- New tables (all with `id uuid pk default gen_random_uuid()`, `updated_at/updated_by` + `touch()`, `position int` where listed):
  `todos (assignee_id → profiles cascade, created_by uuid default auth.uid(), title, notes text default '', day date not null, start_time time null, minutes int default 30, category text default 'Other', source text check in ('manual','routine','automation') default 'manual', routine_id uuid null → routines on delete set null, ref text default '', done bool default false, done_at timestamptz null, position int)` +
  unique index on `(routine_id, assignee_id, day) where routine_id is not null` and on `(assignee_id, ref, day) where source='automation'`.
  RLS: select/update own (`assignee_id = auth.uid()`) or `is_admin()`; insert own or `is_admin()`; delete creator or `is_admin()`.
  `routines (title, category, minutes int, assignee_id → profiles cascade, weekdays int[] not null default '{1,2,3,4,5}', start_time time null, active bool default true, position int)`; select `is_staff()`, write `is_admin()`.
  `billing_plans (client_id → clients cascade, description, amount numeric, frequency check in ('monthly','quarterly','annually'), next_date date, anchor_day int default 0 check 0..31, billed_periods date[] default '{}' (generate_due_invoices only; never synced), active bool, position int)`; clients module.
  `routine_runs (routine_id → routines cascade, assignee_id → profiles cascade, day date, pk (routine_id, assignee_id, day))`: `ensure_todos`' run log; RLS on, no policies or grants, not synced.
  `client_usage (client_id → clients cascade, month date, assets int, sites int, seats int, notes text, unique(client_id, month))`; clients module.
  `bank_statements (week_start date, file_path text, note text, uploaded_by uuid default auth.uid(), created_at timestamptz default now())`; **admins only**.
  `payments (invoice_id uuid null → invoices on delete set null, client_id → clients cascade, amount numeric, received_on date, reference text, statement_id uuid null → bank_statements on delete set null)`; **admins only**.
  `expenses (date date, vendor, category text, amount numeric, gst numeric, client_id uuid null → clients on delete set null, receipt_path text, notes text, created_by uuid default auth.uid(), position int)`; **admins only**.
  `subscriptions (name, vendor, category text, amount numeric, cycle check in ('monthly','annually'), renews_on date null, active bool, notes text, position int)`; **admins only**.
  `time_entries (user_id → profiles cascade, day date, start_time time, minutes int, category text, note text, source text check in ('manual','suggested'), position int)`; all ops own rows; admins select all.
- RPCs (security definer, `set search_path = public`, granted to `authenticated`):
  - `ensure_todos(p_day date) returns int`: for the caller's active routines whose `weekdays` contain `isodow(p_day)` and that haven't run for the caller that day (`routine_runs`, so a deleted or moved to-do doesn't come back), record the run and insert a `routine` to-do (title/category/minutes/start from the routine) `on conflict do nothing`. If the caller is an admin, `p_day` is a Monday and no `bank_statements.week_start = p_day` exists, insert automation to-do *Upload this week's bank screenshot* (`ref 'bank:<p_day>'`, category `Admin`). Returns rows inserted.
  - `generate_due_invoices() returns int` (admins only, raises otherwise): locks `invoices`; for each active plan with `next_date <= team_today()` and no more than two years behind (further back is a mistyped date, left alone), repeatedly create an invoice (status `Awaiting approval`, number = org prefix + next number for that prefix, min 1001, one line `description`, qty `'1'`, rate = amount as text, `plan_id`) for each period not already in `billed_periods`, and advance `next_date` by 1/3/12 months on the plan's billing day (`anchor_day`, else `next_date`'s; the month's last day when shorter) until it is in the future.
  - `team_today()`: the team's calendar day for the automations; sessions run in UTC. `Australia/Perth` in 0002,
    `Australia/Sydney` since 0003 (§8).
- Trigger `contact_pipeline` (after insert or update of `status` on `contacts`, security definer): when status becomes
  `Replied` or `Meeting booked`: if no deal has `contact_id = new.id`, insert one (`name` = org if set else name,
  stage `Opportunities` for Replied / `First meetings` for Meeting booked, `owner_id` = contact owner or `auth.uid()`,
  `priority 'P2'`, `next_step` 'Reply to <name>' / 'Prepare meeting with <name>', position at the end);
  if one exists and the new status is `Meeting booked` while the deal is in `Opportunities`, move it to `First meetings`.
  Then insert an automation to-do for that owner for `team_today()` (`user_today(owner)` since 0003) (`ref 'contact:<id>'`, category `Outreach`,
  title 'Follow up: <name> replied' / 'Prepare: meeting with <name>') `on conflict do nothing`.
- Storage: private bucket `finance` (`insert into storage.buckets … on conflict do nothing`); `storage.objects`
  policies for `bucket_id = 'finance'`: select/insert/update/delete only `is_admin()`. Paths: `statements/<uuid>-<file>`,
  `receipts/<uuid>-<file>`. Guard the storage section so it is skipped when the `storage` schema doesn't exist
  (PGlite tests stub it instead).
- Realtime publication: add every new synced table. Seed: none beyond the board merge.

## 4. Sync mapping (`src/data/backend/schema.js`)
Add tables to `TABLES` in FK-safe order and to `flatten`/`assemble` with the same rules as phase 1:
`module_access` (key `user_id:module`, onConflict `user_id,module`), `routines`, `todos`, `billing_plans`,
`client_usage`, `bank_statements`, `payments`, `expenses`, `subscriptions`, `time_entries`, plus the new columns
(`contacts.owner_id`, `deals.contact_id`, `invoices.plan_id/sent_at/paid_on`). `time` columns ⇄ `'HH:MM'` / `''`.
The round-trip property must hold for every table. Rows the user can't read simply never arrive.

## 5. Store actions (`src/data/store.jsx`) — both modes unless noted
- Access: `setModuleAccess(userId, module, level)` (superadmin only; `level === default` deletes the override).
  `updateProfile` keeps working; role/active only for superadmin.
- Boards: `updateItem` accepts `values.people`; `addUpdate` adds every `@Name` mentioned (active users) to the item's `people`.
  `addItem(boardId, groupId, name)` defaults `people: [me]`. Board actions take a board id since 0006 (§11; was the
  module key).
- My Work: `addTodo({ assignee, title, day, start, minutes, category, notes })` (staff: own only),
  `updateTodo(id, patch)`, `toggleTodo(id)` (sets `doneAt`), `deleteTodo(id)`, `moveTodo(id, day)`;
  `addRoutine`, `updateRoutine`, `deleteRoutine` (admins); `ensureTodos(day)` → live: `rpc('ensure_todos')`;
  demo: same rules in JS (`src/lib/automations.js` → `ensureTodosLocal(state, day)`).
- Outreach: `updateContact(id, patch)`; demo mode applies `contactPipelineLocal` (same rules as the trigger) from
  `src/lib/automations.js`; live mode relies on the trigger (never create the deal client-side in live).
- Clients: `addPlan(clientId, plan)`, `updatePlan`, `deletePlan`; `generateDueInvoices()` → live `rpc`, demo
  `generateDueInvoicesLocal`; `approveInvoice(clientId, invId)` → status `Approved`, issued today, due = today + terms,
  then if Gmail is connected `sendInvoice` (stub returns `{ sent: false }` today) → `Sent` + `sentAt`;
  `markInvoiceSent(clientId, invId)`; `recordPayment({ invoiceId, clientId, amount, receivedOn, reference, statementId })`
  → when payments for the invoice reach its total (inc GST) the invoice becomes `Paid` with `paidOn`;
  `upsertUsage(clientId, month, patch)`.
- Money: `addBankStatement({ weekStart, file, note })`, `addExpense(expense, file?)`, `updateExpense`, `deleteExpense`,
  `addSubscription`, `updateSubscription`, `deleteSubscription`, `fileUrl(path) → Promise<string>`.
  Files: live → `supabase.storage.from('finance').upload(path, file)` and `createSignedUrl(path, 300)`;
  demo → data URL kept in memory only (not persisted; warn above 2 MB).
- Timesheet: `saveTimesheet(day, blocks)` replaces the caller's entries for that day.
- Every action refuses (returns `false`) when `useAccess` rules say the user can't do it.

## 6. Screens
- **Sidebar**: nav = My Work, Projects, Marketing, Outreach (if visible), Pipeline (if visible), Clients (if visible),
  Settings (admins). `#/admin` redirects to Projects. Role chip shows SuperAdmin / Admin / Staff. Since 0006 Projects
  and Marketing list their boards as sub-menus (§11).
- **My Work** (`src/pages/MyWork.jsx` + `src/components/work/*`): day navigator (‹ Today ›); admins get a person
  picker (default me). Sections: *Carried over* (undone to-dos before today), *Today* (to-dos sorted by start time
  then position: checkbox, title, category pill, minutes, source icon for routine/automation, delete), inline add
  (title, category, minutes, optional time; admins can add for the selected person), *On boards* (Projects/Marketing
  items whose `people` include the person and aren't done), *Mentions* (existing). KPI row: to-dos today, done,
  carried over, mentions. Calls `ensureTodos(today)` once per day per signed-in user.
- **Projects / Marketing** boards: people column = multi-avatar picker (`PeoplePicker` in `src/components/ui`);
  read-only at `view` (per board since 0006, §11).
- **Outreach**: contact status select (New → Meeting booked …) and owner; read-only at `view`.
- **Pipeline**: read-only for `view` (no drag, no stage select, no New deal, no Make client); deal card shows a small
  link icon when it came from a contact.
- **Clients**: top-level tabs **Clients · Invoices · Money in · Expenses · Usage** (Money in and Expenses admins only;
  Usage shows client usage to all who can view clients and *Software costs* to admins only).
  Invoices tab: all invoices across clients, *Awaiting approval* first, **Approve** / **Mark as sent** / **Print / PDF**
  (admins), filters by status; admins auto-run `generateDueInvoices()` on open (once per session) and have a button.
  Client drawer gains a **Billing** tab (plans) and **Usage** tab (monthly rows).
  Money in: weekly screenshots (upload image/PDF, list with view link), unpaid invoices with **Mark paid** form.
  Expenses: table + add form (date, vendor, category, amount inc GST, GST auto = amount/11 editable, client, receipt).
  Software costs: list + monthly total (annual ÷ 12).
- **Timesheet** (`src/components/timesheet/*`, `src/lib/timesheet.js`): `TimesheetPrompt` mounted in `App.jsx`
  shows for **staff** on weekdays at/after 16:30 local time when they have no entries today (snooze until tomorrow
  stored per user in localStorage — the one allowed exception, via a tiny helper in `src/lib/timesheet.js`).
  Modal: 8 hourly blocks 09:00–17:00, each with category select + note, pre-filled by
  `suggestBlocks({ todosDone, emailsSent, itemsTouched, messagesSent }, { start: '09:00', end: '17:00' })`
  (minutes per category from completed to-dos (their `minutes`), 10 min per email sent → Email marketing,
  board items edited → Projects/Marketing; scaled to whole hours by largest remainder, ordered by first activity,
  remaining hours `Other`). Save → `saveTimesheet`. My Work has a **Log time** button for anyone, any day.
  Settings gains a **Timesheets** tab (admins): week view, hours per person per category.
- **Settings → Team** (superadmin): role select (SuperAdmin/Admin/Staff), active toggle, and an access grid per staff
  member (module × none/view/edit). Admins see it read-only. **Settings → Routines** (admins): daily routines per
  person (title, category, minutes, weekdays, time, active).

## 7. Tests
- `scripts/test-db.mjs`: run `0001` then `0002` and check: role migration; staff can't see outreach until granted;
  pipeline view-only for staff; admin-only finance tables; staff can't approve/mark paid; `contact_pipeline` creates
  and advances deals and the follow-up to-do once; `ensure_todos` idempotent; `generate_due_invoices` catches up and
  numbers sequentially; todos/time_entries privacy; superadmin-only access/role changes; last superadmin protected;
  board merge and `owner`→`people`.
- `scripts/test-sync.mjs`: round trip for every new table; access helpers; `suggestBlocks`; demo automations.

## 8. 0003: time zones and Projects view-only

`supabase/migrations/0003_timezones_projects_view.sql` runs once on top of `0002` (one transaction, safe to re-run).

- **Owner's decisions**: the team's main time zone is **Sydney** (David); Josh works from Georgia
  (`Asia/Tbilisi`) and the ops staff member from the Philippines (`Asia/Manila`). Staff **view** Projects but
  don't change it. Invoices are unchanged.
- **Business dates** (invoice generation, plan due dates) use `team_today()` = Sydney's date.
  **Personal dates** use the person's own zone: `user_today(uid)` (from `profiles.timezone`, Sydney when unknown;
  internal, not granted to `authenticated`) dates `contact_pipeline`'s follow-up to-do; My Work, `ensure_todos`
  and the 16:30 timesheet prompt already use the browser's own day.
- `profiles.timezone text not null default 'Australia/Sydney'`; trigger `check_profile_timezone` refuses a name
  missing from `pg_timezone_names` (errcode 22023). Live mode sets your own from the browser once per sign-in
  (`LiveProvider` in `src/data/store.jsx`); everyone may update their own row (0001's policy), so nothing else changes.
  State: `users[].timezone` (IANA name; the demo seed gives David Sydney, Josh Tbilisi, Hello Manila).
- `module_level()`: staff default for `projects` is `view`; `module_access` overrides still win, so the
  SuperAdmin can give one person edit in **Settings → Team**. `STAFF_DEFAULTS` in `src/lib/access.js` matches
  (`scripts/test-sync.mjs` compares it with the newest migration that defines `module_level`).
- **Screens**: Settings → Team shows each person's city and local time; the admin person picker in My Work shows
  the selected person's local time.
- **Tests**: `scripts/test-db.mjs` applies 0003 after the 0002 checks and checks the default, the per-person and
  Sydney dates, the follow-up's date, the time-zone guard and that staff can read but not write Projects.

## 9. 0004: client contacts, contracts, credits and Google (invoice email, contract Docs)

`supabase/migrations/0004_clients_google.sql` runs once on top of `0003` (one transaction, safe to re-run), before the
app version that uses it.

- **Owner's decisions**: whoever approves sends **from their own Google account** (each admin connects their own in
  Settings → Business); each client has its **own platform address**; credits come from each platform's **CSV
  export** and are for reporting only (billing stays subscription plans); contracts are copies of the **Google Doc
  template** saved in **one Drive folder**, signed with Google Workspace **eSignature**, which has no API: the admin
  requests signatures in Google Docs and Cortex tracks Draft → Sent for signature → Signed / Cancelled.
- **Tables**: `client_contacts (client_id → clients cascade, position, name, role, email, phone, billing)` and
  `client_contracts (client_id → clients cascade, position (from the end, newest on top), status check, title, doc_id,
  doc_url, start_date, end_date, annual_fee, payment_terms, user_limit, platform, customisations, mobile_app,
  governing_law, created_by, sent_by, sent_at, signed_at)`: touch, realtime; contacts use the module `clients`
  policies, contracts are read with clients view and written by admins only (`is_admin()`, as in the store). Each
  client's `key_contact` / `email` moved into its first, billing contact; re-running adds a key contact an old tab
  changed after the client's existing contacts (not billing), never one it already has (same email, else same name).
  The old columns stay, blank and no longer synced. New columns: `clients.platform_url`, `client_usage.credits`,
  `invoices.sent_to`, `org_settings.contract_template / contract_folder` (Drive links).
- **Automations**: `ensure_todos` adds **Approve invoices** (admins, ref `approve:<day>`, category Clients) while any
  invoice is *Awaiting approval* (one undone reminder per admin at a time: an undone one carries over), and admins' first My Work load each day raises due invoices first
  (`generate_due_invoices`), so recurring billing needs no cron. Trigger `client_contract_todo` (after insert on
  `clients`): a new **Onboarding** client gives its owner if they're an admin, else the admin who added it,
  **Prepare contract: <name>** on their own day (ref `contract:<id>`). Approving the last waiting invoice ticks the
  approve to-dos; creating a contract ticks the client's contract to-do. Demo copies: `ensureTodosLocal`,
  `clientCreatedLocal` (`src/lib/automations.js`).
- **Google accounts**: `private.google_accounts (user_id pk → profiles cascade, email, refresh_token, scopes)` in a
  schema the Data API doesn't expose, RLS on, no policies, not published. RPCs: `google_me()` (staff: the caller's
  uid, name, email, admin flag, connected Google email and time; never the token), `google_disconnect()` (own row),
  `google_save()` / `google_token()` (service_role only).
- **Edge Function** `supabase/functions/google/index.ts` (one pasteable file, JWT verification off, checks callers
  itself through `google_me()` with the caller's JWT; admins only): `connect` (Google consent URL for the caller's
  own account: scopes `gmail.send` and `drive`, offline access, an HMAC-signed state), `callback` (code exchange; the
  Google account must be the caller's own Cortex email; token saved with the secret key; back to Settings),
  `send` (email from the caller's Gmail, optional PDF attachment), `contract` (Drive copy of the template into the
  folder, a .docx converted to a Google Doc, `{{Placeholder}}` replaceAllText). It never writes Cortex rows: the
  store records Sent / sentTo / contracts through normal sync.
- **App**: state `clients[].platformUrl`, `contacts[]`, `contracts[]`, `usage[].credits`, `invoices[].sentTo`,
  `org.contractTemplate / contractFolder`; the context's `google` value (`{ ready, demo, connected, email }` from
  `google_me()`, not synced). The tax invoice (print and PDF) comes from one model (`src/lib/taxInvoice.js`, with
  **Attn:** the billing contacts); the emailed PDF is built in the browser with pdf-lib (`src/lib/invoicePdf.js`,
  loaded on demand). Contract Key Details defaults and placeholders: `src/lib/contract.js`. Usage export parsing:
  `src/lib/usageImport.js` (credits summed per month, snapshots take the month's maximum; re-importing replaces).
  Invoice and contract dates use Sydney's business day.
- **Screens**: client Overview (Platform link, Contacts with a Billing switch), new **Contract** tab, Billing shows who
  invoices go to, Usage credits and **Import usage**, invoice **Approve** → send dialog (or Approve only), **Send** /
  **Resend**, **Download PDF**, *Sent to …*; Settings → Business: **Google account** (connect, test, disconnect) and
  **Contracts** (template and folder links).
- **Tests**: `scripts/test-db.mjs` phase 4 (move of the legacy contacts, RLS / realtime, module access, the two
  to-dos, Google RPC privileges; the sync write check now runs after the newest migration); `scripts/test-sync.mjs`
  (mapping, diffs, demo automations, migrate, usage import, importer); `scripts/test-invoice.mjs` (model, PDF,
  contract helpers, integration seam); `scripts/test-google.mjs` (the Edge Function with fetch mocked).

## 10. 0005: each person's Tools in My Work

`supabase/migrations/0005_work_tools.sql` runs once on top of `0004` (one transaction, safe to re-run), before the app
version that uses it.

- **Owner's decision**: each person has their own list of the tools they use (Gmail, Apollo, Claude, …), so a new
  starter opens My Work and finds their links and how to sign in. **No passwords** are stored: a tool has a name, a
  link, the username / login email and a short sign-in note (Google sign-in, an invite, the team password manager).
- **Table** `work_tools (user_id → profiles cascade, position (within the person's list), name, url, username, how,
  notes, created_by)`: RLS like `todos` (your own, or anyone's for admins), touch, realtime; trigger
  `protect_work_tool` pins `created_by` to whoever added it.
- **App**: state `tools: [{ id, user, name, url, username, how, notes, createdBy }]` (by person, then order); store
  `addTool(userId, fields)`, `updateTool`, `removeTool`, `moveTool(id, ±1)` (own or admin). **My Work → Tools** (right
  column) shows the person being viewed: letter tile, link (through `safeUrl`, so only http(s) links), username with
  copy, sign-in note; admins pick anyone in the person switcher and set up their list, starting from presets
  (`src/lib/tools.js`). The demo seed gives Hello Gmail, Google Drive, Apollo and Claude.
- **Tests**: `scripts/test-db.mjs` phase 5 (own / admin access, `created_by` pinned, inactive and anon see nothing,
  realtime); `scripts/test-sync.mjs` (mapping, per-person positions, diff, seed, migrate).

## 11. 0006: boards under Projects and Marketing

`supabase/migrations/0006_boards.sql` runs once on top of `0005` (one transaction, safe to re-run), before the app
version that uses it.

- **Owner's decisions**: Projects and Marketing get sub-menus in the sidebar. Marketing: Daily Automation, Posting
  schedule, Campaigns, Events. Projects: first each person's own page (*David’s Projects*), then the team boards
  (Landing Page, Tender Portal, …). The SuperAdmin sees everyone's page, an admin their own and staff's, staff only
  their own. Boards, groups, tasks, subtasks and updates can be renamed or edited and deleted by whoever may edit them.
- **Table** `boards (module check in ('projects','marketing'), name, owner_id uuid null → profiles cascade, position)`:
  touch, realtime. A **team board** has no owner. A **personal board** has `owner_id` set, one per person (unique
  index), Projects only (check), and a blank name (the app shows *<first name>’s Projects*, `boardTitle()`).
  `board_groups.board_id` and `items.board_id` (not null) say which board a group or task is on; `board_key` stays the
  module. Foreign keys `board_groups (board_id, board_key)` → `boards (id, module)` and `items (group_id, board_id)` →
  `board_groups (id, board_id)`, on update and delete cascade: a group is on a board of its own module, a task on its
  group's board, and deleting a board deletes its groups, tasks, subtasks and updates.
- **Starting boards**: Projects → Landing Page, Tender Portal, General; Marketing → Daily Automation, Posting schedule,
  Campaigns, Events (only for a module with no team boards yet, so a re-run keeps admins' changes). The existing
  Projects groups go on **General** and the Marketing ones on **Posting schedule**, with their tasks. A board without
  groups gets one (Projects *Active*, Marketing *To do*). Every profile gets its personal board, and trigger
  `add_personal_board` (after insert on `profiles`) gives each new person one with an *Active* group. The names are
  `STARTING_BOARDS` / `EXISTING_BOARD` / `FIRST_GROUP` in `src/lib/boards.js`.
- **Access**: `board_level(board)` → `'none' | 'view' | 'edit'`, with `can_view_board()` / `can_edit_board()`; JS
  `boardLevel` / `canViewBoard` / `canEditBoard` in `src/lib/access.js`, same rules. A team board has its module's
  level. A personal board is `edit` for whoever may open it (`sees_person(owner)`, JS `seesPerson`: yourself, staff's
  for an admin, everyone's for the SuperAdmin) while they can view Projects at all, else `none`.

  | board | SuperAdmin | Admin | Staff |
  |---|---|---|---|
  | team boards | edit | edit | the module's level (default Projects view, Marketing edit) |
  | your own page | edit | edit | edit |
  | a staff member's page | edit | edit | none |
  | an admin's or SuperAdmin's page | edit | none | none |

- **Who changes what** (RLS ⇄ store; each store action returns `false` and changes nothing when refused):
  - **Team boards**: only admins add, rename, reorder (within the module) and delete them (`boards` insert / update /
    delete need `owner_id is null and is_admin()`). `boards` select: `can_view(module)`, and for a personal board also
    `sees_person(owner_id)`.
  - **Personal pages** are never written by the app: they can't be renamed or deleted, and come and go with their
    person's profile.
  - **Groups and tasks** (`board_groups`, `items`): read with `can_view_board(board_id)`, written with
    `can_edit_board(board_id)`: add, rename, reorder and delete groups (with their tasks); add, edit and delete tasks.
    **Subtasks** (add, rename, tick, delete) and **updates** follow their task's board through `item_board_id(item_id)`
    (0002's `item_board()` is no longer used).
  - **Updates**: posted as yourself; edited and deleted by their author or an admin, on a board they can edit.
  - **Moving a task** to another group, on the same board or another board of the same module, needs edit on both;
    it goes to the end of the group (the target board's first group when none is picked), with its subtasks and
    updates. In the database the task's `group_id` changes and its `board_id` follows (the composite foreign key and
    `place_on_board`); the update policy checks the old and the new board.
- **Old app tabs**: trigger `place_on_board` (before insert or update on `board_groups` and `items`) fills a missing
  `board_id`, as an app version from before 0006 writes rows without it: a new group lands on **General** / **Posting
  schedule** (else the module's first team board), a task on its group's board. Reloading the tab ends it.
- **App**: `state.boards` is an array (`docs/BACKEND.md` §1): Projects then Marketing; personal boards first (by
  owner's name), then team boards in order. Sync: `boards` → `board_groups` → `items`; team board positions count
  within their module, personal boards are 0. Pure helpers in `src/lib/boards.js` (`findBoard`, `personalBoard`,
  `teamBoards`, `boardTitle`, `boardHref`, `resolveBoard`). Store actions take a **board id** (was the module key):
  `addBoard(module, name) → id` (with one group), `renameBoard`, `moveBoard(id, ±1)`, `removeBoard` (admins, team
  boards); `addItem(boardId, groupId, name) → id`, `updateItem`, `deleteItem`,
  `moveItem(boardId, itemId, { board, group })`; `addGroup → id`, `renameGroup`, `moveGroup(boardId, groupId, ±1)`,
  `removeGroup`; `addUpdate`, `editUpdate`, `removeUpdate`; `addSubtask`, `toggleSubtask`, `renameSubtask`,
  `removeSubtask`; `importRecords('tasks', records, { board: boardId, groupId, groupName })`. Demo `migrate()`
  converts a saved `{ projects: { groups }, marketing: { groups } }` the way 0006 does and gives every user missing one
  a personal page; the demo seed has David's, Josh's and Hello's pages and the starting team boards.
- **Routes**: `#/projects` opens your own page (else the first team board), `#/marketing` the first Marketing board;
  `#/projects/<board id>` / `#/marketing/<board id>` a board, and `?item=<id>` opens a task on it (`boardHref()`).
  Old `#/projects?item=<id>` and `#/admin?item=<id>` links open the board that holds the task. A board you can't see
  falls back to the module's default (`resolveBoard()`).
- **Screens**: the sidebar lists each module's boards under it. Admins add team boards, and rename, move and delete
  them; on any board you can edit, groups, tasks, subtasks and updates (yours, or anyone's for admins) are renamed or
  edited and deleted in place, and a task moves to another group or board from its drawer. Deleting a board, a group
  or a task asks first; a subtask or an update goes at once. A read-only board shows none of this. My Work → On boards
  lists open tasks from every board you can see, with the board's name.
- **Tests**: `scripts/test-db.mjs` phase 6 (starting boards and where the groups went, personal boards for existing
  and new profiles, who sees and edits which board, team boards admins only, moving a task across boards,
  `place_on_board`, re-run, realtime); `scripts/test-sync.mjs` (mapping and positions, `boardLevel` against the SQL
  rules, store actions refused as in RLS, `migrate`, `resolveBoard`).
