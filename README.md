# Cortex

AssetStack's internal operations platform. Repository: `asset-stack/cortex`. Treat it as public: demo data
uses placeholder people at `example.com`, and no keys or `.env` files are ever committed.

One workspace for the team's daily work, the departments and team chat:

| Area | What it does |
|---|---|
| **My Work** | Each person's daily to-do list: work admins assign, daily routines (generated each morning), automation follow-ups, carried-over items, the board items they're on and @mentions. Day navigator; admins pick anyone and add to their day. **Log time** for any day. **Tools**: each person's own logins and links (Gmail, Apollo, Claude…: link, username, how to sign in; no passwords), set up by admins from presets |
| **Projects / Marketing** | Boards listed under each module in the sidebar. Projects: each person's own page (*David’s Projects*; the SuperAdmin sees everyone's, admins their own and staff's, staff their own), then the team boards (Landing Page, Tender Portal, General). Marketing: Daily Automation, Posting schedule, Campaigns, Events. Admins add, rename, order and delete team boards. Each board is Monday.com-style: grouped tables with coloured status/label cells, Kanban (drag to change status), calendar, and a task drawer with subtasks and updates. Whoever can edit a board renames and deletes its groups, tasks and subtasks, and moves tasks between groups and between team boards; updates are edited or deleted by their author or an admin. A **People** column assigns work to several people, and an `@Name` in an update adds that person |
| **Outreach** | Contacts CRM with owner and status, Gmail activity feed, sequences, approvals queue, and the Claude outreach agent (draft, then send or queue). A contact moving to *Replied* or *Meeting booked* creates or advances its deal in Pipeline and gives its owner a follow-up to-do |
| **Pipeline** | Deal Kanban: Opportunities → First meetings → Demos → Won, with *Make client* on won deals; deals that came from a contact are marked |
| **Clients** | Tabs **Clients · Invoices · Money in · Expenses · Usage**. Client cards and a drawer with overview (platform link, contacts with a **Billing** switch), notes, tasks, invoices (line items, GST 10%, print, PDF), **billing plans**, **contracts**, monthly **usage** with credits imported from each platform's export, and access. Plans raise invoices *Awaiting approval* (and an **Approve invoices** to-do); admins **Approve and send**, which emails the PDF tax invoice from their own Gmail to the billing contacts (or approve, send the PDF yourself and **Mark as sent**). New clients get a **Prepare contract** to-do; **Create contract** fills the Google Doc template into the contracts folder, signed with Google eSignature. Admins upload the weekly bank screenshot and **Mark paid**, log expenses with receipts and track software costs |
| **Timesheet** | At 16:30 on weekdays (each person's own time zone) staff are asked to fill eight hourly blocks, pre-filled from what they did that day. Admins review everyone's week in Settings |
| **Team chat** | Slack-style dock at the bottom of every page: groups, create group, add members, @mentions with autocomplete and highlight, unread and mention counts |
| **Settings** (admins) | **Team** (roles, active flags and staff module access; SuperAdmin only), **Routines**, **Timesheets**, **Business** details for invoices, CSV **Import** from the old platform |

### Roles and access

| | SuperAdmin / Admin | Staff (default) |
|---|---|---|
| Projects | Edit | Edit (team boards and their own page) |
| Marketing | Edit | Edit |
| Outreach | Edit | None |
| Pipeline | Edit | View |
| Clients | Edit | View: no money in, expenses or software costs; can't approve, send or mark paid |
| My Work, team chat, timesheet | Yes | Yes |
| Settings | Yes (Team read-only for Admins) | No |

The SuperAdmin changes roles, active flags and each staff member's access (None / View / Edit per module) in
**Settings** → **Team**. The same rules run in the database (row-level security) and in the screens, which hide
modules at None and turn read-only at View. The demo team is David (SuperAdmin), Josh (Admin) and Hello (Staff).

Invoice and other business dates follow Sydney time; each person's own day (My Work, follow-ups, the timesheet
prompt) follows their own time zone, which **Settings** → **Team** shows next to their local time.

## Demo and live mode

The mode is picked at build time from two environment variables (full design: [`docs/BACKEND.md`](docs/BACKEND.md)).

| Mode | When | Data | Sign-in |
|---|---|---|---|
| **Demo** | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` not set (CI, local by default) | The browser's `localStorage`, seeded from `src/data/seed.js` | None. The avatar menu switches who you are viewing as; *Reset demo data* restores the seed |
| **Live** | Both set (Cloudflare Pages) | Supabase Postgres with realtime, so staff see each other's changes | Google, `@assetstackai.com` accounts only |

Screens only ever call `useStore()` from `src/data/store.jsx`, with the same state shape in both modes. In live
mode a sync engine (`src/data/backend/`) turns each change into row writes and applies other people's changes
as they arrive; the dot on the Cortex logo shows saved / saving / error / offline. Access is enforced by
row-level security in Postgres (`supabase/migrations/`); the screens apply the same rules, but the database is
what protects the data.

## Running it

```bash
git clone https://github.com/asset-stack/cortex.git && cd cortex
npm install
npm run dev       # demo mode on http://localhost:5173
npm test          # sync-engine and database checks, no network needed
npm run build     # static output in dist/
npm run preview   # serves dist/ on http://localhost:4322
```

### Live mode locally

```bash
cp .env.example .env.local   # git ignores it
```

Fill in the project URL and the anon (publishable) key from the Supabase dashboard, then `npm run dev`.
`http://localhost:5173` must be in the project's Auth redirect URLs (see [`DEPLOY.md`](DEPLOY.md)). Delete
`.env.local`, or empty both values, to go back to demo mode. Never put the `service_role` / secret key in it.

### Tests

`npm test` runs two scripts. CI runs it, then a demo-mode build, on pull requests and pushes to `main`:

- `scripts/test-sync.mjs` checks the state ⇄ row mapping round trip for every table, the diff for common
  edits, the sync queue (coalescing, ordering, retry) against a fake Supabase client, the access helpers, the
  timesheet suggestions and the demo-mode automations.
- `scripts/test-db.mjs` runs `0001_cortex.sql` to `0004_clients_google.sql` in order in PGlite (Postgres in WASM),
  as on the live database, and checks the sign-up domain gate, roles and module access, the board merge, the
  automations, invoice generation, time zones, client contacts and contracts, Google token privacy, finance privacy
  and row-level security as different users.
- `scripts/test-invoice.mjs` checks the tax invoice model, the PDF and the contract helpers;
  `scripts/test-google.mjs` checks the `google` Edge Function (connect, callback, send, contract) with Google and
  Supabase mocked.

## Deploying

[`DEPLOY.md`](DEPLOY.md) has the click-by-click setup: Supabase (Sydney), Google sign-in, Cloudflare Pages,
the custom domain, inviting staff, importing old data, and a security checklist. A database set up before the
team workflow needs one upgrade step (`0002_team_workflow.sql`, see *Upgrading an existing project*), then each
newer migration in order (`0003_…`, `0004_…`). Invoice email and contracts need the Google setup in DEPLOY.md
section 11. Security
headers for Cloudflare Pages are in `public/_headers`.

## Still stubbed

- **Outreach Gmail.** Invoices are emailed for real (the `google` Edge Function, each admin's own Gmail), but the
  Outreach feed and its sends still use `listThreads` / `sendEmail` in `src/integrations/gmail.js`: "sent" emails
  are only logged to the feed for now.
- **Claude agent.** A server endpoint calls the Anthropic Messages API with the AssetStack voice guide and the
  contact's history. Replace `draftOutreach` in `src/integrations/claudeAgent.js`. Drafts come from templates
  for now. API keys never go in this frontend.

## Design

Smoked "liquid glass" panels over the chrome-glass backdrop (`public/media/bg-liquid.webp`), using Inter Tight and AssetStack indigo `#2337EE` from the marketing site. Design tokens (`.glass`, `.glass-rim`, `.glass-solid`, `.chip`, `.pill`, `.btn-primary`) are in `src/styles/index.css`.
