# Cortex: notes for Claude

Cortex is AssetStack's internal ops platform (Vite + React 18 + Tailwind 3 + lucide-react, Supabase in live mode).
It is separate from the marketing site (`AssetLanding`) and from the signed-in product
(bunburycouncil.assetstack.site). The backend contract is `docs/BACKEND.md` (phase 1) plus `docs/PHASE2.md`
(team workflow: roles, module access, My Work, finance, timesheets); setup steps are in `DEPLOY.md`.

## Rules
- All data access goes through `src/data/store.jsx` (`useStore()` → `{ state, actions }`), in both modes. Screens
  never call Supabase or touch localStorage; only the store, `src/data/backend/*` and the sign-in screen
  (`src/components/auth/AuthGate.jsx`) do, plus the timesheet prompt's snooze flag (helpers in
  `src/lib/timesheet.js`). Keep the state shape in `docs/BACKEND.md` §1 / `docs/PHASE2.md` §2 and update the
  mapping in `src/data/backend/schema.js` when it changes.
- Keep demo mode working. Without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` the app runs on localStorage
  and seed data, and CI builds it that way (no env vars), so the build must never require them.
- Supabase schema changes go in a new numbered file in `supabase/migrations/` (`0003_….sql`, …). **Never edit a
  migration that has been applied** (`0001`–`0005` are live in production): fix forward in the next file. A migration must never mention `module_level` unless it
  redefines it (`scripts/test-sync.mjs` reads the staff defaults from the newest file that does). Every table
  keeps row-level security on with policies that require `is_staff()` (directly or through `is_admin()` /
  `can_view()` / `can_edit()`), and is added to the `supabase_realtime` publication if it is synced. Extend
  `scripts/test-db.mjs` to cover it.
- Roles are `superadmin | admin | staff`. Admins (superadmin or admin) always have edit; only the SuperAdmin
  changes roles, active flags and module access. Money in, expenses and software costs are admins only, and
  staff never approve, send or mark invoices paid.
- **Access levels are enforced twice, with the same rules**: in RLS through `public.can_view(module)` /
  `public.can_edit(module)` (the real enforcement), and in the UI through `useAccess()` from `src/lib/access.js`
  (nav hides modules at `none`, screens are read-only at `view`, and store actions refuse what the user can't
  do). A change to one side needs the same change to the other.
- **A new module gets a module key**: add it to `MODULES` and `STAFF_DEFAULTS` in `src/lib/access.js`, to the
  `module_access.module` check and the defaults in `public.module_level()` (in a new migration), give its tables
  `can_view` / `can_edit` policies on that key, and set `module` on its `NAV` entry in `Sidebar.jsx`.
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
  `scripts/test-google.mjs`). Admins' Google refresh tokens live only in `private.google_accounts`, read by the
  function with the secret key, which exists only inside the Supabase function runtime (injected by Supabase).
  Outreach's Gmail feed and the Claude agent (`src/integrations/gmail.js`, `claudeAgent.js`) are still stubs.
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
