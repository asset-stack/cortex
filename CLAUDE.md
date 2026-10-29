# Cortex: notes for Claude

Cortex is AssetStack's internal ops platform (Vite + React 18 + Tailwind 3 + lucide-react, Supabase in live mode).
It is separate from the marketing site (`AssetLanding`) and from the signed-in product
(bunburycouncil.assetstack.site). The backend contract is `docs/BACKEND.md` (phase 1) plus `docs/PHASE2.md`
(team workflow: roles, module access, the Dashboard (was My Work), finance, timesheets, boards, Outreach, Calendar,
Outreach from Gmail, owners and priorities, Team, task emails, the CRM);
setup steps are in `DEPLOY.md`.

## Rules
- All data access goes through `src/data/store.jsx` (`useStore()` → `{ state, actions }`), in both modes. Screens
  never call Supabase or touch localStorage; only the store, `src/data/backend/*` and the sign-in screen
  (`src/components/auth/AuthGate.jsx`) do, plus the timesheet prompt's snooze flag (helpers in
  `src/lib/timesheet.js`). Keep the state shape in `docs/BACKEND.md` §1 / `docs/PHASE2.md` §2 and update the
  mapping in `src/data/backend/schema.js` when it changes.
- Keep demo mode working. Without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` the app runs on localStorage
  and seed data, and CI builds it that way (no env vars), so the build must never require them.
- Supabase schema changes go in a new numbered file in `supabase/migrations/` (`0003_….sql`, …). **Never edit a
  migration that has been applied** (`0001`–`0012` are live in production; `0013`–`0015` are written, not yet run): fix
  forward in the next file (`0016_….sql`). A migration must never mention `module_level` unless it redefines it
  (`scripts/test-sync.mjs` reads the staff defaults from the newest file that does). Every table
  keeps row-level security on with policies that require `is_staff()` (directly or through `is_admin()` /
  `can_view()` / `can_edit()` / the board helpers), and is added to the `supabase_realtime` publication if it is synced. Extend
  `scripts/test-db.mjs` to cover it.
- **A release must not need its migration to open** (the 0012 outage: the app reached production before the file ran
  and every page failed to load). A new synced table gets `since: '<file>'` in `TABLES` (`schema.js`): until it exists
  the sync engine leaves it out (`probe()`), the app hides what needs it (`useStore().missing`) and admins see which file
  to run. A new column on an existing table needs the same care (the app must cope without it) or a release after the
  migration. From `0013`, a migration ends (after `commit;`) with `select 'Cortex 00NN applied' as done;`.
- **Before publishing a release that needs a migration, verify it ran**: ask the owner for the result of
  `select to_regclass('public.<new table>')` (or the `done` row, or a check that fits the change), never just "done".
- Roles are `superadmin | admin | staff`. Admins (superadmin or admin) always have edit; only the SuperAdmin
  changes roles, active flags and module access. Money in, expenses and software costs are admins only, and
  staff never approve, send or mark invoices paid.
- **Access levels are enforced twice, with the same rules**: in RLS through `public.can_view(module)` /
  `public.can_edit(module)` (the real enforcement), and in the UI through `useAccess()` from `src/lib/access.js`
  (nav hides modules at `none`, screens are read-only at `view`, and store actions refuse what the user can't
  do). A change to one side needs the same change to the other. Boards (0006) have their own pair:
  `board_level()` / `can_view_board()` / `can_edit_board()` ⇄ `boardLevel` / `canViewBoard` / `canEditBoard`, and
  `sees_person()` ⇄ `seesPerson` (whose personal Projects page you may open).
- **Boards are records**, not code: `state.boards` is an array of team boards and personal Projects pages
  (`docs/PHASE2.md` §11, §13), and board store actions take a board id. Board modules are Projects, Marketing, Outreach,
  Clients and Pipeline (`BOARD_MODULES`); Outreach's and Clients' menus start with their own page (`MODULE_HOMES`), and
  Pipeline's boards (Work in Progress) sit on its page under the deals, not in the menu (`PAGE_BOARD_MODULES`). Admins add
  new team boards in the app; personal pages come and go with their person.
- **Board tasks have one home and one Owner** (`docs/PHASE2.md` §17, §18, §20): a task lives on one board (the Dashboard,
  Team pages and a client's page are views of it, never copies; its breadcrumb is `whereOf()`). The owner column keeps
  `values.people` as `[id]`, priority is `PRIORITY` (Urgent → Low, with `PRIORITY_HINTS`), and the rules for handing
  over and accepting, the Dashboard and Team lists, Needs attention, task mentions, a client's tasks and Do today live
  in `src/lib/work.js` (only `nextValues()` / `acceptedValues()` set `assignedBy` / `assignedAt` / `acceptedAt`). An
  `@Name` in an update never changes who is on a task. The Projects module is shown as **Operations** (`MODULE_LABELS`);
  its key stays `projects`. **Also on** (`values.also`, §20) puts others on a task without making it theirs: it never
  counts in `workload()`, never waits on them, never lists the owner. A task's **Department** is `departmentOf()` (a
  module key; '' = its board's). Both are `team` columns: render a board's columns from `schemaOf(board)`, never
  `BOARD_SCHEMAS[module]` (personal pages don't have them), and save values through `boardValues()`.
- **CRM profile (0012)**: a deal's or client's notes, meetings and links are `crm_entries` (`state.crmEntries`; rules in
  `src/lib/crm.js` ⇄ 0012's policies and triggers). An entry on a client follows Clients access, one on a deal that isn't
  a client yet Pipeline's; its author or an admin changes it. Make client gives a deal's entries its client in the
  database (`crm_carry_to_client`; `carryDealEntriesLocal()` in demo mode, never client-side in live mode). A meeting
  keeps a link to its notes and a summary: Cortex never reads the Doc. Next steps are board tasks (`values.deal` /
  `values.client`, `dealTasks()` / `clientTasks()`), never entries.
- **The CRM (0014)**: Pipeline is accounts (`state.accounts`), the people at them (`state.crmContacts`, table
  `crm_contacts`; not Outreach's `contacts`) and deals on them, all on the Pipeline access level. Stages are
  `DEAL_STAGES` (the board's open ones) plus Lost; Won is Make client. Old stage names are shown through `dealStage()`
  / `OLD_DEAL_STAGES`, never written. `stage_at` is the database's (the `deal_stage_at` trigger). Currencies are never
  converted (`totalsIn()`). A column added to an existing table goes in that table's `later` (with its migration's new
  table) so the app saves the rest of the row before the migration runs. The outreach automation's account and person
  rules are `contact_pipeline()` ⇄ `contactPipelineLocal()` / `lifecycleAfter()`; 0014's one-off steps ⇄
  `crmBackfillLocal()`. Stage history (0015, `deal_stage_history`) is written only by the `log_deal_stage` trigger
  (`readOnly` in `TABLES`, so the app never writes it; `logStageLocal()` in demo mode). Reports are `src/lib/reports.js`;
  what needs someone is `needsYou()`; duplicates are `similarAccounts()` / `similarPeople()`.
- **A new module gets a module key**: add it to `MODULES` and `STAFF_DEFAULTS` in `src/lib/access.js`, to the
  `module_access.module` check and the defaults in `public.module_level()` (in a new migration), give its tables
  `can_view` / `can_edit` policies on that key, and set `module` on its `NAV` entry in `Sidebar.jsx`.
- **Outreach (0007)**: `outreach_emails` is written only by the `google` function's sheet sync (route `outreach-sync`,
  secret key); the app reads it through `useStore().outreach`, never in synced state, and never writes it. A row is a
  contact; its numbers count emails (rows grouped by Gmail message) and follow one rule set: `outreach_daily()` /
  `outreach_breakdown()` ⇄ `src/lib/outreach.js` ⇄ the function's Summary tab. The sync never writes the agent's tab
  and never deletes tabs (it writes Summary, Notes and one tab per mailbox). Mailbox addresses and the sheet link are
  data (Settings → Outreach), never code. Cortex never sends outreach email (the agent does).
- **Outreach from Gmail (0010)**: admins connect each mailbox's Gmail in Settings → Outreach (connect purpose
  `mailbox`: `gmail.readonly` only, `include_granted_scopes=false`, signed in as one of that mailbox's addresses). Only
  the `google` function's `outreach-gmail-sync` writes `outreach_threads` / `outreach_messages` (through
  `outreach_gmail_save()`); the app reads them through `useStore().outreach`, never in synced state. Store no message
  text: headers of cold threads only (who, when, our first subject), never bodies, snippets or reply subjects, and no
  addresses, subjects or tokens in function logs. A cold thread is one we start with a new outside contact (the cold
  rule in `docs/PHASE2.md` §16), decided once. One rule set for the numbers: `outreach_gmail_daily()` /
  `outreach_gmail_breakdown()` / `outreach_gmail_threads()` ⇄ `gmailDaily()` / `gmailBreakdown()` / `filterThreads()`,
  and `mergeDaily()` decides which mailboxes count from Gmail (first read done) and which from the sheet. Disconnecting,
  another account, losing the scope or the address forgets a mailbox's Gmail data (triggers in live mode, `forgetGmail`
  in the store's demo mode).
- **Calendar (0009)** has no module key: `collectEntries()` (`src/lib/calendar.js`) gathers what each source already
  lets the viewer see, with that source's rule (boards: `canViewBoard`; invoices and contracts: Clients view; team events
  and Google meetings: everyone). `calendar_events` is synced (anyone adds; the creator or an admin edits and deletes).
  `calendar_meetings` is written only by the `google` function's `calendar-sync` and read only through
  `useStore().calendar`; it keeps a meeting's title and times, never its description, place, guests or link, and a
  Private or Confidential one is Busy with no title. A board's 3-month calendar is `boards.calendar`, never a name match.
  Sharing a calendar is an explicit flag (`private.google_accounts.calendar`, set only after a calendar connect, cleared
  by Stop sharing), never inferred from the stored Google scopes. Staff may use Google only to connect their calendar
  (connect with purpose `calendar`); everything else stays admins only.
- **Task emails (0013)**: the database decides who is emailed (`queue_task_assigned` / `queue_task_update` triggers into
  `private.task_mail`, and `task_mail_claim()` re-checks as the recipient when sending); the `google` function's
  `task-mail` route only sends what it claims, from the sender admin's Gmail (`task_mail_use_me`). The app never reads
  or writes the queue; `mailsOwner()` (`src/lib/work.js`) only says when to ask the function to send. Change the
  triggers and `mailsOwner()` together.
- Automations run in the database in live mode (`contact_pipeline` trigger, `ensure_todos` and
  `generate_due_invoices` RPCs) and in `src/lib/automations.js` in demo mode. Change both together; live mode
  never creates those rows client-side.
- Time zones: business dates (invoices, plan due dates) are Sydney's (`team_today()` / `TEAM_TIMEZONE` in
  `src/lib/format.js`); personal dates (My Work, follow-up to-dos, the 16:30 timesheet prompt) are the person's own
  (`profiles.timezone`, `user_today()`; the browser's day in the app). Josh is in `Asia/Tbilisi`, ops staff in
  `Asia/Manila`.
- Finance files (bank screenshots, receipts) live in the private `finance` storage bucket and are opened through
  the store's `fileUrl()` (short-lived signed links). Never make the bucket public.
- `npm test` must pass (sync mapping, database, invoice and Edge Function checks, no network).
- **This repo (asset-stack/cortex) is public; treat it as public even if it is made private.** Never commit real
  client names, emails, invoices, bank details or credentials. Seed people use `@example.com` placeholders (demo
  team: David superadmin, Josh admin, Hello staff), and real admin addresses only ever go into the Supabase SQL
  editor, not `supabase/setup-admins.sql`.
- Never commit `.env` / `.env.local` or any key. Only `.env.example` (empty values) is tracked. The anon /
  publishable key is the only Supabase key the frontend may use; the `service_role` / secret key never goes
  anywhere in this repo, CI or Cloudflare.
- No secrets in the frontend. Google (invoice email from the approver's own Gmail, contract Docs in Drive) goes
  through `src/integrations/google.js` → the store's `invoke()` → the `google` Edge Function
  (`supabase/functions/google/index.ts`: one self-contained, pasteable file with no imports, tested by
  `scripts/test-google.mjs`), as does the Outreach sheet sync (`syncOutreach()` → route `outreach-sync`). Admins'
  Google refresh tokens live only in `private.google_accounts`, read by the function with the secret key, which exists
  only inside the Supabase function runtime (injected by Supabase).
- The printed tax invoice and the emailed PDF both come from `taxInvoiceModel()` (`src/lib/taxInvoice.js`); change
  invoice content there, not in one renderer. pdf-lib loads only on demand (dynamic import).
- Domain is `assetstackai.com` (never `assetstack.ai`, which belongs to another company).
- Keep copy minimal: titles and actions only, no eyebrow or subtitle text (agreed with the user on the mockup).
- Images go in `public/media/` as WebP, max 1920px, q82.
- Routing is a hash router (`src/lib/router.js`). Add new pages to `ROUTES`, `NAV` in `Sidebar.jsx`, and `App.jsx`.
- `public/_headers` sets a strict CSP for Cloudflare Pages. A new external origin (fonts, images, APIs) has to be
  added there or it is blocked in production; inline scripts are not allowed.

## Workflow
1. Edit
2. `npm test` and `npm run build`, which must pass
3. `npm run preview` (port 4322) and check in a browser at desktop width and at 390px
4. Commit and push
