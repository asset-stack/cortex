# Cortex

AssetStack's internal operations platform. Repository: `asset-stack/cortex`. Treat it as public: demo data
uses placeholder people at `example.com`, and no keys or `.env` files are ever committed.

One workspace for the team's daily work, the departments and team chat:

| Area | What it does |
|---|---|
| **Dashboard** (was My Work) | Each person's master task list: **Waiting on you** (tasks handed to them, until they **Accept**), **Today** (to-dos: work admins assign, daily routines generated each morning, automation follow-ups, carried-over items, and board tasks put on the day with **Do today**), **My tasks** (a card per board, e.g. *Operations › Team Tasks*, in the board's own order: the open tasks they own and the ones they're **Also on**, marked with whose they are; priority, status, due and name set right there, and dragged or moved up and down to set the board's order) and **My notes** (their own page). **New task** from anywhere. @mentions in chat and in task updates, and for admins **Needs attention** (tasks overdue, stuck, not accepted after a day, with no owner or priority). Day navigator; admins pick anyone and add to their day. **Log time** for any day. **Tools**: each person's own logins and links (Gmail, Apollo, Claude…: link, username, how to sign in; no passwords), set up by admins from presets |
| **Team** | Everyone's work on the team boards: a card per person (waiting, urgent, in progress, overdue, open, top tasks), and each person's page with their tasks and **New task for …**. Personal notes never show here |
| **Calendar** | The team calendar: everything dated in Cortex that you can see (board tasks and posts by due date, the team's meetings, events and reminders added on the Calendar, invoice due dates and contract dates with Clients access) and everyone's **Google Calendar** meetings (each person connects theirs once; Private events show as *Busy*). Twelve months from this one, each opening and closing like a board's group, a row per week from Monday; finished months move to the **Archive** at the bottom. Filters by person and kind; **New event** for anyone |
| **Operations / Marketing** (and the boards under Outreach and Clients) | Boards listed under each module in the sidebar. Operations (the Projects module, renamed): the team boards (Landing Page, Tender Portal, General; the owner renames General to BAU and adds Finance and Development). Each person's own page is their **My notes** on the Dashboard (*David’s notes*; the SuperAdmin sees everyone's, admins their own and staff's, staff their own). Marketing: Daily Automation, Posting schedule (with a running 3-month calendar of its posts above the tasks; admins switch that calendar on for any board), Campaigns, Events. Admins add, rename, order and delete team boards. Each board is Monday.com-style: grouped tables with coloured status/label cells (drag a task's handle to reorder it or move it to another group, on desktop; **Sort** puts every group in due-date or priority order), Kanban (drag to change status), calendar, and a task drawer with subtasks and updates. Whoever can edit a board renames and deletes its groups, tasks and subtasks, and moves tasks between groups and between team boards; updates are edited or deleted by their author or an admin. Each task has one **Owner** (others it involves go on **Also on**: it shows on their Dashboard, but isn't theirs to answer for), a **Department** (Operations, Marketing, Outreach, Clients or Pipeline: the board's own unless set, and a filter) and a **Priority** that says when: *Urgent* (today, one at a time), *High* (this week), *Medium* (this month), *Low* (when free); Clients boards also link each task to its **Client**, listed under **Next steps** in that client's drawer (with **Add next step**; the client's simple checklist is now **Checklist**). An `@Name` in an update shows in that person's Mentions. A task handed to someone waits on them to accept it. How the team uses it: `docs/HOW-WE-WORK.md` |
| **Outreach** | Its menu: **Email dashboard**, then its team boards (**Sales Tasks** …). The dashboard: the cold email sent from each outreach mailbox, per mailbox or all: emails sent per day, sent, prospects, replies and reply rate, bounces and meetings (opens aren't tracked yet), what became of each prospect, every email or prospect thread with a link to its Gmail thread, and the team's notes (the strategy that works). A mailbox whose **Gmail** an admin has connected is counted from Gmail: every cold email to a new outside contact, follow-ups, replies, auto-replies and bounces (Cortex keeps who, when and the subject, never the text); the others from the outreach agent's Google Sheet (the agent is a separate Claude agent), which also gives the meetings. It syncs when opened and with **Sync now**, and writes a **Summary** tab, a **Notes** tab and a tab per mailbox back to the sheet. The **Contacts** view keeps the contact list with owner and status: a contact moving to *Replied* or *Meeting booked* creates or advances its deal in Pipeline and gives its owner a follow-up to-do |
| **Pipeline** | Deal Kanban: Opportunities → Contacted → First meetings → Demos. **Edit** on each card (organisation, sector, value, owner, priority, next step, stage; delete) for Pipeline edit; *Make client* on Demos, after which the deal leaves the board (counted in *Made clients*); deals that came from a contact are marked. A deal's name opens its **profile**: **Next steps** (tasks linked to the deal on Outreach boards, with an owner, priority and due date; **Add next step**), a **Timeline** of notes and meetings (a meeting keeps its date, who attended, a link to its notes, e.g. the Google Doc, and a short summary) and **Links** (meeting notes, demo, deck, proposal, recording). *Make client* carries all of it to the client. Under the deals, **Work in Progress**: a row per client with Details, Status and Contact (Pipeline edit edits it) |
| **Clients** | Its menu: **Clients**, then its team boards (**Demos**, **Previews** …). The client list: tabs **Clients · Invoices · Money in · Expenses · Usage**. Client cards and a drawer with overview (platform link, contacts with a **Billing** switch) and the client's **profile**: next steps (their linked tasks, **Add next step**), checklist, a timeline of notes and meetings (with what came over from the deal) and links, invoices (line items, GST 10%, print, PDF), **billing plans**, **contracts**, monthly **usage** with credits imported from each platform's export, and access. Plans raise invoices *Awaiting approval* (and an **Approve invoices** to-do); admins **Approve and send**, which emails the PDF tax invoice from their own Gmail to the billing contacts (or approve, send the PDF yourself and **Mark as sent**). New clients get a **Prepare contract** to-do; **Create contract** fills the Google Doc template into the contracts folder, signed with Google eSignature. Admins upload the weekly bank screenshot and **Mark paid**, log expenses with receipts and track software costs |
| **Timesheet** | At 16:30 on weekdays (each person's own time zone) staff are asked to fill eight hourly blocks, pre-filled from what they did that day. Admins review everyone's week in Settings |
| **World clocks** | At the top of every page: the time and day in Sydney, Tbilisi and Manila, with a sun or moon for day or night there |
| **Task emails** | A task's owner gets an email when someone else hands them the task or posts an update on it, with a link to the task; sent from the Google account of the admin who turns them on in **Settings** → **Business** |
| **Team chat** | Slack-style dock at the bottom of every page: groups, create group, add members, @mentions with autocomplete and highlight, unread and mention counts |
| **Settings** (admins) | **Team** (roles, active flags and staff module access; SuperAdmin only), **Routines**, **Timesheets**, **Business** details for invoices, **Outreach** (the agent's sheet link, the mailboxes with their addresses, and **Connect Gmail** per mailbox), CSV **Import** from the old platform |

### Roles and access

| | SuperAdmin / Admin | Staff (default) |
|---|---|---|
| Operations (Projects) | Edit | Edit (team boards and their own notes) |
| Marketing | Edit | Edit |
| Outreach | Edit; mailboxes and the sheet link (Settings) | None (View: the dashboard, emails and notes, **Sync now**, and Outreach's boards read-only; Edit: also write notes and edit those boards' groups and tasks) |
| Pipeline | Edit | View |
| Clients | Edit | View: no money in, expenses or software costs; can't approve, send or mark paid; Clients' boards (Demos, Previews …) read-only until given Edit |
| Dashboard, Team, team chat, timesheet | Yes | Yes (Team: tasks on the boards they can see) |
| Calendar | Yes | Yes: what each module lets them see; add events (edit and delete their own) |
| Settings | Yes (Team read-only for Admins) | No |

The SuperAdmin changes roles, active flags and each staff member's access (None / View / Edit per module) in
**Settings** → **Team**. The same rules run in the database (row-level security) and in the screens, which hide
modules at None and turn read-only at View. The demo team is David (SuperAdmin), Josh (Admin) and Hello (Staff).

Invoice and other business dates follow Sydney time; each person's own day (the Dashboard, follow-ups, the timesheet
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

`npm test` runs four scripts. CI runs it, then a demo-mode build, on pull requests and pushes to `main`:

- `scripts/test-sync.mjs` checks the state ⇄ row mapping round trip for every table, the diff for common
  edits, the sync queue (coalescing, ordering, retry) against a fake Supabase client, the access helpers, the
  timesheet suggestions and the demo-mode automations.
- `scripts/test-db.mjs` runs the migrations in order (`0001_cortex.sql` onwards) in PGlite (Postgres in WASM),
  as on the live database, and checks the sign-up domain gate, roles and module access, the board merge, the
  automations, invoice generation, time zones, client contacts and contracts, Google token privacy, finance privacy,
  boards, Outreach and row-level security as different users.
- `scripts/test-invoice.mjs` checks the tax invoice model, the PDF and the contract helpers;
  `scripts/test-google.mjs` checks the `google` Edge Function (connect, callback, send, contract, the Outreach sheet
  sync) with Google and Supabase mocked.

## Deploying

[`DEPLOY.md`](DEPLOY.md) has the click-by-click setup: Supabase (Sydney), Google sign-in, Cloudflare Pages,
the custom domain, inviting staff, importing old data, and a security checklist. A database set up before the
team workflow needs one upgrade step (`0002_team_workflow.sql`, see *Upgrading an existing project*), then each
newer migration in order (`0003_…` to `0013_…`). Invoice email and contracts need the Google setup in DEPLOY.md
section 11; Outreach also needs section 12 (the agent's sheet and the mailboxes), and section 14 to count mailboxes
from Gmail; the Calendar's Google meetings section 13; task emails section 15. Security headers for Cloudflare
Pages are in `public/_headers`.

## Not done yet

- **Calendar on a timer.** Google meetings sync when someone opens the Calendar (or clicks **Sync now**) and only for
  people who have connected their Google Calendar. A sync on a schedule, or reading everyone's calendar without each
  person connecting (Google Workspace domain-wide delegation), would need more setup; `docs/PHASE2.md` §15 says what.
- **Outreach on a timer, and reply sorting.** Gmail is read when someone opens Outreach (or clicks **Sync now**), and
  replies are counted, not yet sorted into interested or not. Mailboxes on `@assetstack.org` and
  `@assetstackai.com.au` need their own Google client in that Workspace first. `docs/PHASE2.md` §16 says what each
  would take.
- **Outreach opens.** Outreach shows *Not tracked*: the agent's emails carry no tracking image (deliverability on new
  sending domains, and Apple Mail makes opens unreliable). [`docs/PHASE2.md`](docs/PHASE2.md) §12 says what turning
  them on would take. Cortex itself never sends outreach email; the outreach agent does, outside Cortex.

## Design

Smoked "liquid glass" panels over the chrome-glass backdrop (`public/media/bg-liquid.webp`), using Inter Tight and AssetStack indigo `#2337EE` from the marketing site. Design tokens (`.glass`, `.glass-rim`, `.glass-solid`, `.chip`, `.pill`, `.btn-primary`) are in `src/styles/index.css`.
