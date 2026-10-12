# Cortex

AssetStack's internal operations platform. Repository: `asset-stack/cortex`. Treat it as public: demo data
uses placeholder people at `example.com`, and no keys or `.env` files are ever committed.

One workspace covers the six departments plus team chat:

| Area | What it does |
|---|---|
| **My Work** | Your open tasks across every board, @mentions from team chat, overdue invoices |
| **Projects / Admin / Marketing** | Monday.com-style boards: grouped tables with coloured status/label cells, Kanban (drag to change status), calendar, and a task drawer with subtasks and updates |
| **Outreach** | Contacts CRM, Gmail activity feed, sequences, approvals queue, and the Claude outreach agent (draft, then send or queue) |
| **Pipeline** | Deal Kanban: Opportunities → First meetings → Demos → Won, with *Make client* on won deals |
| **Clients** | Client Tracker cards, plus a client drawer with overview, notes and tasks, **invoices** (line items, GST 10%, status, print/PDF) and **access** records |
| **Team chat** | Slack-style dock at the bottom of every page: groups, create group, add members, @mentions with autocomplete and highlight, unread and mention counts |
| **Settings** (admins) | Team roles and active flags, business and bank details for invoices, CSV import from the old platform |

## Demo and live mode

The mode is picked at build time from two environment variables (full design: [`docs/BACKEND.md`](docs/BACKEND.md)).

| Mode | When | Data | Sign-in |
|---|---|---|---|
| **Demo** | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` not set (CI, local by default) | The browser's `localStorage`, seeded from `src/data/seed.js` | None. The avatar menu switches who you are viewing as; *Reset demo data* restores the seed |
| **Live** | Both set (Cloudflare Pages) | Supabase Postgres with realtime, so staff see each other's changes | Google, `@assetstackai.com` accounts only |

Screens only ever call `useStore()` from `src/data/store.jsx`, with the same state shape in both modes. In live
mode a sync engine (`src/data/backend/`) turns each change into row writes and applies other people's changes
as they arrive; the dot on the Cortex logo shows saved / saving / error / offline. Access is enforced by
row-level security in Postgres (`supabase/migrations/`), not by the frontend.

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

- `scripts/test-sync.mjs` checks the state ⇄ row mapping round trip, the diff for common edits, and the
  sync queue (coalescing, ordering, retry) against a fake Supabase client.
- `scripts/test-db.mjs` runs `supabase/migrations/0001_cortex.sql` in PGlite (Postgres in WASM) and checks
  the sign-up domain gate, the triggers and row-level security as different users.

## Deploying

[`DEPLOY.md`](DEPLOY.md) has the click-by-click setup: Supabase (Sydney), Google sign-in, Cloudflare Pages,
the custom domain, inviting staff, importing old data, and a security checklist. Security headers for
Cloudflare Pages are in `public/_headers`.

## Still stubbed

- **Gmail.** A server endpoint holds the Google OAuth client and per-user refresh tokens. Replace
  `listThreads` / `sendEmail` in `src/integrations/gmail.js`. Until then "sent" emails are only logged to the feed.
- **Claude agent.** A server endpoint calls the Anthropic Messages API with the AssetStack voice guide and the
  contact's history. Replace `draftOutreach` in `src/integrations/claudeAgent.js`. Drafts come from templates
  for now. API keys never go in this frontend.

## Design

Smoked "liquid glass" panels over the chrome-glass backdrop (`public/media/bg-liquid.webp`), using Inter Tight and AssetStack indigo `#2337EE` from the marketing site. Design tokens (`.glass`, `.glass-rim`, `.glass-solid`, `.chip`, `.pill`, `.btn-primary`) are in `src/styles/index.css`.
