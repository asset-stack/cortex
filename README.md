# AssetStack Ops

Repository: `asset-stack/cortex`. It is public, so the demo data uses placeholder people at `example.com`.

The internal operations tool for AssetStack staff. One workspace covers the six departments plus team chat:

| Area | What it does |
|---|---|
| **My Work** | Your open tasks across every board, @mentions from team chat, overdue invoices |
| **Projects / Admin / Marketing** | Monday.com-style boards: grouped tables with coloured status/label cells, Kanban (drag to change status), calendar, and a task drawer with subtasks and updates |
| **Outreach** | Contacts CRM, Gmail activity feed, sequences, approvals queue, and the Claude outreach agent (draft, then send or queue) |
| **Pipeline** | Deal Kanban: Opportunities → First meetings → Demos → Won, with *Make client* on won deals |
| **Clients** | Client Tracker cards, plus a client drawer with overview, notes and tasks, **invoices** (line items, GST 10%, status, print/PDF) and **access** records |
| **Team chat** | Slack-style dock at the bottom of every page: groups, create group, add members, @mentions with autocomplete and highlight, unread and mention counts |

## Running it

```bash
git clone https://github.com/asset-stack/cortex.git && cd cortex
npm install
npm run dev       # http://localhost:5173
npm run build     # static output in dist/
npm run preview   # serves dist/ on http://localhost:4322
```

The output is a static site and is ready for Cloudflare Pages.

## Current state: local prototype

- **Data** lives in the browser (`localStorage`) and is seeded with example data from the Client Tracker, the monday.com Posting Schedule and the master-layout whiteboard. *Reset demo data* in the sidebar restores the seed.
- **Gmail and the Claude agent are stubbed** in `src/integrations/`. Drafts come from templates and "sent" emails are only logged to the feed.
- **Team members** are a fixed list in `src/data/seed.js`. The avatar menu at the bottom of the sidebar switches who you are viewing as (demo only), so you can see tagging from both sides.

## Next steps to production

1. **Backend and auth.** Put the app behind Cloudflare Access (or similar) and move the store to Supabase or monday.com. All reads and writes go through `src/data/store.jsx`, so that is the only file that changes.
2. **Gmail.** A server endpoint holds the Google OAuth client and per-user refresh tokens. Replace `listThreads` / `sendEmail` in `src/integrations/gmail.js`.
3. **Claude agent.** A server endpoint calls the Anthropic Messages API with the AssetStack voice guide and the contact's history. Replace `draftOutreach` in `src/integrations/claudeAgent.js`. API keys never go in this frontend.
4. **Chat in real time.** Swap the local message list for a realtime channel (Supabase Realtime, Pusher or Ably).

## Design

Smoked "liquid glass" panels over the chrome-glass backdrop (`public/media/bg-liquid.webp`), using Inter Tight and AssetStack indigo `#2337EE` from the marketing site. Design tokens (`.glass`, `.glass-rim`, `.glass-solid`, `.chip`, `.pill`, `.btn-primary`) are in `src/styles/index.css`.
