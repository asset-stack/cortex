# AssetStack Ops: notes for Claude

Internal staff tool (Vite + React 18 + Tailwind 3 + lucide-react). This is separate from the marketing
site (`AssetLanding`) and from the signed-in product (bunburycouncil.assetstack.site).

## Rules
- All data access goes through `src/data/store.jsx` (`useStore()` → `{ state, actions }`). Don't read or write
  localStorage anywhere else; that file is the seam for the future backend.
- **This repo (asset-stack/cortex) is public.** Never commit real client names, emails, invoices or
  credentials. Seed people use `@example.com` placeholders.
- Seed and demo data live in `src/data/seed.js`. Board columns and label colours live in `src/data/boards.js`.
- No secrets in the frontend. Gmail and Claude calls go through `src/integrations/*`, which stay stubs until
  a server endpoint exists.
- Domain is `assetstackai.com` (never `assetstack.ai`, which belongs to another company).
- Keep copy minimal: titles and actions only, no eyebrow or subtitle text (agreed with the user on the mockup).
- Images go in `public/media/` as WebP, max 1920px, q82.
- Routing is a hash router (`src/lib/router.js`). Add new pages to `ROUTES`, `NAV` in `Sidebar.jsx`, and `App.jsx`.

## Workflow
1. Edit
2. `npm run build`, which must pass
3. `npm run preview` (port 4322) and check in a browser at desktop width and at 390px
4. Commit and push
