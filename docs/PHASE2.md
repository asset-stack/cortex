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
  (multi-person column, and an `@Name` in a task update adds that person). Staff edited it until `0003`, viewed it
  under `0003` (§8), and edit it again since `0006`, when Projects became several team boards plus each person's own
  page (§11).
- **Marketing** board: shared, everyone edits ("marketing machine" detail comes later). Since `0006` it is split
  into boards: Daily Automation, Posting schedule, Campaigns, Events (§11).
- **Outreach**: admins only by default; the SuperAdmin can switch it on (view/edit) per staff member. Since `0007` it
  shows the cold email a separate Claude agent sends from each outreach mailbox, read from the agent's Google Sheet
  (§12); its Contacts list stays, for the Pipeline automation below.
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
| `projects` | edit | **edit** (0006; view in 0003, edit before) |
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

Since 0006 (Projects, Marketing, §11) and 0007 (Outreach, Clients, §13) boards each have a level: a team board has its
module's level (so Outreach and Clients access also reads or edits their boards); a person's own Projects page is edit
for whoever may open it.

Outreach since 0007 (§12): `view` sees the dashboard, the emails and the notes and may **Sync now**; `edit` also writes
notes (changing or removing one: its author or an admin). The same level reads or edits Outreach's boards (§13). The mailboxes and the sheet's link are admins only
(**Settings → Outreach**).

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
seededBoards: ['projects', 'marketing', 'outreach', 'clients'], // demo only (0007, §13): modules whose starting boards
                                                        // this demo has had; migrate() adds a new module's once
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
// 0007 (§12): Outreach. The agent's emails are not in state: useStore().outreach reads them on demand.
mailboxes:      [{ id, name, addresses /* [lower-case address] */, owner /* userId | '' */, active }],   // in order
outreachNotes:  [{ id, mailbox /* '' = all mailboxes */, pinned, body, author, createdAt }],         // newest first
outreachSheet:  '<the sheet link>',                     // undefined in live mode without Outreach access
outreachEmails: [{ id, mailbox, sender, sentOn, … }],   // demo only (emailFromRow() shape, §12)
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
  if one exists and the new status is `Meeting booked` while the deal is in `Opportunities` (or, since 0008, `Contacted`:
  §14), move it to `First meetings`.
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
  `src/lib/automations.js`; live mode relies on the trigger (never create the deal client-side in live). 0007 adds
  the mailbox, sheet, note and sync actions (§12).
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
  and Marketing, and since 0007 Outreach and Clients (after their own page, §13), list their boards as sub-menus
  (§11).
- **My Work** (`src/pages/MyWork.jsx` + `src/components/work/*`): day navigator (‹ Today ›); admins get a person
  picker (default me). Sections: *Carried over* (undone to-dos before today), *Today* (to-dos sorted by start time
  then position: checkbox, title, category pill, minutes, source icon for routine/automation, delete), inline add
  (title, category, minutes, optional time; admins can add for the selected person), *On boards* (items on any board
  you can see whose `people` include the person and aren't done), *Mentions* (existing). KPI row: to-dos today, done,
  carried over, mentions. Calls `ensureTodos(today)` once per day per signed-in user.
- **Projects / Marketing** boards: people column = multi-avatar picker (`PeoplePicker` in `src/components/ui`);
  read-only at `view` (per board since 0006, §11).
- **Outreach**: contact status select (New → Meeting booked …) and owner; read-only at `view`. Since 0007 the page is
  the agent's dashboard, with this contact list kept as its **Contacts** view (§12).
- **Pipeline**: read-only for `view` (no drag, no stage select, no Edit, no New deal, no Make client); deal card shows a
  small link icon when it came from a contact. Since 0008 the columns are Opportunities → Contacted → First meetings →
  Demos, each card has **Edit**, and Make client is on Demos (§14).
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
  board items edited → their module's category (Projects, Marketing, Outreach, Clients); scaled to whole hours by
  largest remainder, ordered by first activity,
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

`supabase/migrations/0006_boards.sql` runs on top of `0005` (safe to re-run; it does not rely on running as one
transaction, since the SQL editor may run statements one by one and carry on after an error, as its first live run
did), before the app
version that uses it.

- **Owner's decisions**: Projects and Marketing get sub-menus in the sidebar. Marketing: Daily Automation, Posting
  schedule, Campaigns, Events. Projects: first each person's own page (*David’s Projects*), then the team boards
  (Landing Page, Tender Portal, …). The SuperAdmin sees everyone's page, an admin their own and staff's, staff only
  their own. Boards, groups, tasks, subtasks and updates can be renamed or edited and deleted by whoever may edit them.
  Staff edit the team Projects boards too (0003 had made Projects view-only for staff; 0006 redefines `module_level()`
  with the Projects default back to `edit`, and `STAFF_DEFAULTS` to match; per-person overrides still win). Tasks
  move between team boards, never onto, off or between personal pages (see *Moving a task*).
- **Table** `boards (module check in ('projects','marketing'); 0007 adds 'outreach','clients' (§13), name, owner_id uuid null → profiles cascade, position)`:
  touch, realtime. A **team board** has no owner. A **personal board** has `owner_id` set, one per person (unique
  index), Projects only (check), and a blank name (the app shows *<first name>’s Projects*, `boardTitle()`).
  `board_groups.board_id` and `items.board_id` (not null) say which board a group or task is on; `board_key` stays the
  module. Foreign keys `board_groups (board_id, board_key)` → `boards (id, module)` and `items (group_id, board_id)` →
  `board_groups (id, board_id)`, on update and delete cascade: a group is on a board of its own module, a task on its
  group's board, and deleting a board deletes its groups, tasks, subtasks and updates.
- **Starting boards**: Projects → Landing Page, Tender Portal, General; Marketing → Daily Automation, Posting schedule,
  Campaigns, Events (only for a module with no team boards yet, and only until a run has completed, so a re-run keeps
  admins' changes). The existing
  Projects groups go on **General** and the Marketing ones on **Posting schedule**, with their tasks. A board without
  groups gets one (Projects *Active*, Marketing *To do*), likewise only until a run has completed: the last statement
  labels `public.boards` *Cortex 0006 complete* once every group and task is on a board and every board has a group,
  and the seeding statements check for that label. A run that stopped part-way (the first live run, whose seeding
  failed, left every group and task unlinked and hidden) is finished by running the file again. `same_audience` lets
  that backfill place a row that has no board yet. Every profile gets its personal board, and trigger
  `add_personal_board` (after insert on `profiles`) gives each new person one with an *Active* group. The names are
  `STARTING_BOARDS` / `EXISTING_BOARD` / `FIRST_GROUP` in `src/lib/boards.js`.
- **Access**: `board_level(board)` → `'none' | 'view' | 'edit'`, with `can_view_board()` / `can_edit_board()`; JS
  `boardLevel` / `canViewBoard` / `canEditBoard` in `src/lib/access.js`, same rules. A team board has its module's
  level. A personal board is `edit` for whoever may open it (`sees_person(owner)`, JS `seesPerson`: yourself, staff's
  for an admin, everyone's for the SuperAdmin) while they can view Projects at all, else `none`.

  | board | SuperAdmin | Admin | Staff |
  |---|---|---|---|
  | team boards | edit | edit | the module's level (default edit for Projects and Marketing) |
  | your own page | edit | edit | edit |
  | a staff member's page | edit | edit | none |
  | an admin's or SuperAdmin's page | edit | none | none |

- **Who changes what** (RLS ⇄ store; each store action returns `false` and changes nothing when refused):
  - **Team boards**: only admins add, rename, reorder (within the module) and delete them (`boards` insert / update /
    delete need `owner_id is null and is_admin()`). `boards` select: `can_view(module)`, and for a personal board also
    `sees_person(owner_id)`.
  - **Personal pages**: their `boards` row is never written by the app (no policy allows it), so they can't be
    renamed or deleted; they come and go with their person's profile (`add_personal_board`, on delete cascade).
  - **Groups and tasks** (`board_groups`, `items`): read with `can_view_board(board_id)`, written with
    `can_edit_board(board_id)`: add, rename, reorder and delete groups (with their tasks); add, edit and delete tasks.
    **Subtasks** (add, rename, tick, delete) and **updates** follow their task's board through `item_board_id(item_id)`
    (0002's `item_board()` is no longer used). The write checks (`with check`) use `can_write_board()` /
    `can_write_item()`, which also pass when the board or task no longer exists: the foreign key then refuses the row
    with 23503, which the sync drops as "deleted elsewhere", instead of an RLS refusal it would retry and report.
  - **Updates**: posted as yourself; edited and deleted by their author or an admin, on a board they can edit. The
    sync saves an edit as an upsert, and Postgres checks the insert policies on an upsert too, so policy
    `admin_resave` (insert, `is_admin() and update_exists(id)`) lets an admin's edit of someone else's update through
    to `author_update`; a new update is always the signed-in user's own.
  - **Moving a task** to another group, on the same board or another **team** board of the same module, needs edit on
    both; it goes to the end of the group (the target board's first group when none is picked), with its subtasks and
    updates. In the database the task's `group_id` and `board_id` change together (the composite foreign key keeps
    them consistent); the update policy checks the old and the new board. Trigger `same_audience` (before update on
    `items` and `board_groups`, after `place_on_board`) refuses a `board_id` change between boards with a different
    owner or module — onto, off or between personal pages, or Projects ⇄ Marketing — with `check_violation`, as `sameAudience()` in
    `src/lib/boards.js` does in the app: a move never changes who can see a task, so everyone's realtime view stays
    right. On a personal page the drawer offers other groups only. Trigger `keep_board_links` keeps what the app never
    changes fixed for signed-in requests: a board's `module`, a subtask's or update's `item_id`, an update's `user_id`.
- **Old app tabs**: trigger `place_on_board` (before insert or update on `board_groups` and `items`) fills a missing
  `board_id`, as an app version from before 0006 writes rows without it: a new group lands on **General** / **Posting
  schedule** (else the module's first team board), a task on its group's board. Reloading the tab ends it. Until
  then an old tab groups rows by module only, so its Projects and Marketing pages also show the new boards' starting
  groups (several *Active* and *To do* groups), and a task added to one of them lands on that board, possibly
  someone's own page. So everyone closes Cortex before 0006 runs, and the new app is deployed straight after
  (`DEPLOY.md`).
- **App**: `state.boards` is an array (`docs/BACKEND.md` §1): Projects, Marketing, then (0007, §13) Outreach and
  Clients; personal boards first (by owner's name), then team boards in order. Sync: `boards` → `board_groups` → `items`; team board positions count
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
  falls back to the module's default (`resolveBoard()`). The address is then replaced with the board on screen, so
  boards reordered or added elsewhere never swap it under you.
- **Live updates**: an admin's engine reloads when someone else's role changes, because which personal pages an admin
  may read depends on whether their owners are staff.
- **Screens**: the sidebar lists each module's boards under it. Admins add team boards, and rename, move and delete
  them; on any board you can edit, groups, tasks, subtasks and updates (yours, or anyone's for admins) are renamed or
  edited and deleted in place, and a task moves to another group or board from its drawer. Deleting a board, a group
  or a task asks first; a subtask or an update goes at once. A read-only board shows none of this. My Work → On boards
  lists open tasks from every board you can see, with the board's name.
- **Tests**: `scripts/test-db.mjs` phase 6 (starting boards and where the groups went, personal boards for existing
  and new profiles, who sees and edits which board, team boards admins only, moving a task across boards,
  `place_on_board`, re-run, realtime); `scripts/test-sync.mjs` (mapping and positions, `boardLevel` against the SQL
  rules, store actions refused as in RLS, `migrate`, `resolveBoard`).

## 12. 0007: Outreach — cold email per mailbox, synced with the agent's sheet

`supabase/migrations/0007_outreach.sql` runs on top of `0006` (safe to re-run, also statement by statement as the SQL
editor may run it: no statement relies on another having run in the same transaction or session), before the app
version that uses it. The `google` Edge Function (§9) gains the route `outreach-sync`, so it is redeployed with it
(`DEPLOY.md` section 12).

- **Owner's decisions**: Outreach shows the cold email a separate Claude agent (outside Cortex) sends from three
  outreach mailboxes, one person each (today only David's sends). Each mailbox is its own data set; *All* adds them
  up. The top line is emails sent per day; then sent, replies, reply rate, opens (*Not tracked* for now, see *Opens*),
  bounces and meetings, and notes for what the team knows (the outreach strategy that works). Everything also stays in
  the agent's Google Sheet for hard reference, where Cortex keeps a **Summary** and a **Notes** tab and a tab per mailbox
  (David, Josh, Sarah: that mailbox's rows). The agents keep writing one shared tab, so they dedupe prospects across
  mailboxes. Cortex never sends outreach email and never changes the agent's rows.
- **Data flow**:
  1. The agent keeps its own sheet (*Email Outbound Tracker*): **one tab** shared by every mailbox (so the agent's
     checks dedupe prospects across mailboxes), one row per prospect, headers in row 1: `date_logged, vertical,
     organisation, domain, location, kdm_name, kdm_role, kdm_email, apollo_email_status, gmail_check,
     apollo_history_check, tracker_check, eligible, tier, signal, research_hook, subject, variant, email_id,
     draft_status, gmail_draft_id, sent_date, sent_message_id, thread_id, sequence_status, followup_stage,
     next_followup_date, ooo_until, bounced, suppress_until, reply_status, reply_date, reply_summary, note,
     meeting_booked_date`, plus **`sender`** (added for Cortex: the address the row's mailbox sends from, filled on
     every row). Dates are `YYYY-MM-DD`, `bounced` is `yes` or blank, `draft_status` is `sent`, `draft-saved`,
     `draft-lost` or `skipped-…` (colleague, unverified, held, crisis, warm), message and thread ids are Gmail's.
  2. Someone who can view Outreach opens it, or clicks **Sync now**: `actions.syncOutreach()` → the store's `invoke()`
     → `google/outreach-sync`. The function checks the caller with their own JWT (`outreach_access()`: view is
     enough), reads `outreach_settings` with the secret key, and reads the sheet **as the admin who set its link**
     (`sheet_by`: their token from `private.google_accounts` through `google_token()`, only while they are an active
     admin; otherwise the sync stops and asks another admin to click **Use my Google**), with the Sheets API (the
     `drive` scope of §9 covers it). It reads exactly the tab the link opens (`#gid=…`, `sheetFromUrl()`; Settings
     only takes a link with one), never a guess, so it can never mistake the agent's tab for one of its own: a link
     with no tab, a tab that's gone, or Summary / Notes is refused (saved as `sync_error`), with nothing written.
  3. Each sheet row becomes an `outreach_emails` row, upserted with the secret key in batches. Headers are matched by
     name in any case, so column order doesn't matter:

     | sheet | `outreach_emails` |
     |---|---|
     | `date_logged`, `vertical`, `organisation`, `domain`, `location`, `tier`, `signal`, `subject`, `variant`, `thread_id`, `sequence_status`, `followup_stage`, `reply_status`, `reply_summary`, `note` | same name |
     | `sender` (else `mailbox`, `from` or `sent_from`: the first with a value; `Name <address>` works) | `sender` (lower case) |
     | `kdm_name`, `kdm_role`, `kdm_email` | `contact_name`, `contact_role`, `contact_email` |
     | `draft_status` | `status` |
     | `sent_date`, `sent_message_id` | `sent_on`, `message_id` |
     | `next_followup_date`, `reply_date`, `meeting_booked_date` | `next_followup`, `reply_on`, `meeting_on` |
     | `bounced` (`yes`, `y`, `true`, `1`) | `bounced` (true) |
     | the whole row's non-blank cells (also the agent's checks, `research_hook`, `ooo_until`, `suppress_until`, …) | `raw` |

     Dates are read as `YYYY-MM-DD` (or `D/M/YYYY`); anything else is blank. The sheet has a row per **contact**: an
     email to two people at one organisation is two rows with the same `email_id` and `sent_message_id`. So
     `row_key` (lower case) is the contact and the day it was logged, `kdm_email|date_logged`, else
     `organisation|kdm_name|date_logged`, which stays the same as the row moves from logged to drafted to sent (the
     ids only appear along the way); a row with neither is skipped, and of two rows with the same key the later one
     wins. `mailbox_id` is the mailbox whose `addresses` include `sender` (`mailboxFor()`), else null: **Unassigned**.
     Every sync works it out again, so adding an address to a mailbox moves its rows at the next sync. A row this sync
     didn't write (gone from the sheet) keeps its data, with `in_sheet` false. A tab whose row 1 has none of these
     headers is refused.
  4. It writes its tabs back into the same spreadsheet, found by name (any case) and added when missing, each cleared
     and rewritten as plain values: **Summary** (`Date, Mailbox, Sent, Replies, Reply rate, Bounces, Meetings`, one row
     per day and mailbox, newest day first, by the rules under *Numbers*; then the all-time totals per mailbox and for
     all), **Notes** (`Created, Mailbox, Pinned, Author, Note`, times in Sydney; pinned first, then newest) and **one tab
     per mailbox**, titled with its name, in mailbox order: the agent's header row, then the rows Cortex saved for that
     mailbox (one per `row_key`), in the agent's order and exactly as the agent wrote them (a mailbox with none: the
     header only; Unassigned rows are in no mailbox tab). New tabs are made big enough, and a tab too small for what it
     holds is grown (never shrunk): the values API doesn't grow a grid. It never writes the agent's tab, and never
     deletes a tab: a
     mailbox named like the agent's tab, Summary or Notes, or like an earlier mailbox, gets no tab (listed in
     `sync_stats.noTab`; the app refuses such names anyway), and a renamed or removed mailbox's old tab stays until
     someone deletes it.
  5. It records `synced_at`, `sync_error` (cleared when it works) and `sync_stats` (`{ rows, contacts, sent, replies,
     bounced, meetings, unassigned, duplicates, skipped, missing, tab, tabs, noTab }`, all time; `tab` = the agent's tab,
     `tabs` = the mailbox tabs written, `noTab` = `[{ mailbox, why }]`; `contacts` = rows with a sent date,
     the rest counted as under *Numbers*) in `outreach_settings` and returns `{ ok, stats }`. A failure once a link and
     its admin are set (the link not to a tab, that admin no longer an active admin, their Google not connected or
     without access to the sheet, the Sheets API off, …) is saved as `sync_error`, which Outreach shows to everyone; the
     messages name the admin whose Google account is used. No link, or no admin for it, is only returned to the caller
     (Outreach then says so). Results and errors are saved only while the link and its admin are still the ones the
     sync read and no newer sync has saved its own, so a sync finishing or failing late never overwrites a newer
     sync's results, a new link's, or a takeover (Use my Google).
  6. There is no lock: two syncs can overlap (two people open Outreach at once). Each stamps the rows it writes, and
     the rows it flags as gone, with its start time, and 0007's `keep_newer_sync` trigger skips an older sync's update
     of a row a newer sync (one that started later) has stamped: an older sync landing late neither overwrites the
     newer one's rows nor brings back a row it flagged. (A row new to the database that the older sync adds after the
     newer one's flagging stays until the next sync.) If both add Cortex's tabs, the second finds them again and
     carries on.
- **When the sheet is read**: when someone opens Outreach and the last sync is more than 10 minutes old, and on **Sync
  now**. There is no cron: when nobody is looking nothing needs to be fresh, and the sheet stays the record in between
  (its Summary, Notes and mailbox tabs are as of the last sync).
- **Numbers** (one rule set: SQL `outreach_daily()` / `outreach_breakdown()` ⇄ JS `outreachDaily()` /
  `outreachBreakdown()` / `outreachTotals()` in `src/lib/outreach.js`, and the Summary tab's `summaryValues()` in the
  function; change them together). They count **emails, not people**: rows are grouped by their Gmail message
  (`message_id`, else the row's `row_key`; `emailKey()`) and mailbox, so an email to two contacts counts once. An
  email counts as **sent** on its first `sent_on`, and as a **bounce** on that same day if any of its addresses
  bounced; as a **reply** on its first `reply_on` among rows with a `reply_status`; and as a **meeting** on its first
  `meeting_on`. Rows no longer in the sheet (`in_sheet` false) count nowhere, so the numbers match the sheet's.
  Reply rate = replies ÷ sent in the period (a reply in the period may answer an email sent before it). The
  **breakdown** counts contacts logged in the period (`date_logged`, one per row) by status (sent, draft-saved,
  skipped-…) and the emails first replied to in the period by the kind of that first reply (negative, referral, …;
  on a same-day tie, the first alphabetically). The emails list shows a row per contact. Days are the sheet's dates
  as the agent wrote them; a period ends on the browser's today (`periodRange()`).
- **Tables** (`id uuid`, touch, RLS on):
  - `outreach_mailboxes (name, addresses text[] (every address it sends as, lower case: an old and a new domain are
    one mailbox), owner_id uuid null → profiles on delete set null (its person may have no Cortex account), active,
    position)`: realtime.
  - `outreach_emails (row_key text unique, mailbox_id uuid null → outreach_mailboxes on delete set null (null =
    Unassigned), sender, date_logged, vertical, organisation, domain, location, contact_name, contact_role,
    contact_email, tier, signal, subject, variant, status, sent_on, message_id, thread_id, sequence_status,
    followup_stage int, next_followup, bounced bool, reply_status, reply_on, reply_summary, note, meeting_on, in_sheet
    bool, raw jsonb, synced_at)`, indexed on `sent_on`, `reply_on`, `date_logged` and `mailbox_id`. **Server-written**:
    `authenticated` has select only, it is not in realtime and not synced.
  - `outreach_notes (mailbox_id uuid null → outreach_mailboxes cascade (null = all mailboxes), pinned, body,
    author_id → profiles on delete set null, created_at)`: realtime.
  - `outreach_settings`: one row (`id = 1`, seeded): `sheet_url`, `sheet_by → profiles on delete set null` (the admin
    who set the link), `synced_at`, `sync_error`, `sync_stats jsonb`: realtime.
- **Triggers**: `protect_outreach_note` pins a note's `author_id` and `created_at` to whoever wrote it, when.
  `protect_outreach_settings`: a signed-in request changes only `sheet_url`, and `sheet_by` becomes whoever saves it,
  the same link included (the sync then reads the sheet with that admin's Google account: **Use my Google** in
  Settings → Outreach saves the same link again); a save clears `sync_error`, and a new link also clears `synced_at`
  and `sync_stats` (not synced yet, so opening Outreach syncs it); otherwise `synced_at`, `sync_error` and
  `sync_stats` are the function's (the secret key has no `auth.uid()`). `keep_newer_sync` on `outreach_emails` skips
  an update whose `synced_at` is older than the row's (two syncs at once, above). `touch()` on all four.
- **RPCs** (granted to `authenticated` only): `outreach_daily(p_from, p_to)` → `(day, mailbox_id, sent, replies,
  bounces, meetings)` and `outreach_breakdown(p_from, p_to)` → `(mailbox_id, kind 'status' | 'reply', value, n)`, both
  `security invoker`, so RLS applies (no rows without Outreach); `outreach_access()` → `{ view, edit, admin }`
  (`security definer`), which the function asks with the caller's JWT before it syncs for them.
- **Who sees and writes what** (RLS ⇄ store; each refused action returns `false` and changes nothing):

  | | read | write |
  |---|---|---|
  | mailboxes | Outreach view | admins (**Settings → Outreach**) |
  | emails | Outreach view | nobody in the app: the sync, with the secret key (which bypasses RLS) |
  | notes | Outreach view | Outreach edit, as yourself; changed or removed by their author or an admin |
  | settings | Outreach view | admins, the sheet's link only |
  | **Sync now** | | Outreach view (the function checks `outreach_access()`) |

  `outreach` has been a module key since 0002, and staff still default to `none` (§1).
- **App**:
  - State (both modes, synced, realtime in live mode): `mailboxes`, `outreachNotes`, `outreachSheet` (§2). The sync
    mapping (`src/data/backend/schema.js`) has `outreach_settings` (only `sheet_url`, updated in place, and only sent
    when state holds it), `outreach_mailboxes` and `outreach_notes`.
  - **The emails are not in synced state**: they only grow (the agent logs dozens of prospects a day per mailbox),
    `loadAll()` would select every one on each load and resync, every sync's upserts would stream to every open tab,
    and nobody edits them in the app. The page needs totals and one page of the list at a time, so it asks for those.
    Demo mode keeps them in `state.outreachEmails`.
  - Read API `useStore().outreach` (both modes; every call resolves, never throws, to `{ ok, … }` or
    `{ ok: false, error }`): `live` (bool); `daily(from, to)` → `{ rows: [{ day, mailbox, sent, replies, bounces,
    meetings }] }`; `breakdown(from, to)` → `{ rows: [{ mailbox, kind, value, n }] }`; `emails({ mailbox /* null =
    all, '' = Unassigned */, from, to, search, only /* 'sent' | 'replies' | 'logged' */, limit, offset })` →
    `{ rows, more }` (newest first; `search` matches organisation, contact, role, email, subject and sender);
    `status()` → `{ sheetUrl, sheetBy, syncedAt, error, stats }`; `sync()` (as `syncOutreach`). Live: the two RPCs and paged
    selects on `outreach_emails` / `outreach_settings`; demo: the same helpers over `state.outreachEmails`, and
    `sync()` refuses (*Syncing the sheet works in live mode only.*). An email in the app: `emailFromRow()` →
    `{ id, mailbox ('' = Unassigned), sender, dateLogged, vertical, organisation, domain, location, contactName,
    contactRole, contactEmail, tier, signal, subject, variant, status, sentOn, messageId, threadId, sequenceStatus,
    followupStage, nextFollowup, bounced, replyStatus, replyOn, replySummary, note, meetingOn, inSheet }`.
  - Store actions: `addMailbox({ name, addresses, owner }) → id`, `updateMailbox(id, patch)`, `removeMailbox(id)`
    (with its notes; its emails become Unassigned), `moveMailbox(id, ±1)`, `setOutreachSheet(url)`,
    `takeOutreachSheet()` → `{ ok } | { ok: false, error }` (Use my Google; live mode) (admins);
    `addOutreachNote({ body, mailbox, pinned }) → id`, `updateOutreachNote(id, { body, pinned, mailbox })`,
    `removeOutreachNote(id)` (Outreach edit; author or admin to change or remove); `syncOutreach()` → `{ ok, stats }`
    or `{ ok: false, error }` (pending edits, such as a sheet link just saved, go first). Pure helpers in `src/lib/outreach.js` (also `parseAddresses`, `mailboxFor`,
    `gmailThreadUrl`, `sheetFromUrl`, `periodRange`, `daysBetween`, `filterEmails`).
  - Demo seed: mailboxes David, Josh and Sarah (`david@` / `josh@` / `sarah@example.com`; Sarah has no Cortex user),
    about 240 contact rows over the last 12 working days (some emails to two contacts; a contact at most once a day)
    and two notes (one pinned); `migrate()` adds them to older saved demo data.
- **Screens**: **Outreach** has two views, **Emails** and **Contacts**. Emails: a mailbox picker (All, each active
  mailbox, and Unassigned when there are such rows in the period), a period (7, 30 or 90 days) and the last sync with
  **Sync now** (`src/components/outreach/SyncStatus.jsx`, which also syncs on open); then Sent, Sent today, Replies,
  Reply rate, Bounces, Meetings and Opens (*Not tracked*); the emails sent per day (stacked by mailbox); with All, a
  card per mailbox (sent, replies, reply rate, last sent; a click picks it); the notes (pinned first; written at
  edit) beside the breakdown; and the emails, a row per contact (Sent, Replies, All logged; search; each opens with
  everything and a link to its Gmail thread in the sending mailbox, `gmailThreadUrl()`). **Contacts** stays: the contact list
  with owner and status, because a contact moving to *Replied* or *Meeting booked* drives the Pipeline automation
  (`contact_pipeline`, §3). The old demo composer, Gmail feed, sequences and approvals queue are gone from the UI;
  their tables (`emails`, `sequences`, `approvals`), state and sync are untouched. **Settings → Outreach** (admins):
  the sheet's link with the last sync, whose Google account reads it (*Reads as …*) and **Use my Google**, and the
  mailboxes (name, addresses, person, active, order).
- **Opens are not tracked yet.** An open is only visible through a tracking image: a tiny remote image, unique to each
  email, that the recipient's mail app loads. The agent's emails carry none, on purpose: tracking images (and tracked
  links) are a spam signal, and the outreach domains are new and still building their sending reputation; and Apple
  Mail (Mail Privacy Protection) loads every image when the email arrives, so many "opens" would be fake, while other
  apps block images and hide real ones. Outreach shows *Not tracked* rather than a misleading number. Turning opens on
  would take: the agent adding an image link per email (with its `email_id`); a public route that serves the image and
  records the open (an Edge Function, ideally behind a tracking subdomain of the sending domain), telling Apple's
  automatic loads apart from real ones; a new migration with the open columns on `outreach_emails` (written by that
  route with the secret key, like the sync); the same rule in `outreach_daily()` and `outreachDaily()`; and the KPI.
  Only worth it once the domains are warmed up.
- **Tests**: `scripts/test-db.mjs` phase 7 (who reads and writes each table, no client writes to `outreach_emails`,
  the two guards, the RPCs against the JS rules, re-run, realtime); `scripts/test-sync.mjs` (mapping, the store actions
  refused as in RLS, `src/lib/outreach.js`, seed and `migrate`); `scripts/test-google.mjs` (`outreach-sync` with
  Google and Supabase mocked).

## 13. 0007: boards under Outreach and Clients

- **Owner's ask**: Outreach and Clients get sub-menus like Marketing's, with the standard board layout (Table / Kanban /
  Calendar; groups; People, Status, Priority, Due). Outreach: the email dashboard, then **Sales Tasks**; Clients: the
  client list, then **Demos** and **Previews**. Admins add, rename, order and delete their team boards as on Marketing.
- **Owner's decisions**: each module's own page stays first in its menu (**Email dashboard**, **Clients**); the boards
  follow the module's access level in Settings → Team, with no setting of their own (Outreach: staff None by default;
  Clients: staff View, so they read Demos and Previews until given Edit).
- **Database** (in `0007_outreach.sql`, before it first ran): the three checks that list the board modules
  (`boards_module_check`, `board_groups_board_key_check`, `items_board_key_check`) gain `outreach` and `clients`, and
  the starting boards (Sales Tasks; Demos, Previews), each with a *To do* group, are made in the same statement, only
  while the boards check doesn't list them yet: a re-run never brings back a starting board someone renamed or deleted.
  Nothing else changes: 0006's `board_level()`, policies and triggers already work per module, so a team board has
  its module's level and a task or group stays within its module (`same_audience`).
- **App**: `BOARD_MODULES`, `STARTING_BOARDS`, `FIRST_GROUP` (`src/lib/boards.js`), `BOARD_SCHEMAS` (the standard
  columns, `src/data/boards.js`), `BOARD_KEYS` (`schema.js`) and the timesheet categories gain both modules.
  `MODULE_HOMES` names each module's own page: `#/outreach` is the email dashboard and `#/clients` the client list
  (with their tabs as before); `#/outreach/<board id>` and `#/clients/<board id>` are boards, and a board that's gone
  leads back to the module's page (`resolveBoard()` gives them no default board). The sidebar lists the page, then
  the boards, then **New board** (admins); the mobile bar shows the same chips.
- **Demo**: Sales Tasks, Demos and Previews with example tasks; `migrate()` adds a module's starting boards to older
  saved demo data once (`seededBoards` remembers it, so a deleted one stays deleted).
- **Tests**: `scripts/test-db.mjs` check 58 (the starting boards once, the widened checks, who reads and writes, tasks
  staying in their module, re-runs); `scripts/test-sync.mjs` (the starting boards against 0006 and 0007, no default
  board for Outreach and Clients, the seed and `migrate()`, access by module level).

## 14. 0008: Pipeline — Opportunities → Contacted → First meetings → Demos; editable deals; Work in Progress

- **Owner's ask**: deals editable; Won replaced by **Contacted**, between Opportunities and First meetings.
- **Owner's decisions**: **Make client** is on the **Demos** column (the last); a deal made a client leaves the board (it
  lives in Clients) and counts in the **Made clients** KPI (was Won). Existing Won deals: those made clients stay off the
  board, the rest move to Demos. Editing a deal is Pipeline edit (admins, and staff given Edit), as moving one always was.
- **Stages**: `DEAL_STAGES = ['Opportunities', 'Contacted', 'First meetings', 'Demos']` (`src/data/boards.js`).
  `deals.stage` is free text (no check); `dealStage(deal)` shows a stage the board doesn't have in Demos for the old Won
  (an old browser tab may still write one) and in Opportunities otherwise, so no deal goes missing.
- **Database** (`0008_pipeline_stages.sql`): `update deals set stage = 'Demos' where stage = 'Won'`, and
  `contact_pipeline()` as 0003's with one change: a booking moves a deal to First meetings from Opportunities **or
  Contacted** (never back from later stages). Safe to re-run, also statement by statement.
- **App**: each card has **Edit** (Pipeline edit) opening **Edit deal**: organisation, sector, value, owner, priority,
  next step and stage, **Delete deal** (asks first) and, on Demos, **Make client**. Saving sends only the fields changed
  in the form, so a change made meanwhile (by a teammate or the booking automation) stays; the form closes if the deal is
  deleted or made a client meanwhile. **Make client** (on a Demos card, or in Edit deal once the stage is Demos) asks
  first (“Make <name> a client?”, closed if the deal is deleted or made a client meanwhile); in Edit deal it saves the
  form's changes first, so a corrected name is the client's name. `convertDeal` refuses a deal already made a client
  (a teammate's convert that has reached this browser). Keyboard focus returns to the deal's Edit button (or New deal
  when it's gone). Store actions `updateDeal(id, patch)`
  (cleaned by `cleanDealPatch()`: text trimmed, a value of 0 or more, a known priority and stage, an owner who is a user)
  and `removeDeal(id)`; `moveDeal` refuses an unknown stage. Demo mode's `contactPipelineLocal()` follows the same
  booking rule; imports map won / signed / quote / contract / client wording to Demos, contacted / emailed wording to
  Contacted, and negated wording (“Not signed”, “Uncontacted”) to Opportunities;
  `migrate()` moves saved demo deals at Won to Demos.
- **Work in Progress** (owner's ask: a projects-style list under the Pipeline, columns Client, Details, Status, Contact):
  a team board of a new board module, `pipeline`, shown on the Pipeline page under the deals (not in the sidebar:
  `PAGE_BOARD_MODULES`). Its schema (`BOARD_SCHEMAS.pipeline`) calls a row a **Client** (`item`), with **Details** (a
  new `text` column type, typed in place), **Status** and **Contact** (the `people` column, so a row shows in its
  contact's My Work). No dates, so no Calendar view or sort by due. It follows the Pipeline level like any team board
  (admins edit; staff read it at the default View); on the page its admin options are Rename only. 0008 widens the
  three board-module checks to `pipeline` and starts Work in Progress with an *Active* group, in one statement, only
  the first time (a re-run never brings back a deleted one). Imports to it map a Details column to `details` and a
  Client or Organisation column to the name; **New client** adds a row called “New client”. Details keeps line breaks
  (typed in the drawer; the table cell shows the first line); its time
  counts towards Clients in the suggested timesheet.
- **Tests**: `scripts/test-db.mjs` checks 59–63 (0008 re-runs, Won → Demos, the booking rule, who edits and deletes,
  Work in Progress); `scripts/test-sync.mjs` (stages and `dealStage()`, `cleanDealPatch()`, the booking rule, import
  mapping, Work in Progress's columns and import, seed and `migrate()`).

## 15. 0009: the team Calendar, Google Calendar meetings, and a board's 3-month calendar

- **Owner's ask**: a team calendar under My Work: client meetings, events, content posting, reminders and due dates
  (everything with a date on a task or an event), twelve months, each month a block that opens and closes like a
  board's group, each line a week from Monday; finished months go to an archive at the bottom; everyone's Google
  Calendar meetings pull through. And a running 3-month calendar on Posting schedule, above its tasks, of the posts by
  due date (they also feed the team calendar).
- **Owner's decisions**: on the Calendar go board tasks with a due date (whatever the viewer can see), Google meetings,
  events added on the Calendar, and invoice due and contract dates for people with Clients access; not My Work to-dos.
  Teammates see Google meetings' titles and times; Private or Confidential ones show as **Busy**; declined and
  cancelled ones are left out. The 3-month calendar is a board switch (on for Posting schedule to start; admins switch it
  on or off for any team board with dates), so a rename keeps it. Calendar sits between My Work and Projects.
- **No module key**: the Calendar only gathers what each source already lets the viewer see, with that source's rule
  (`collectEntries()` in `src/lib/calendar.js`, which demo mode needs as its state holds everyone's data; RLS does it in
  live mode): board tasks on boards they can see (`canViewBoard`; tasks on a board with its calendar on are *posts*),
  the team's events and Google meetings for everyone, invoices (not Void) and contracts (not Cancelled) only with
  Clients access. Timed events and meetings sit on their start day in the viewer's own time zone.
- **Database** (`0009_calendar.sql`):
  - `calendar_events` (synced, realtime): `kind` meeting | event | reminder, `title` (≤ 200), `day`, `end_day` (an
    all-day event over several days), `starts_at` / `ends_at` (null for all day), `people uuid[]`, `created_by` (set by
    a trigger, kept on update). Any active teammate adds one; the one who added it or an admin edits and deletes it.
  - `calendar_meetings`: the Google meetings, written only by the `google` function (service role) and read by staff on
    demand, never in synced state. Title ('' when busy), busy, all day, start and end dates (inclusive) and instants;
    unique per person and Google event. Nothing else of a meeting is stored.
  - Sharing is an explicit choice: `private.google_accounts.calendar`, set only by `calendar_share()` (the function, after
    a **Connect Google Calendar**) and cleared by `calendar_stop()` (**Stop sharing**: the flag off, or a calendar-only
    connection removed). Someone shares only while that flag is on **and** their stored Google access has the calendar
    scope. Google returns every scope granted before (`include_granted_scopes`), so the scope alone would turn sharing
    back on when an admin reconnects Gmail and Drive in Settings.
  - `private.calendar_sync` (when each person last synced, their error, whether they must reconnect) behind
    `calendar_status()` for staff; `calendar_claim()` / `calendar_save()` for the function only (`calendar_save` locks
    the person's rows first, so a disconnect at the same moment can't leave meetings behind). A person's meetings go
    when they stop sharing, disconnect Google, their Google access loses the calendar, or they're deactivated
    (`calendar_forget()`).
  - `google_me()` also says `calendar` (they share their Google Calendar) and `business` (Gmail and Drive allowed).
  - `boards.calendar`: added and turned on for the Marketing team board *Posting schedule* in one statement, the first
    time only (a re-run never turns it back on). Admins change it (the boards update policy).
- **Google** (`supabase/functions/google`): **Connect Google Calendar** is for anyone (connect with purpose
  `calendar`: scopes `openid email …/calendar.readonly`, with the scopes already granted kept, so an admin keeps Gmail
  and Drive), comes back to the Calendar and then turns sharing on (`calendar_share()`); a plain connect never does.
  Send, contract and a plain connect stay admins only. `calendar-sync` (any
  staff caller) claims everyone whose last sync is over 10 minutes old (1 minute with **Sync now**), so two people
  opening the Calendar at once sync each person once; reads each one's primary calendar from the start of last month to
  the end of month +11 (Sydney), recurring events as their instances, at most 10 pages of 2,500; and saves their
  meetings, removing those gone from Google inside that window. One person's failure (Google refused: *Reconnect*)
  never stops the others.
- **App**: **Calendar** (`src/pages/Calendar.jsx`): New event (`EventModal`: kind, title, day, all day or start and end
  time, an end before the start being the next day, people; others' events read only), filters by person and kind, the
  Google menu (connect with a short warning of what teammates see, or **Reconnect** when Google refused yours; when it
  last synced, who shares theirs, Sync now, Stop sharing), twelve `MonthBlock`s from this
  month (this one and the next open; a row per week, Monday first, the week number; other months' days shaded and empty;
  meetings and events before tasks on a day, four entries, then *+N more*; on a phone a card per week) and the **Archive** (finished months back to the
  earliest dated thing, newest first; their meetings load when it opens). A task opens in its drawer (read only unless
  the viewer can edit its board), an event in its form, a meeting in a short summary, an invoice or contract on Clients.
  Opening the page syncs Google when the last sync is over 10 minutes old. Boards with `calendar` on show
  `BoardCalendar` above their tasks: this month and the next two (`MonthGrid`, which the board's Calendar view also
  uses), following the board's search and filters. Board options: **Show calendar** / **Hide calendar** (admins).
- **Tests**: `scripts/test-db.mjs` phase 9 (0009 re-runs, the board switch once, who adds, edits and deletes events,
  meetings read only, the claim and save rules, forgetting, function privileges); `scripts/test-sync.mjs` (the
  mapping, `src/lib/calendar.js`: weeks, months, the Archive, time zones, each source's access, multi-day events,
  `cleanCalendarEvent()`, seed and `migrate()`); `scripts/test-google.mjs` (calendar connect and callback, the sync's
  query, filtering and privacy, reconnect, the page cap).
- **Not in this build**: a sync on a timer (it would need `pg_cron` and `pg_net` calling the function) and reading
  everyone's calendar without each person connecting (Workspace domain-wide delegation, with a service-account key
  kept in Supabase secrets).

## 16. 0010: Outreach from Gmail — cold emails counted from each mailbox

- **Owner's ask**: measure every cold sales email going out to prospects from our email accounts, straight from the
  mailboxes. The agent's Google Sheet "is just a reference to save all the sent prospects".
- **Owner's decisions**: Gmail is the source of the numbers for a mailbox once it is connected; the sheet stays the
  agent's log (meetings, and the organisation, role and tier shown with a prospect). Mailboxes are @assetstackai.com
  accounts now (the Google client is **Internal** to that Workspace); @assetstack.org and @assetstackai.com.au come
  later, in a **separate** Workspace. Cortex may read full messages (`gmail.readonly`) but stores **no message text**
  for now; sorting replies (interested / not) is decided later, so it detects only a reply, an auto-reply or
  out-of-office, and a bounce. Cold = **new outside contacts**: a thread we start with someone outside AssetStack who
  isn't a client or known contact and has never written to that mailbox, plus our follow-ups in it. Admins connect each
  mailbox in **Settings → Outreach**.
- **What a cold thread is** (decided once, the first time the function sees the thread; a stored thread stays cold):
  its first message is ours (`SENT`), not a reply or forward (no `In-Reply-To`, no `Re:` / `Fw:` subject) and not a
  calendar invite; it goes to 1–5 outside people in To/Cc (Bcc lists fall out); none of them is a colleague
  (`assetstackai.com`, `assetstack.org`, `assetstackai.com.au`, the mailboxes' and profiles' domains), a known email
  (profiles, client contacts, client access, invoice recipients), at a client's domain (free-mail domains aside) or a
  no-reply address; and the prospect (the first outside To, else Cc) has never written to this mailbox before it
  (`from:<prospect> before:<first email>`). Outreach contacts (the prospects in Pipeline) are deliberately not excluded.
  In a cold thread each message of ours is `sent` (the first email and each follow-up) and each of theirs is `reply`,
  `auto` (Auto-Submitted, X-Autoreply / X-Autorespond, Precedence auto_reply / bulk / junk, an out-of-office subject)
  or `bounce` (mailer-daemon / postmaster, a delivery-status report, X-Failed-Recipients); colleagues, no-reply senders
  and calendar notifications count as nothing.
- **Database** (`0010_outreach_gmail.sql`):
  - `private.outreach_gmail` (a mailbox's Google connection: `client` key, `email`, refresh token, scopes, who connected
    it and when) and `private.outreach_gmail_sync` (claim, the run that holds it, last sync, `ready_at` once the first
    read is done, the Gmail `history_id`, `scan_from`, the threads still to read, error, reconnect). Unreadable from
    the app.
  - `outreach_threads` (one per mailbox and Gmail thread: sender, prospect's address and name, recipients, the subject
    of our first email, first email and day, last email, emails sent, the first reply / auto-reply / bounce and their
    days, `reply_kind` '' for the later reply sorting) and `outreach_messages` (each message's kind, instant and day).
    Read with `can_view('outreach')`, written only by `outreach_gmail_save()` (service role); not synced, not realtime.
    Days are Sydney days, worked out in SQL. Never stored: bodies, snippets, reply subjects, any thread that isn't cold.
  - For the function only: `outreach_gmail_connect()` (the Google account must be one of the mailbox's addresses and the
    caller an active admin), `outreach_gmail_known()` (the exclusion lists), `outreach_gmail_claim()` (10 minutes
    between reads, 1 with Sync now; three mailboxes a run), `outreach_gmail_job()` and `outreach_gmail_save()` (locks
    the mailbox and its connection first, the newer run wins, an error writes nothing).
  - For the app: `outreach_gmail_status()` (Outreach viewers: connected, address, synced, ready, threads left, error,
    reconnect; never a token), `outreach_gmail_disconnect()` (admins), and `outreach_gmail_daily()` /
    `outreach_gmail_breakdown()` / `outreach_gmail_threads()` (security invoker; the last adds the sheet's organisation,
    role, tier and reply status from the row with the thread's id, else the prospect's newest row). They equal
    `gmailDaily()` / `gmailBreakdown()` / `filterThreads()` in `src/lib/outreach.js` (demo mode), checked by
    `scripts/test-db.mjs`.
  - Forgetting: disconnecting, reconnecting as another account or without Gmail read, or taking the connected address
    off the mailbox deletes its threads and sync state; deleting the mailbox cascades. Switching it off keeps its
    numbers and stops reading.
- **Google** (`supabase/functions/google`): connect with purpose `mailbox` (admins; the mailbox active with an
  @assetstackai.com address) asks for `openid email …/gmail.readonly` only (`include_granted_scopes=false`, so the token
  carries nothing else), `prompt=consent select_account`, `hd` and `login_hint` the mailbox's address. The callback
  returns to `#/settings?tab=outreach&gmail=<result>&mailbox=<id>` (connected, denied, wrong_account, gmail_scope,
  no_refresh_token, or error with reason client / exchange / save). `outreach-gmail-sync` (Outreach view) claims up to
  three mailboxes and, within about a minute: on the first read lists 90 days of sent mail
  (`in:sent after:…`), after that follows Gmail's history from the stored point (sent mail, and answers in stored cold
  threads; when Google says the point is too old it scans again from the last sync); then reads the queued threads,
  newest first, as metadata only (named headers, never `snippet`, `full` or `raw`), up to 500 a run, saving every 100,
  and answers `{ claimed, synced, failed, more, pending }` so the page runs it again while `more`. One mailbox's
  failure never stops the others; Google refusing the mailbox asks for **Reconnect**. Logs carry counts only.
- **App**:
  - **Outreach** (`Emails.jsx`): the numbers are `mergeDaily()`: a mailbox whose first read is done counts Sent (each
    cold email, follow-ups too), **Prospects** (threads started), Replies, auto-replies and Bounces from Gmail and only
    Meetings from the sheet; others, and Unassigned, stay on the sheet (each email a prospect). Reply rate = replies ÷
    prospects. Mailbox cards counted from Gmail carry a mail mark. The Breakdown adds **Prospects** (replied, auto-reply,
    no reply yet, bounced) and **Emails per prospect** (1, 2, 3, 4 or more). The list (`EmailList.jsx`), for Gmail
    mailboxes: **Sent / Replies / Bounced**, a row per prospect thread (the sheet's organisation when it matches, the
    contact, subject, emails sent, the outcome; the drawer adds Open in Gmail), and the sheet's own list as **Sheet**.
  - `SyncStatus.jsx`: opening Outreach asks Gmail to sync (the function skips mailboxes read in the last 10 minutes);
    **Sync now** syncs the sheet and Gmail together; a first read chains runs while there's more (at most 30). The line
    adds Gmail's state (reading, *N left*, synced, or a mailbox's error).
  - **Settings → Outreach**: each mailbox row has **Connect Gmail** (a confirm says what is read and kept), then
    *Gmail: address · synced …* or *Reading Gmail · N left*, **Reconnect Gmail** after an error, **Disconnect Gmail**
    (confirm). The result of the trip to Google shows on that row, and a connect starts the first read at once.
  - Store: `outreach.gmailStatus()`, `gmailDaily()`, `gmailBreakdown()`, `threads()`, `syncGmail({ force })`; actions
    `connectMailboxGmail()`, `disconnectMailboxGmail()` (admins), `syncOutreachGmail()`. Demo mode: David's and Josh's
    mailboxes are connected with seeded threads (from their sheet rows, with follow-ups, plus three sent by hand), Sarah's
    stays on the sheet; Connect says live mode only; Disconnect, removing the address or the mailbox forgets as live does.
- **Tests**: `scripts/test-db.mjs` phase 10 (re-runs, RLS and grants, connect, claim, save, Sydney days, sticky cold,
  every forget path, the known lists, daily / breakdown / threads against the JS); `scripts/test-google.mjs` (mailbox
  connect and callback, the gate, first read, history, the 404 rescan, caps and chaining, classification and the cold
  rule, privacy: metadata only, no tokens or addresses in logs); `scripts/test-sync.mjs` (the lib, the demo seed,
  `migrate()`).
- **Later, not built**: the separate Workspace (@assetstack.org, @assetstackai.com.au) needs a second **Internal**
  Google client in a Cloud project under that Workspace; each connection already stores its `client` key, so connect
  would pick the client by the mailbox's domain (a `GOOGLE_CLIENTS` secret). Making the one client External instead
  would need Google's verification and a yearly security assessment for Gmail access. Reply sorting fills
  `reply_kind`, which needs reading the reply's text at sync time.
