# Cortex: notes for Claude

Cortex is AssetStack's internal ops platform (Vite + React 18 + Tailwind 3 + lucide-react, Supabase in live mode).
It is separate from the marketing site (`AssetLanding`) and from the signed-in product
(bunburycouncil.assetstack.site). The backend contract is `docs/BACKEND.md`; setup steps are in `DEPLOY.md`.

## Rules
- All data access goes through `src/data/store.jsx` (`useStore()` → `{ state, actions }`), in both modes. Screens
  never call Supabase or touch localStorage; only the store, `src/data/backend/*` and the sign-in screen
  (`src/components/auth/AuthGate.jsx`) do. Keep the state shape
  in `docs/BACKEND.md` §1 and update the mapping in `src/data/backend/schema.js` when it changes.
- Keep demo mode working. Without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` the app runs on localStorage
  and seed data, and CI builds it that way (no env vars), so the build must never require them.
- Supabase schema changes go in a new numbered file in `supabase/migrations/` (`0002_….sql`, …). Never edit an
  applied migration. Every table keeps row-level security on with policies that require `is_staff()`, and is
  added to the `supabase_realtime` publication if it is synced. Extend `scripts/test-db.mjs` to cover it.
- `npm test` must pass (sync mapping and database checks, no network).
- **This repo (asset-stack/cortex) is public; treat it as public even if it is made private.** Never commit real
  client names, emails, invoices, bank details or credentials. Seed people use `@example.com` placeholders, and
  real admin addresses only ever go into the Supabase SQL editor, not `supabase/setup-admins.sql`.
- Never commit `.env` / `.env.local` or any key. Only `.env.example` (empty values) is tracked. The anon /
  publishable key is the only Supabase key the frontend may use; the `service_role` / secret key never goes
  anywhere in this repo, CI or Cloudflare.
- No secrets in the frontend. Gmail and Claude calls go through `src/integrations/*`, which stay stubs until
  a server endpoint exists.
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
