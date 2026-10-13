# Deploying Cortex

This takes about an hour. Do the steps in order; later steps need values from earlier ones.
Keep the values below in the company password manager, never in the repo, an issue or a chat.

| Value | Looks like | From | Goes to |
|---|---|---|---|
| Project ref | `abcdefghijklmnopqrst` | Supabase (step 1) | Google redirect URI |
| Project URL | `https://<project-ref>.supabase.co` | Supabase (step 1) | Cloudflare `VITE_SUPABASE_URL`, `.env.local` |
| Anon / publishable key | `sb_publishable_…` or `eyJ…` | Supabase (step 1) | Cloudflare `VITE_SUPABASE_ANON_KEY`, `.env.local` |
| Database password | random | Supabase (step 1) | Password manager only (the app never uses it) |
| Google client ID and secret | `….apps.googleusercontent.com` / `GOCSPX-…` | Google Cloud (step 3) | Supabase Google provider only |
| Pages URL | `https://<pages-project>.pages.dev` | Cloudflare (step 5) | Supabase URL configuration |

`<pages-project>` is the Cloudflare Pages project name you choose in step 5, for example `cortex`.

## 1. Create the Supabase project

1. Go to <https://supabase.com/dashboard> and sign in with the company account. Turn on MFA for it
   (avatar → **Account preferences** → **Security**).
2. **New project**. Organization: AssetStack (create it if asked). The Free plan pauses a project after a
   week without use and has no backups, so use **Pro** once staff rely on it.
3. **Project name**: `cortex`.
4. **Database password**: **Generate a password**, then save it in the password manager.
5. **Region**: Sydney (`ap-southeast-2`, listed as *Oceania (Sydney)*). If the form offers general areas
   first, choose the specific Sydney region.
6. If **Security options** are shown, keep **Data API + Connection String** and **Use public schema for Data
   API**. Cortex talks to the `public` schema through the Data API.
7. **Create new project** and wait for it to finish setting up (a few minutes).
8. Collect the values:
   - **Project URL**: the **Connect** button in the top bar, or **Project Settings** → **Data API** →
     **Project URL**. The project ref is the part before `.supabase.co`.
   - **Key**: **Project Settings** → **API Keys** → copy the **Publishable key** (`sb_publishable_…`). The
     `anon` `public` key on the **Legacy API Keys** tab also works.
   - Do **not** copy the **secret** (`sb_secret_…`) or **`service_role`** key. Cortex never needs it.

## 2. Create the database

1. Left sidebar → **SQL Editor** → **+** → **Create a new snippet**.
2. On GitHub open `supabase/migrations/0001_cortex.sql` → **Raw**, select all, copy, and paste the whole file
   into the editor.
3. **Run** (Ctrl/Cmd + Enter). The editor may warn about destructive operations: the file drops and recreates
   its own policies. Choose **Run this query**. Expect *Success. No rows returned*.
4. **+** → **Create a new snippet**, paste `supabase/migrations/0002_team_workflow.sql` the same way and **Run**.
   It adds roles, module access, My Work, billing, money in, expenses, timesheets and the `finance` storage
   bucket. From now on never run `0001` again: it would put back the phase 1 roles and policies.
   Then do the same with `supabase/migrations/0003_timezones_projects_view.sql`: Sydney as the business time
   zone, each person's own time zone, and Projects view-only for staff.
5. **+** → **Create a new snippet** again and paste `supabase/setup-admins.sql`. Replace the placeholder
   addresses with the real ones, one `('name@assetstackai.com', 'role')` per line, separated by commas, in lower
   case. The role is `'superadmin'` or `'admin'`:
   - **SuperAdmin**: everything an Admin can do, plus roles, the **Active** switch and staff module access in
     **Settings** → **Team**. List at least one; nobody else can change roles.
   - **Admin**: edits every module, sees money in, expenses and software costs, approves invoices and marks
     them paid, and manages routines, timesheets, business details and import in **Settings**.
   - Anyone not listed signs up as **Staff**.

   **Run**. Keep these addresses out of the repo. Run this before admins first sign in (if someone already has,
   the `update`s at the end of the file promote them; they never demote anyone).
6. Check:
   - **Table Editor**: the Cortex tables are listed (`profiles`, `clients`, `items`, `todos`, …) and none is
     marked **Unrestricted** (that label means RLS is off).
   - **Database** → **Publications** → `supabase_realtime`: the Cortex tables are listed.
   - **Storage**: a `finance` bucket, *not* marked **Public** (see the note below).
   - **Advisors** → **Security Advisor** → **Refresh**: no *RLS Disabled in Public* errors.

**The `finance` bucket** is created by `0002`. It holds the weekly bank-statement screenshots
(`statements/…`) and expense receipts (`receipts/…`). It is private and only admins can list, upload, open,
change or delete its files; Cortex opens a file through a link that expires after five minutes. Never switch it
to **Public**, and don't add policies to it in the dashboard.

Then run `supabase/migrations/0004_clients_google.sql` the same way (client contacts and contracts, credits,
and each admin's Google connection; see section 11).

Later schema changes arrive as new numbered files in `supabase/migrations/` (`0005_…`). Run each new file
once, in order, the same way. Never run an older file after a newer one.

**0003 on a database that already has 0002**: **SQL Editor** → **+** → **Create a new snippet**, paste
`supabase/migrations/0003_timezones_projects_view.sql` and **Run** *before* deploying the code that needs it (the
app saves `profiles.timezone`, which doesn't exist until then). It is one transaction and safe to re-run.
Afterwards staff view Projects instead of editing it (give one person edit in **Settings → Team**), invoice dates
follow Sydney, and each person's time zone is set the next time they open Cortex.

**0004 on a database that already has 0003**: paste `supabase/migrations/0004_clients_google.sql` the same way and
**Run** *before* the app version that uses it goes live (it loads `client_contacts`, which doesn't exist until then).
One transaction, safe to re-run. Each client's key contact and email become its first contact, marked **Billing**
(invoices go to billing contacts). Running it again after the deploy picks up a key contact typed into an old open
tab in between, without duplicating. Then set up section 11.

### Upgrading an existing project

If the database was set up with `0001` only (phase 1), upgrade it once:

1. **SQL Editor** → **+** → **Create a new snippet**, paste `supabase/migrations/0002_team_workflow.sql` and
   **Run**. It runs as one transaction on top of the existing rows: members become **Staff**, admins stay
   **Admin**, the Admin board's groups and items move to **Projects** (its *To do* group becomes *Admin*), and
   each task's owner becomes its people. If anything fails, nothing changes. Don't run `0001` again.
2. Run `supabase/setup-admins.sql` as in step 2.5, with at least one `'superadmin'`. Until then nobody is a
   SuperAdmin, so nobody can change roles or staff access. Existing admin addresses take the role you list.
3. Deploy the phase 2 code straight after (merge to `main`; Cloudflare builds it), then ask everyone to reload.
   The phase 1 app can't save to the Admin board once it has been merged into Projects.
4. Check as in step 2.6, including the `finance` bucket.

## 3. Google sign-in

Use a Google Workspace admin account for `assetstackai.com`.

### Google Cloud project

1. Open <https://console.cloud.google.com> → project picker in the top bar → **New project**.
2. **Project name**: `Cortex`. **Organization** and **Location**: `assetstackai.com`. **Create**, then select
   the project.

### Consent screen

1. ☰ → **APIs & Services** → **OAuth consent screen**. This opens **Google Auth Platform**; click
   **Get started**.
2. **App information**: App name `Cortex`, User support email an `@assetstackai.com` address → **Next**.
3. **Audience**: **Internal** → **Next**. Only accounts in the Workspace can sign in, and Google doesn't need
   to verify the app. If **Internal** is greyed out, the project isn't under the `assetstackai.com`
   organization.
4. **Contact information**: an `@assetstackai.com` address → **Next** → agree to the policy → **Continue** →
   **Create**.
5. **Branding** → **Authorised domains** → **Add domain**: `<project-ref>.supabase.co` → **Save**.
6. **Data Access** → **Add or remove scopes** → tick `.../auth/userinfo.email`, `.../auth/userinfo.profile`
   and `openid` → **Update** → **Save**.

### OAuth client

1. **Clients** → **+ Create client** (or **APIs & Services** → **Credentials** → **Create credentials** →
   **OAuth client ID**).
2. **Application type**: **Web application**. **Name**: `Cortex Supabase`.
3. **Authorised JavaScript origins**: leave empty. Sign-in goes through Supabase, not Google's script.
4. **Authorised redirect URIs** → **+ Add URI**: `https://<project-ref>.supabase.co/auth/v1/callback`.
   Copy it exactly from Supabase → **Authentication** → **Sign In / Providers** → **Google** → **Callback URL
   (for OAuth)**.
5. **Create**. Copy the **Client ID** and **Client secret** into the password manager straight away; Google
   only shows the secret once.

### Supabase provider

1. Supabase → **Authentication** → **Sign In / Providers** (older dashboards: **Providers**) → **Google**.
2. Turn on **Enable Sign in with Google**. **Client IDs**: paste the client ID. **Client Secret (for OAuth)**:
   paste the secret. Leave **Skip nonce checks** and **Allow users without an email** off. **Save**.
3. On the same page:
   - **Allow new users to sign up**: on. Staff accounts are created on first Google sign-in, and the database
     rejects any address outside `@assetstackai.com`.
   - **Email**: open it and turn **Enable Email provider** off, so nobody can register an `@assetstackai.com`
     address with a password. **Save**.
   - Leave **Phone**, **Allow anonymous sign-ins**, **Allow manual linking** and every other provider off.

## 4. Supabase Auth URLs

Supabase → **Authentication** → **URL Configuration**.

1. **Site URL**: the address staff will use. Until step 6 is done, use `https://<pages-project>.pages.dev`;
   afterwards change it to `https://cortex.assetstackai.com`. **Save changes**.
2. **Redirect URLs** → **Add URL** for each of these, then **Save URLs**:
   - `https://cortex.assetstackai.com/**`
   - `https://<pages-project>.pages.dev/**`
   - `http://localhost:5173/**` (live mode in `npm run dev`)
   - `http://localhost:4322/**` (optional, `npm run preview`)

Cortex sends people back to the page they signed in from. An address missing from this list falls back to
the Site URL. If Cloudflare gives the project a different `pages.dev` name in step 5, fix it here.

## 5. Cloudflare Pages

1. <https://dash.cloudflare.com> → your account → **Workers & Pages** → **Create application** → **Pages**
   → **Connect to Git** (shown as **Import an existing Git repository** in newer dashboards; choose the
   Pages option, not a Worker).
2. **GitHub** → **Connect GitHub**. Install the **Cloudflare Workers and Pages** app on the `asset-stack`
   organization with **Only select repositories** → `cortex`. Back in Cloudflare select `asset-stack/cortex`
   → **Begin setup**.
3. **Project name**: `cortex` (the Pages URL becomes `https://cortex.pages.dev`, or gets a suffix if the name
   is taken). **Production branch**: `main`.
4. **Build settings**:
   - **Framework preset**: **None** (a Vite preset fills in the same values)
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: leave empty
5. **Environment variables (advanced)** → **Add variable**, type **Text** (the two Supabase values end up in
   the public JavaScript anyway; RLS is what protects the data):

   | Variable name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | the publishable / anon key from step 1 |
   | `NODE_VERSION` | `22` |

6. **Save and Deploy**. When the build finishes, open `https://<pages-project>.pages.dev`. You should see the
   Cortex card with **Sign in with Google**. If you see the demo app (*Reset demo data* in the sidebar), the
   variables were missing at build time: add them under **Settings** → **Variables and Secrets** →
   **Production**, then **Deployments** → latest deployment → **⋯** → **Retry deployment**. Variable changes
   only apply to new builds.
7. **Settings** → **Variables and Secrets** → **Preview**. The setup form in 5.5 may have copied its variables
   here too. Make sure `NODE_VERSION` = `22` is listed (add it if not), and delete `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` if they appear, so branch and pull request previews build in demo mode with
   placeholder data instead of touching production. To check, open a preview deployment (**Deployments** → a
   build that isn't from `main`, or push any branch): it should show the demo app (*Reset demo data* in the
   sidebar), not **Sign in with Google**. If it signs in, the variables are still set for Preview: remove them
   and retry that deployment.
8. Leave **Web Analytics** off for this project, and **Rocket Loader** off for the `assetstackai.com` zone.
   Both inject scripts that the Content-Security-Policy in `public/_headers` blocks.

## 6. Custom domain

1. Pages project → **Custom domains** → **Set up a custom domain** → `cortex.assetstackai.com` → **Continue**.
2. If `assetstackai.com` uses Cloudflare DNS in this account, click **Activate domain** and Cloudflare adds the
   record. Otherwise add a `CNAME` record `cortex` → `<pages-project>.pages.dev` at the DNS host. Always add
   the domain in Pages first; a CNAME on its own returns an error.
3. Wait for the status to show **Active** (the certificate usually takes a few minutes).
4. Supabase → **Authentication** → **URL Configuration** → **Site URL**: `https://cortex.assetstackai.com` →
   **Save changes**. Google needs no change; its redirect URI points at Supabase.
5. Open <https://cortex.assetstackai.com> and sign in with an admin account. **Settings** should appear in the
   sidebar.
6. **Settings** → **Business**: enter the business name, ABN, address, bank details, payment terms and invoice
   prefix that print on invoices. They are stored in Supabase, and only admins can edit them.
7. Check the security headers: browser dev tools → **Network** → reload → the document request →
   **Response Headers** should include `content-security-policy` and `strict-transport-security`.

## 7. Optional: Cloudflare Access

A second gate in front of the site: Cloudflare checks the visitor's email before any page loads. Google
sign-in and RLS still apply behind it. Needs `assetstackai.com` on Cloudflare DNS.

1. Cloudflare dashboard → **Zero Trust** (the first time, pick a team name and the Free plan, which covers up
   to 50 users) → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. **Application name**: `Cortex`. **Session duration**: `24 hours`.
3. **Add public hostname**: subdomain `cortex`, domain `assetstackai.com`. Add a second hostname
   `<pages-project>.pages.dev` so the Pages address is covered too.
4. **Add a policy**: name `AssetStack staff`, **Action** **Allow**, **Include** → selector **Emails ending in**
   → `@assetstackai.com`. **Save**.
5. Login method: **One-time PIN** works without setup. **Save** the application.
6. Pages project → **Settings** → **General** → **Access policy** → **Enable**, which protects preview
   deployments as well.
7. Test in a private window: the Cloudflare login appears first, then the Cortex sign-in.

## 8. Invite staff

There are no invitations to send.

1. Send staff the link <https://cortex.assetstackai.com>. They click **Sign in with Google** and choose their
   `@assetstackai.com` account.
2. On first sign-in Cortex creates their profile as **Staff** and adds them to #general. Addresses from
   `setup-admins.sql` come in with the role listed there (**SuperAdmin** or **Admin**).
3. The SuperAdmin manages people in **Settings** → **Team**: the **Role** menu (SuperAdmin / Admin / Staff),
   the **Active** switch, and each staff member's access to **Projects**, **Marketing**, **Outreach**,
   **Pipeline** and **Clients** (None / View / Edit). Staff start with Projects and Marketing on Edit, Pipeline
   and Clients on View, and Outreach on None; admins always have Edit. Admins see the page read-only.
   Switching Active off removes all of that person's access at once, because every database policy checks it.
   Your own row is locked, and the last active SuperAdmin can't be demoted or deactivated.
4. Admins set each person's daily routines in **Settings** → **Routines**; they appear on that person's
   **My Work** each day.
5. When someone leaves, the SuperAdmin switches **Active** off the same day and suspends their Workspace
   account. Deactivate rather than delete, so their notes, updates and messages stay attributed.

## 9. Import data from the old platform

Admins only. Do this after the team has signed in once, so Owner and Team columns can be matched to people by
name or email.

1. In the old platform, export each list as CSV: clients, contacts, deals, and the board tasks (one file per
   board or group).
2. Cortex → **Settings** → **Import** → choose **Clients**, **Contacts**, **Deals** or **Board tasks**. For
   board tasks, also pick the **Board** and **Group** (or **New group** and type a **Group name**). Import
   contacts before deals: a contact that replied or booked a meeting gets its deal straight away, and the deal
   with the same name in the deals file then fills it in.
3. **Choose CSV**. Under **Columns**, Cortex matches the headers it recognises; fix any dropdown that's wrong
   (`—` means the field isn't imported). **Name** is required.
4. Check **Preview** (first five rows) → **Import N**. Rows whose name already exists are skipped (ignoring
   case), so importing the same file twice is safe. Click **Open** to check the result.
5. Delete the exported CSVs from your computer afterwards. They contain client data; never commit them.

## 10. Security checklist

- [ ] The GitHub repo is **private**: GitHub → `asset-stack/cortex` → **Settings** → **General** → **Danger
  Zone** → **Change repository visibility** → **Make private**. Then push a commit and check Cloudflare still
  deploys (the Cloudflare app needs access to the private repo). Even when private, never commit real client
  data, `.env` files or keys; git history keeps them forever.
- [ ] The **`service_role` / secret key is never pasted anywhere**: not in `.env.local`, Cloudflare, GitHub
  secrets, CI, chat, email or tickets. The frontend only ever uses the anon / publishable key. If the secret
  key leaks, rotate it immediately under **Project Settings** → **API Keys**.
- [ ] **RLS is on for every table**: no table is **Unrestricted** in the Table Editor and the Security Advisor
  shows no RLS errors. New tables only arrive through numbered migrations that keep RLS on.
- [ ] Supabase Auth: Google is the only provider; Email, Phone and anonymous sign-ins are off.
- [ ] The Google consent screen is **Internal**. The client secret lives only in Supabase and the password
  manager.
- [ ] Supabase redirect URLs list only `cortex.assetstackai.com`, the `pages.dev` address and `localhost`.
- [ ] Preview deployments build without the Supabase variables (demo mode): **Settings** → **Variables and
  Secrets** → **Preview** lists only `NODE_VERSION`, and a preview URL shows *Reset demo data* in the sidebar.
- [ ] Supabase and Cloudflare dashboards: only admins are members, all with MFA on.
- [ ] The `finance` storage bucket is **private** (Supabase → **Storage**: no **Public** badge).
- [ ] At least one active **SuperAdmin**, and staff module access in **Settings** → **Team** is what you
  intend (Outreach is off for staff unless granted).
- [ ] Security headers are live (step 6.7).
- [ ] Leavers are deactivated in **Settings** → **Team** (by the SuperAdmin) the same day.
- [ ] The `google` Edge Function's secrets are only `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; nobody adds
  `private` to the Data API's exposed schemas (that schema holds the admins' Google tokens).

## 11. Invoice email and contracts (Google)

Cortex emails approved invoices from the **approving admin's own Gmail** (with the PDF tax invoice attached), and
makes each client's contract by copying the contract **Google Doc template** into the contracts folder with the Key
Details filled in. Each admin connects their own Google account once. This goes through the `google` Edge Function in
Supabase, which keeps the Google client secret and the admins' Google tokens on the server; the browser never sees
them. Use a Google Workspace admin account for steps 1 and 2.

1. **Google Cloud** (<https://console.cloud.google.com>, the project from section 3):
   - **APIs & Services** → **Library**: open and **Enable** each of **Gmail API**, **Google Drive API** and
     **Google Docs API**.
   - **Google Auth Platform** → **Data Access** → **Add or remove scopes**: tick `.../auth/gmail.send` and
     `.../auth/drive` (add them under **Manually add scopes** if they aren't listed) → **Update** → **Save**. The
     consent screen is **Internal**, so Google doesn't review these.
   - **Clients** → your Cortex client → **Authorised redirect URIs** → **+ Add URI**:
     `https://<project-ref>.supabase.co/functions/v1/google/callback` → **Save**. Keep the existing
     `…/auth/v1/callback` one (sign-in).
   - Same page → **Client secrets** → **+ Add secret** and copy the new secret straight into the next step (never
     into chat or email). The existing secret keeps working for sign-in.
2. **Supabase** → **Edge Functions** → **Secrets** → add `GOOGLE_CLIENT_ID` (the client ID) and
   `GOOGLE_CLIENT_SECRET` (the secret from step 1) → **Save**. `SUPABASE_URL` and the project keys are provided
   automatically; don't add them.
3. **Edge Functions** → **Deploy a new function** → **Via Editor**. Name it exactly `google` (it's part of the
   redirect URI). Replace the starter code with the whole of `supabase/functions/google/index.ts` (GitHub → **Raw**,
   copy all) → **Deploy function**. Then the function's **Details** (or settings) → turn **Enforce JWT verification**
   (Verify JWT) **off** → **Save**: Google's return to `/callback` carries no Supabase token, and the function checks
   every other request itself.
4. **The contract template.** Open it in Google Docs. If its name ends in `.docx`, use **File** → **Save as Google
   Docs** and use the new Doc (eSignature fields only work in Google Docs). Type placeholders where Cortex should
   fill in values, for example in the Key Details table: `{{Customer}}`, `{{Platform}}`, `{{Start date}}`,
   `{{End date}}`, `{{Annual fee}}`, `{{Payment terms}}`, `{{User limit}}`, `{{Customisations}}`, `{{Mobile app}}`,
   `{{Governing law}}`; also available: `{{Customer ABN}}`, `{{Customer address}}`, `{{Contact name}}`,
   `{{Contact email}}`, `{{Date}}`. Leave the eSignature fields as they are. Share the template and the contracts
   folder with every admin (or keep both in a shared drive the admins belong to).
5. **Cortex** → **Settings** → **Business**:
   - **Contracts**: paste the template's link (`docs.google.com/document/d/…`) and the contracts folder's link
     (`drive.google.com/drive/folders/…`; a link with `/file/d/` is a file, not the folder).
   - **Google account**: each admin clicks **Connect Google**, picks **their own** @assetstackai.com account and
     allows Gmail sending and Drive. Back in Cortex it says connected; click **Send test email** and check it arrives.

**Using it**
- **Invoices**: **Approve** opens a short email (to the client's **Billing** contacts; edit the message if you like)
  → **Approve and send**. It goes from your Gmail with the PDF attached and lands in your Sent folder; the invoice
  shows *Sent to …*. Without a connected account, Approve works as before (Print / PDF or Download PDF, email it
  yourself, **Mark as sent**). Sending needs your ABN in **Business**.
- **Contracts**: client → **Contract** → check the Key Details → **Create contract**. The filled-in Doc opens from
  the contracts folder. In Google Docs: **Tools** → **eSignature** → **Request signature** (Google offers no way for
  another app to start this). Back in Cortex: **Mark as sent for signature**, then **Mark signed** when it comes back,
  which can also set up the client's billing plan from the contract.
- **Credits**: each month, export usage from the client's platform as CSV → client → **Usage** → **Import usage**.
  Importing the same file again replaces those months; nothing doubles.

**Disconnecting**: **Settings** → **Business** → **Disconnect** removes your stored Google access from Cortex. To
revoke it at Google too: <https://myaccount.google.com/connections>. When someone leaves, deactivating them in
**Settings** → **Team** also stops their connection from being used.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Only @assetstackai.com Google accounts can sign in." | A personal Google account was chosen. Sign in with the work account. |
| Google: "Access blocked … can only be used within its organization" | The account isn't in the Workspace. Expected for outsiders. |
| Google: `redirect_uri_mismatch` | The redirect URI in the Google client must be exactly `https://<project-ref>.supabase.co/auth/v1/callback`. |
| After Google you land on the wrong site or `localhost:3000` | Site URL or Redirect URLs (step 4). |
| "Your account isn't active yet. Ask an admin." | The SuperAdmin switched **Active** off. If the person signed in before step 2 ran, delete them under **Authentication** → **Users** and have them sign in again. |
| Nobody can change roles; **Settings** → **Team** is read-only for everyone | There is no SuperAdmin yet (normal straight after upgrading). Run `setup-admins.sql` with a `'superadmin'` line (step 2.5). |
| "Cortex needs at least one active SuperAdmin" | Someone tried to demote or deactivate the last active SuperAdmin. Make another person SuperAdmin first. |
| A staff member can't see Outreach, or Pipeline / Clients are read-only for them | Expected defaults. The SuperAdmin changes their access in **Settings** → **Team**. |
| "Only admins can approve, send, void or mark invoices paid" | Staff can't do these, even with Clients on Edit. An admin does it. |
| Bank screenshot or receipt upload fails ("Bucket not found") | The `finance` bucket is missing: check **Storage**, then run `0002_team_workflow.sql` again (it is safe to re-run). |
| Demo data on the live site | Supabase variables missing at build time (step 5.6). |
| Red dot on the Cortex logo ("Not saved") | Hover it for the message. Changes stay queued and retry; check the browser console. A change the database refuses three times is put back the way the database has it (a duplicate invoice number or group name gets the next free one instead). |
| Console: "Refused to load … Content Security Policy" | The origin isn't allowed in `public/_headers`. |
| "Couldn't load your workspace … client_contacts" after an update | `0004_clients_google.sql` hasn't run yet (section 2). |
| Connect Google: "Error 400: redirect_uri_mismatch" | Add `https://<project-ref>.supabase.co/functions/v1/google/callback` to the Google client (section 11.1). |
| Connect Google comes back with "Connect the Google account for your own Cortex email" | You picked a different Google account. Each admin connects their own. |
| "Reconnect your Google account in Settings" | Google withdrew Cortex's access (password change, revoked, or the scopes changed). **Connect Google** again. |
| Create contract: "Template or folder not found" | The template or folder isn't shared with your Google account, or a link is wrong (section 11.4–5). |
| Connect Google: after allowing access, a `supabase.co` page shows a 401 "Missing authorization header" | **Enforce JWT verification** is still on for the `google` function. Turn it off (section 11.3), then **Connect Google** again. |
| Connect Google, sending or creating a contract fails with a function error or "Google isn’t set up yet" | The function isn't deployed as `google`, or the Google secrets are missing (section 11.2–3). |
