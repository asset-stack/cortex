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
and each admin's Google connection; see section 11), then `0005_work_tools.sql` (each person's Tools in My Work),
then `0006_boards.sql` (the boards under Projects and Marketing, and each person's own Projects page), then
`0007_outreach.sql` (Outreach, read from the outreach agent's Google Sheet, see section 12; and the boards under
Outreach and Clients, `docs/PHASE2.md` §13), then `0008_pipeline_stages.sql` (Pipeline's stages: Opportunities →
Contacted → First meetings → Demos, and Work in Progress under the deals; `docs/PHASE2.md` §14), then
`0009_calendar.sql` (the team Calendar and the boards' 3-month calendar; Google meetings need section 13;
`docs/PHASE2.md` §15), then `0010_outreach_gmail.sql` (Outreach counted from each mailbox's Gmail; section 14;
`docs/PHASE2.md` §16), then `0011_team_access_read.sql` (everyone reads everyone's access levels, for the Team pages;
`docs/PHASE2.md` §18), then `0012_crm_profile.sql` (a deal's and a client's profile: meetings, notes and links;
`docs/PHASE2.md` §19), then `0013_task_emails.sql` (a task's owner is emailed when a task is handed to them or an update
is posted on it; section 15; `docs/PHASE2.md` §21).

Later schema changes arrive as new numbered files in `supabase/migrations/` (`0014_…`). Run each new file
once, in order, the same way. Never run an older file after a newer one. From `0013`, each file ends with a line that
prints `Cortex 00NN applied`: if the SQL editor doesn't show that row, the file didn't finish (look for the error above
it). To check that a file with a new table ran, `select to_regclass('public.<table>');` shows the table's name, or
NULL when it isn't there (for 0012: `select to_regclass('public.crm_entries');`).

If the app reaches the live site before its file has run, Cortex still opens: what the file adds is off (no rows, no
saving), and admins see a notice naming the file to run. Run it, then reload.

**0003 on a database that already has 0002**: **SQL Editor** → **+** → **Create a new snippet**, paste
`supabase/migrations/0003_timezones_projects_view.sql` and **Run** *before* deploying the code that needs it (the
app saves `profiles.timezone`, which doesn't exist until then). It is one transaction and safe to re-run.
Afterwards staff view Projects instead of editing it (give one person edit in **Settings → Team**), invoice dates
follow Sydney, and each person's time zone is set the next time they open Cortex.

**0004 on a database that already has 0003**: paste `supabase/migrations/0004_clients_google.sql` the same way and
**Run** *before* the app version that uses it goes live (it loads `client_contacts`, which doesn't exist until then).
Then run `supabase/migrations/0005_work_tools.sql` the same way (each person's Tools in My Work). Both are one
transaction each and safe to re-run. Each client's key contact and email become its first contact, marked **Billing**
(invoices go to billing contacts). Running it again after the deploy picks up a key contact typed into an old open
tab in between, without duplicating. Then set up section 11.

**0006 on an existing database**: `0004` and `0005` must have run first (run them in order if not, as above). Ask
everyone to **close Cortex** first. Then paste `supabase/migrations/0006_boards.sql` into a new snippet and **Run** it
*before* the app version that uses it goes live (it loads the `boards` table, which doesn't exist until then). The SQL
editor may run it statement by statement and carry on past an error, so it is written to be run again: if Supabase
shows an error, send it to whoever maintains Cortex, and running the current file again finishes the job (it only
adds the starting boards and groups until a run has completed).
The editor warns about destructive operations because the file drops and recreates its own policies on the board
tables: choose **Run this query**. Afterwards:
- Projects has the team boards **Landing Page**, **Tender Portal** and **General** (the existing Projects groups and
  tasks), Marketing has **Daily Automation**, **Posting schedule** (the existing Marketing groups and tasks),
  **Campaigns** and **Events**. Admins add, rename, order and delete team boards in the app; they are data, not code.
- Everyone has their own Projects page (*Name’s Projects*), and each new person gets one on first sign-in. The
  SuperAdmin sees everyone's, an admin their own and staff's, staff their own. Personal pages can't be renamed or
  deleted.
- Staff edit Projects again by default (0003 had made it view-only): the team Projects and Marketing boards and their
  own page. Only admins add, rename, order or delete boards. To make one person view-only on Projects, the SuperAdmin
  sets Projects to **View** for them in **Settings** → **Team**. Under 0003, View was the default, so choosing it was
  not stored: anyone you set back to View before 0006 edits again afterwards. Note who they are before running 0006
  and set them to View again after the deploy (it is stored now).
- Tasks move between groups and between team boards of the same module, but not onto or off someone's own page (who
  can see them would change). Re-running 0006 later changes nothing people did: it doesn't bring back deleted boards
  or add groups to emptied ones.
- Deploy the new app straight after, then everyone opens Cortex again (or reloads). A tab left open on the old app
  until then still saves, but it shows the new boards' starting groups (several **Active** / **To do** groups) on one
  page, and a task added to one of those goes to that board, possibly someone's own page. A group it adds goes on
  **General** / **Posting schedule**.

**0007 on an existing database**: run it after `0006` (run any earlier file that hasn't run first, in order, as above).
Paste `supabase/migrations/0007_outreach.sql` into a new snippet and **Run** it *before* the app version that uses it
goes live (the app loads the Outreach tables, which don't exist until then). Until the change is merged, take the
file from its branch or pull request on GitHub (**Raw**), not from `main`. Nobody needs to close Cortex. The
editor warns about destructive operations because the file drops and recreates its own policies on the Outreach
tables: choose **Run this query**. It is safe to run again, also when the editor runs it statement by statement and
carries on past an error: if Supabase shows an error, send it to whoever maintains Cortex and run the current file
again. Afterwards:
- **Table Editor** lists `outreach_mailboxes`, `outreach_emails`, `outreach_notes` and `outreach_settings`, none of
  them **Unrestricted**. **Database** → **Publications** → `supabase_realtime` lists the mailboxes, notes and settings
  tables, not `outreach_emails` (only the sheet sync writes it, and the app reads it on demand).
- **Table Editor** → `boards` has the new team boards **Sales Tasks** (module `outreach`) and **Demos** and
  **Previews** (module `clients`), each with a *To do* group. In the app they sit under **Outreach** (after the
  **Email dashboard**) and **Clients** (after the client list) and follow each person's Outreach / Clients access in
  **Settings** → **Team**: staff see Outreach's boards only once given View or Edit, and read Clients' boards (View by
  default) until given Edit.
- Then redeploy the `google` function, deploy the new app and set up Outreach (section 12).

**0008 on an existing database**: run it after `0007`, the same way (a new snippet, paste
`supabase/migrations/0008_pipeline_stages.sql`, **Run**; until merged, take it from its branch or pull request on GitHub).
It moves deals still at Won to Demos (Pipeline has no Won column any more: a deal made a client leaves the board),
lets a meeting booked move a Contacted deal on to First meetings, and adds **Work in Progress** under the deals (a
team board with an *Active* group; **Table Editor** → `boards` lists it with module `pipeline`). Run it **before** the
new app goes live (the app that's live now works with it): until it has run, the new app shows no Work in Progress and
a meeting booked leaves a Contacted deal where it is, though it shows any deal still at Won in Demos. Nobody needs to
close Cortex, and it is safe to run again.

**0009 on an existing database**: run it after `0008`, the same way (`supabase/migrations/0009_calendar.sql`; until
merged, take it from its branch on GitHub). It adds the team's Calendar events, the table the Google meetings sync into
(only the `google` function writes it), and a **calendar** switch on boards, turned on once for Marketing's **Posting
schedule** (**Table Editor** → `boards`: `calendar` is true for it). Run it **before** the new app goes live: the new
app reads and writes these and fails to load without them (the app that's live now works with it). Nobody needs to close
Cortex, and it is safe to run again.

**0010 on an existing database**: run it after `0009`, the same way (`supabase/migrations/0010_outreach_gmail.sql`;
until merged, take it from its branch on GitHub). It adds each outreach mailbox's Gmail connection (unreadable from the
app), the cold threads and messages read from Gmail (only the `google` function writes them) and the functions Outreach
reads them through. Run it **before** the new app goes live (the app that's live now works with it). Nobody needs to
close Cortex, and it is safe to run again.

**0011 on an existing database**: run it after `0010`, the same way (`supabase/migrations/0011_team_access_read.sql`;
until merged, take it from its branch on GitHub). It changes one read rule: every active teammate can read everyone's
module access levels (None / View / Edit), so the Team pages, the Owner picker and New task judge a teammate's access
the same way for staff as for admins. Only the SuperAdmin still changes them. Run it **before** the new app goes live
(the app that's live now works with it). Nobody needs to close Cortex, and it is safe to run again.

**0012 on an existing database**: run it after `0011`, the same way (`supabase/migrations/0012_crm_profile.sql`;
until merged, take it from its branch on GitHub). It adds the profile entries of deals and clients (notes, meetings
with a link to their notes, and links), and gives a deal's entries to its client when it is made a client. Nothing
existing changes: a client's older notes show in its timeline as they are. Run it **before** the new app goes live (the
app that's live now works with it). Nobody needs to close Cortex, and it is safe to run again.

**0013 on an existing database**: run it after `0012`, the same way (`supabase/migrations/0013_task_emails.sql`;
until merged, take it from its branch on GitHub). The last row shows `Cortex 0013 applied`. It adds the task email queue
and its rules (section 15). Nothing existing changes and nobody is emailed until an admin turns task emails on. It can
run before or after the new app goes live. Nobody needs to close Cortex, and it is safe to run again.

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
   the **Active** switch, and each staff member's access to **Operations** (the Projects module), **Marketing**,
   **Outreach**, **Pipeline** and **Clients** (None / View / Edit). Staff start with Operations and Marketing on Edit,
   Pipeline and Clients on View, and Outreach on None; admins always have Edit. Admins see the page read-only.
   Give staff **Edit** on Clients so they can own, accept and update client work (Demos, Previews).
   Each person also gets their own page (**My notes** on their Dashboard), which they can always edit (unless
   Operations is None for them).
   Switching Active off removes all of that person's access at once, because every database policy checks it.
   Your own row is locked, and the last active SuperAdmin can't be demoted or deactivated.
4. Admins set each person's daily routines in **Settings** → **Routines**; they appear on that person's
   **Dashboard** each day.
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
- [ ] The outreach sheet's link and the mailbox addresses are only in **Settings** → **Outreach**, never in the repo.
  The sheet holds prospects' names and emails: share it only with the agent's account and the people who need it.

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

**Disconnecting**: **Settings** → **Business** → **Disconnect** removes your stored Google access from Cortex (and, if
you connected your Google Calendar too, takes your meetings off the team Calendar). To
revoke it at Google too: <https://myaccount.google.com/connections>. When someone leaves, deactivating them in
**Settings** → **Team** also stops their connection from being used.

## 12. Outreach (the agent's sheet)

**Outreach** shows the cold email the outreach agent (a separate Claude agent, outside Cortex) sends from each outreach
mailbox. The agent logs every prospect in its own Google Sheet. Cortex reads that sheet into the database through the
`google` Edge Function, **with the Google account of the admin who linked it**, and writes a **Summary** tab, a
**Notes** tab and **a tab per mailbox** (named after it: that mailbox's rows) back into it. Cortex never sends outreach email and never changes the agent's rows. This needs section 11 steps
1–3 done and that admin's Google connected (11.5). Contract: `docs/PHASE2.md` §12 (and §13 for the boards under
Outreach and Clients).

1. **Database**: run `0007_outreach.sql` (section 2, *0007 on an existing database*).
2. **Google Cloud** (<https://console.cloud.google.com>, the Cortex project) → **APIs & Services** → **Library** →
   **Google Sheets API** → **Enable**. No new scope: the `drive` scope from section 11 covers Sheets, so nobody has to
   reconnect.
3. **Redeploy the `google` function**: Supabase → **Edge Functions** → `google` → **Code**. Replace all of it with the
   new `supabase/functions/google/index.ts` (GitHub → **Raw**, copy all; before the merge in step 4, from the change's
   branch or pull request, since `main` still has the old one, which answers the sync with "Not found.") → **Deploy**
   (it may read **Deploy updates**). The new file is safe to deploy first: the invoice and contract routes are
   unchanged. Then check its settings: **Enforce JWT verification** stays **off**. The secrets don't change.
4. **Deploy the app** (merge to `main`) once 0007 has run, and reload Cortex.
5. **The sheet** (the agent's *Email Outbound Tracker*):
   - Add a column headed `sender` in row 1, anywhere: Cortex finds columns by their header (in any case), so the
     order doesn't matter, but don't rename the existing headers (renaming one blanks that field in Cortex).
   - Fill `sender` for the existing rows with the address each row was sent from, for example
     `name@your-outreach-domain`, or `name@your-old-domain` for rows from before a domain change. Rows left blank show
     as **Unassigned**.
   - Share the sheet as **Editor** with the admin who will link it in step 6 (Cortex writes the Summary, Notes and
     mailbox tabs), or keep it in a shared drive they belong to.
6. **Cortex** → **Settings** → **Outreach** (admins):
   - **Sheet**: open the agent's tab, copy the link from the address bar (it ends in `#gid=…`, which picks the tab)
     and paste it. Whoever pastes it must have connected Google (**Settings** → **Business**) with an account that can
     edit the sheet: every sync reads it as them, whoever clicks **Sync now**.
   - **Mailboxes**: add the three mailboxes, each with a name, its person (if they use Cortex) and **every address it
     has sent from**, for example both `name@your-old-domain` and `name@your-outreach-domain`. Each mailbox is its own
     data set; an address belongs to one mailbox. The name is also its tab in the sheet (David, Josh, Sarah), so it
     can't be Summary, Notes or another mailbox's name, and shouldn't be the agent's tab's name (that one gets no tab).
   - Open **Outreach** → **Sync now**. The numbers should match the sheet, and the sheet gains **Summary**, **Notes**
     and one tab per mailbox.
7. **The agent's instructions** (wherever the outreach agent's prompt or skill lives):
   - Fill `sender` on **every** row it logs (sent, draft or skipped) with the address of the mailbox it is working
     for, exactly as listed in **Settings** → **Outreach**.
   - Keep **one tab shared by all mailboxes**, so its checks dedupe prospects across mailboxes (nobody is emailed from
     two), and keep the header names.
   - Don't write in the **Summary**, **Notes** or mailbox tabs (David, Josh, Sarah): Cortex rewrites them on every
     sync. Log only in the shared tab. Notes are written in Cortex.
8. **Access**: admins see Outreach. Staff start with None; the SuperAdmin gives someone **View** (the dashboard, the
   emails and the notes, and **Sync now**) or **Edit** (also writing notes) in **Settings** → **Team**.

**Using it**
- Outreach reads the sheet when someone opens it and the last sync is more than 10 minutes old, and on **Sync now**.
  There is no schedule, so the sheet's **Summary**, **Notes** and mailbox tabs are as of the last time someone did.
- Renaming a mailbox in Cortex gives it a new tab at the next sync; the old one stays (Cortex never deletes tabs):
  delete it.
- Each email links to its Gmail thread in the mailbox it was sent from; you need to be signed in to that mailbox in the
  browser to open it.
- Opens show *Not tracked*: the agent's emails carry no tracking image, which would hurt deliverability on the new
  domains, and Apple Mail makes opens unreliable anyway. `docs/PHASE2.md` §12 says what turning them on would take.
- A new mailbox or sending address: add it in **Settings** → **Outreach** before the agent uses it. Rows from an
  address no mailbox lists show as **Unassigned** until it is added (the next sync moves them). To retire a mailbox,
  switch it off rather than removing it: removing it deletes its notes and leaves its emails Unassigned.
- Syncs read the sheet as the admin who last saved its link (**Settings** → **Outreach** shows *Reads as …*),
  whoever clicks **Sync now**. If that admin leaves or disconnects Google, another admin with Google connected and
  access to the sheet clicks **Use my Google** there: syncs then read the sheet as them. Do this before deactivating
  the admin who linked it: once they're inactive or staff, syncs stop ("<name> is no longer active…" / "… an
  admin…") until another admin clicks **Use my Google**.
- Two people opening Outreach at the same moment may both sync; that's harmless (the newer sync's rows win).

## 13. The team Calendar (Google Calendar)

The **Calendar** shows everything dated in Cortex and, once each person connects theirs, the team's **Google Calendar**
meetings: titles and times, with events marked **Private** (or Confidential) in Google shown only as **Busy**. Cortex
reads each person's primary calendar **read only**, through the `google` Edge Function, and keeps only each meeting's
title, start and end: never its description, place, guests or link. This needs section 11 steps 1–3 done (the Google
client, the Supabase secrets and the `google` function). Contract: `docs/PHASE2.md` §15.

1. **Database**: run `0009_calendar.sql` (section 2, *0009 on an existing database*).
2. **Google Cloud** (<https://console.cloud.google.com>, the Cortex project):
   - **APIs & Services** → **Library** → **Google Calendar API** → **Enable**.
   - **Google Auth Platform** → **Data Access** → **Add or remove scopes**: tick `.../auth/calendar.readonly` (add it
     under **Manually add scopes** if it isn't listed) → **Update** → **Save**. The consent screen is **Internal**, so
     Google doesn't review it.
3. **Redeploy the `google` function**: Supabase → **Edge Functions** → `google` → **Code**. Replace all of it with the
   new `supabase/functions/google/index.ts` (GitHub → **Raw**, copy all; before the merge in step 4, from the change's
   branch or pull request, since `main` still has the old one) → **Deploy** (it may read **Deploy updates**). The new
   file is safe to deploy first: the invoice, contract and Outreach routes are unchanged. **Enforce JWT verification**
   stays **off**; the secrets don't change.
4. **Deploy the new app** (it goes live with the merge to `main`) once 0009 has run, and reload Cortex.
5. **Everyone**: **Calendar** → **Connect Google Calendar** → **Connect** → pick **your own** @assetstackai.com account
   → **Allow**. Back in Cortex the button shows when the team's meetings last synced. Admins who already connected Gmail
   and Drive keep them; staff connect only their calendar. Only this button shares a calendar: connecting Gmail and
   Drive in **Settings** → **Business** never does, even if Google remembers the calendar permission.

**How it syncs**
- Opening the Calendar syncs everyone who has connected when the last sync is more than 10 minutes old; **Sync now**
  (in the same menu) syncs at once. It reads from the start of last month to 11 months ahead. Nothing syncs on a timer,
  so meetings added in Google show the next time someone opens the Calendar.
- The menu lists who shares their calendar. *Reconnect* means Google refused that person's access (they removed it at
  Google, or their password changed): they click **Reconnect Google Calendar**, which shows in place of Connect.
- **Stop sharing** (same menu) takes your meetings off the Calendar at once; an admin's Gmail and Drive stay connected.
  **Settings** → **Business** → **Disconnect** removes the whole Google connection, calendar included. Deactivating
  someone takes their meetings off too.
- Only events you mark **Private** (or Confidential) one by one in Google show as Busy. A calendar's sharing settings
  and its default visibility don't change what Cortex reads with your own account, so to keep a meeting's title off the
  team Calendar, set that event to Private (or don't connect).

## 14. Outreach from Gmail (each mailbox's cold emails)

Once an admin connects a mailbox's **Gmail**, Outreach counts that mailbox straight from Gmail: every cold email it
sends (the first email to a new outside contact and each follow-up in that thread, whether the agent sent it or someone
typed it), the prospects emailed, and what came back: a reply, an auto-reply or out-of-office, or a bounce. A **new
outside contact** is someone outside AssetStack who isn't a colleague, a client contact, an invoice recipient or at a
client's domain, and has never written to that mailbox before. The agent's sheet stays its log: meetings, and each
prospect's organisation, role and tier, still come from it, and a mailbox without Gmail connected is still counted from
the sheet. Cortex reads each mailbox **read only** and keeps, per cold thread, who it went to, when, the subject of our
first email and when the answer came: **never the text of any email**. Emails to clients and colleagues, newsletters
sent as Bcc, calendar invites and everything else in the mailbox aren't kept. This needs section 11 steps 1–3 and
section 12 done. Contract: `docs/PHASE2.md` §16.

1. **Database**: run `0010_outreach_gmail.sql` (section 2, *0010 on an existing database*).
2. **Google Cloud** (<https://console.cloud.google.com>, the Cortex project):
   - **APIs & Services** → **Library** → **Gmail API**: it shows **Manage** if it's already on (it is, for invoice
     email); otherwise **Enable**.
   - **Google Auth Platform** → **Data Access** → **Add or remove scopes**: tick `.../auth/gmail.readonly` (add it under
     **Manually add scopes** if it isn't listed) → **Update** → **Save**. The consent screen is **Internal**, so Google
     doesn't review it.
3. **Google Workspace** (<https://admin.google.com>, only if connecting is blocked in step 6): **Security** → **Access
   and data control** → **API controls** → **Manage Third-Party App Access** → find **Cortex** (or **Configure new
   app** and search for the client ID from section 11) → **Trusted**. Workspaces that limit Gmail access to trusted
   apps need this.
4. **Redeploy the `google` function**: Supabase → **Edge Functions** → `google` → **Code**. Replace all of it with the
   new `supabase/functions/google/index.ts` (GitHub → **Raw**, copy all; before the merge in step 5, from the change's
   branch or pull request, since `main` still has the old one) → **Deploy** (it may read **Deploy updates**). The new
   file is safe to deploy first: the invoice, contract, sheet and calendar routes are unchanged. **Enforce JWT
   verification** stays **off**; the secrets don't change.
5. **Deploy the new app** (it goes live with the merge to `main`) once 0010 has run, and reload Cortex.
6. **Connect each mailbox**: **Settings** → **Outreach** → **Mailboxes**. Each mailbox must list its
   `@assetstackai.com` address. On its row: **Connect Gmail** → **Connect** → Google opens with that address: sign in
   **as the mailbox** (not as yourself, unless it is your own mailbox) → **Allow**. Whoever connects must be a Cortex
   admin and able to sign in to that mailbox (its owner, or an admin with its password). Back in Settings the row reads
   *Reading Gmail · N left* while Cortex reads the last 90 days, then *Gmail: address · synced …*. Leave Settings or
   Outreach open until then: the first read runs in steps of a few hundred threads, only while one of those pages is
   open (if Gmail asks it to slow down, it carries on by itself a minute later).
7. **Tell the team** what Cortex reads and keeps (above), and that the Outreach numbers for a connected mailbox now
   come from Gmail.

**How it counts**
- **Sent**: our cold emails (first emails and follow-ups) on the Sydney day they went. **Prospects**: threads started.
  **Replies**: prospects who answered (once per thread, on the day of their first reply). **Reply rate**: replies ÷
  prospects. **Bounces**: threads that bounced. **Meetings**: from the sheet. Opens stay *Not tracked*.
- A thread is judged once, when Cortex first sees it: our first message, to one to five outside people (colleagues
  copied in don't count), none of them known (above). Our later emails in it count as follow-ups when they go to someone
  outside (forwarding it to a colleague doesn't). Replies, auto-replies and bounces in it are counted as they arrive; a
  reply to someone else's thread is never counted.
- **All** lists each prospect once every mailbox it shows is counted from Gmail (and nothing is Unassigned); until then
  it lists the sheet's emails (pick a mailbox to see its prospects), and the breakdown's *Prospects (Gmail)* covers only
  the Gmail mailboxes.
- Opening Outreach reads new mail when a mailbox was last read over 10 minutes ago; **Sync now** reads at once (with
  the sheet). Nothing reads on a schedule: while a mailbox's first read isn't finished, an open Outreach or Settings →
  Outreach page carries on with it, and tries again a minute later when Gmail asks it to slow down.
- **Disconnect Gmail** (same row) removes that mailbox's Gmail numbers at once, and Outreach counts it from the sheet
  again. Taking the connected address off the mailbox, or reconnecting as a different account, does the same; switching
  the mailbox off keeps its numbers and stops reading (its row says *paused*) until it's switched on again. If the row
  says *reconnect* (the mailbox's password changed, or its access was removed at Google), click **Reconnect Gmail**.
- Only `@assetstackai.com` mailboxes for now. `@assetstack.org` and `@assetstackai.com.au` are a separate Workspace:
  they need their own Google client there before they can connect (`docs/PHASE2.md` §16, *Later*).

## 15. Task emails

A task's **owner** gets an email when someone else **hands them the task** (or makes a new task for them) or **posts an
update** on it, with a link straight to the task. Several at once go as one email. Nobody is emailed about what they
did themselves. The emails come from one admin's Google account (the one connected in **Settings** → **Business**),
named *Cortex*; replies go to that admin. Contract: `docs/PHASE2.md` §21.

This needs section 11 steps 1–3 done (the Google client, the Supabase secrets and the `google` function).

1. **Database**: run `0013_task_emails.sql` (section 2, *0013 on an existing database*). The last row says
   `Cortex 0013 applied`.
2. **Redeploy the `google` function**: Supabase → **Edge Functions** → `google` → **Code**. Replace all of it with the
   new `supabase/functions/google/index.ts` (GitHub → **Raw**, copy all; before the merge, from the change's branch or
   pull request) → **Deploy**. **Enforce JWT verification** stays **off**; the secrets don't change.
3. **Deploy the new app** (it goes live with the merge to `main`), then reload Cortex.
4. **Turn it on**: the admin whose address the emails should come from opens **Settings** → **Business**. Under
   **Google account**, **Connect Google** if it isn't connected yet. Then under **Task emails** → **Send from my Google**.
   It shows *Sent from …*.
5. **Try it**: hand a task to a teammate (or post an update on theirs). Their email arrives within a minute or so.

**How it sends**
- Cortex asks for the emails to go a moment after the change is saved, and again every few minutes while anyone has
  Cortex open, so an email missed (a tab closed straight away) still goes soon after. Nothing sends while nobody has
  Cortex open; emails waiting more than two days are dropped.
- An email goes only if the person is still the task's owner, still active and can still see its board when it is
  sent. Work in Progress rows and done tasks being handed over don't send.
- **Stop** (same place) turns them off. If the sending admin disconnects Google, emails wait and **Task emails** says
  they need to reconnect; another admin can click **Send from my Google** instead.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Connecting Google says "Google didn't accept Cortex's Google key" | The function's `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Supabase → Edge Functions → **Secrets**) aren't a matching, enabled pair on the Google client. Google shows a secret only once: add a new one (section 11 step 1) and put it in both the function secret and **Authentication** → **Google**. The function's **Logs** show each failed connect as a `google callback:` line with Google's or the database's reason. |
| **Connect Google Calendar** says "Only admins can use Google from Cortex.", or the Calendar's sync says "Not found." | The `google` function still runs the old code: redeploy it (section 13 step 3). |
| **Connect Gmail** comes back with "Sign in as one of this mailbox's addresses" | Google was signed in as someone else, or the account isn't listed on the mailbox. Connect again and pick (or add) the mailbox's own account. |
| Google: "Access blocked: … admin_policy_enforced", or "Cortex needs permission to access resources in your organization" when connecting Gmail | The Workspace limits Gmail to trusted apps: section 14 step 3. |
| **Connect Gmail** comes back with "Allow Cortex to read Gmail to connect it" | The Gmail box was unticked on Google's screen, or the scope is missing from **Data Access** (section 14 step 2). Connect again and leave it ticked. |
| Outreach says "Reading Gmail" for a long time | The first read runs only while Outreach or Settings is open (a few hundred threads a step, and it waits a minute when Gmail asks it to slow down). Keep one open; **Sync now** picks it up again at once. |
| A mailbox's numbers changed when its Gmail was read | Expected: Gmail counts every cold email it sent (follow-ups too, and ones the agent didn't log) to new outside contacts only, where the sheet counted the emails the agent logged. |
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
| "Couldn't load your workspace … work_tools" after an update | `0005_work_tools.sql` hasn't run yet (section 2). |
| "Couldn't load your workspace … boards", Projects shows nothing, or "Not saved" mentions `board_id` | `0006_boards.sql` hasn't run yet (section 2). |
| A staff member can edit their own notes but not **Landing Page** or another team board | Their **Operations** (Projects) level is **View** in **Settings** → **Team** (an override; the default after 0006 is Edit). The SuperAdmin sets it back to **Edit**. |
| A task's drawer on someone's own page offers no **Board** to move it to | By design: tasks move between team boards, or between groups of one page, never onto or off a personal page. |
| An admin can't see another admin's notes (*Name’s notes*, once called *Name’s Projects*) | By design: admins see their own and staff's pages; only the SuperAdmin sees everyone's. |
| No rename or delete on someone's notes page | Personal pages come and go with their person. Only team boards are renamed or deleted (by admins). |
| Task emails don't arrive | **Settings** → **Business** → **Task emails**: *Run 0013_task_emails.sql* means section 15 step 1; *Off* means nobody turned them on (step 4); *needs to reconnect Google* or *Last send failed* says what went wrong. Nothing at all after an hour: check the `google` function is the new one (step 2). Also check the recipient's spam folder. |
| "Couldn't load your workspace … crm_entries" after an update (before this was handled: now Cortex opens with a *Database update needed* notice instead) | `0012_crm_profile.sql` hasn't run. In the SQL editor, `select to_regclass('public.crm_entries');`: NULL means run the file (section 2) and look for an error if it doesn't finish; `crm_entries` means the table is there and PostgREST hasn't noticed: run `notify pgrst, 'reload schema';`. Then **Retry**. |
| **Database update needed: run 00NN_….sql** at the top of Cortex (admins) | That migration hasn't run on this database: run it (section 2), then reload. Until then what it adds is off; everything else works. If `select to_regclass('public.<its table>');` already shows the table, PostgREST hasn't noticed it yet: run `notify pgrst, 'reload schema';`, then reload. Still there? Check that the SQL editor's project is the one in Cloudflare's `VITE_SUPABASE_URL`. |
| A staff member reads a deal's or a client's profile but has no **Note**, **Meeting** or **Add link** | Expected with View: adding to a deal's profile needs **Pipeline** Edit, to a client's **Clients** Edit (**Settings** → **Team**). Someone else's entry is changed only by its author or an admin. |
| A deal's profile has no **Next steps**, or no **Add next step** | A deal's next steps are tasks on the Outreach boards: seeing them needs **Outreach** View and adding them Outreach Edit (staff have None by default). |
| On **Team**, a staff member sees fewer of a teammate's tasks than an admin does, or **New task** says a teammate can't edit a board they can | `0011_team_access_read.sql` hasn't run yet (section 2): until then staff read only their own access levels. |
| **Projects** / **Marketing** look empty after running 0006, or it showed an error | The run stopped part-way, so tasks aren't linked to a board yet (nothing is deleted). Run the current `0006_boards.sql` again; it links them to **General** / **Posting schedule** and finishes the rest. |
| A new group turned up on **General** or **Posting schedule** after the 0006 update | An old open tab (the app from before 0006) added it. Move its tasks where they belong, delete it, and reload that tab. |
| A task added just after the 0006 update isn't on **General** / **Posting schedule** | An old open tab added it to another board's starting group (another team board, or someone's own page). Find it in **Dashboard** → **My tasks** (or **Team**) for the people on it, or as the SuperAdmin on each page, and move it to a team board from its drawer (or re-create it there if it is on someone's page). |
| Connect Google: "Error 400: redirect_uri_mismatch" | Add `https://<project-ref>.supabase.co/functions/v1/google/callback` to the Google client (section 11.1). |
| Connect Google comes back with "Connect the Google account for your own Cortex email" | You picked a different Google account. Each admin connects their own. |
| "Reconnect your Google account in Settings" | Google withdrew Cortex's access (password change, revoked, or the scopes changed). **Connect Google** again. |
| Create contract: "Template or folder not found" | The template or folder isn't shared with your Google account, or a link is wrong (section 11.4–5). |
| Connect Google: after allowing access, a `supabase.co` page shows a 401 "Missing authorization header" | **Enforce JWT verification** is still on for the `google` function. Turn it off (section 11.3), then **Connect Google** again. |
| Connect Google, sending or creating a contract fails with a function error or "Google isn’t set up yet" | The function isn't deployed as `google`, or the Google secrets are missing (section 11.2–3). |
| "Couldn't load your workspace … outreach_settings" (or `outreach_mailboxes` / `outreach_notes`) after an update | `0007_outreach.sql` hasn't run yet (section 2). |
| Outreach says "No sheet yet" or "Add the sheet in Settings → Outreach" | No sheet is linked yet. An admin pastes the agent's sheet link in **Settings** → **Outreach** (section 12.6). |
| "Ask an admin to click Use my Google in Settings → Outreach." | Cortex doesn't know whose Google account to read the sheet with (the link was set outside the app, or that admin's account was deleted). An admin with Google connected clicks **Use my Google** in **Settings** → **Outreach**. |
| "… is no longer active." or "… is no longer an admin." (… "Another admin can click Use my Google in Settings → Outreach.") | The admin who linked the sheet was deactivated or made staff, so Cortex stops using their Google account. Another admin with Google connected clicks **Use my Google** in **Settings** → **Outreach**. |
| "… needs to connect Google in Settings → Business." or "… needs to reconnect Google …" | The named admin (who linked the sheet) has no working Google connection. They connect it in **Settings** → **Business**, or another admin clicks **Use my Google** in **Settings** → **Outreach**. |
| **Use my Google**: "Connect Google in Settings → Business first." | Connect your own Google account there, then click it again. |
| "The outreach sheet wasn't found or isn't shared with …" | The named admin's Google account can't open the sheet, or the link is wrong. Share the sheet with them as **Editor** (12.5), or paste the right link. |
| "… can't edit the outreach sheet." | The named admin can read the sheet but not write Cortex's tabs (Summary, Notes, mailbox tabs). Make them **Editor** on it. |
| A mailbox has no tab in the sheet | Its name is the agent's tab's name (or Summary, Notes, or another mailbox's). Rename the mailbox in **Settings** → **Outreach**, then **Sync now**. |
| "The outreach sheet isn't a Google Sheets link." | Paste the sheet's own link (`docs.google.com/spreadsheets/d/…`) in **Settings** → **Outreach**. |
| "The "…" tab has no outreach columns in row 1." | The link opens another tab, or the agent's headers were renamed. Paste the link of the agent's tab, or put the headers back (`docs/PHASE2.md` §12). |
| **Sync now** fails mentioning the Google Sheets API | It isn't enabled in the Google Cloud project (section 12.2). Enable it, wait a few minutes and sync again. |
| **Sync now** fails with "Not found." | The `google` function still runs the old code. Redeploy it (section 12.3). |
| Rows show under **Unassigned** | Their `sender` is blank or an address no mailbox lists. Add the address to its mailbox in **Settings** → **Outreach** (or fill `sender` in the sheet), then **Sync now**. |
| Outreach's numbers differ from the sheet | Cortex shows the last sync (its time is on the page): **Sync now**. Then check the rules: Cortex counts **emails, not rows**: rows with the same `sent_message_id` (one email to two people at an organisation) count once. An email counts as sent on its first `sent_date`, a reply on its first `reply_date` (with a `reply_status`), a meeting on its first `meeting_booked_date`; a row with no `sent_date` isn't sent. Dates must be `YYYY-MM-DD` (or `D/M/YYYY`). |
| One field is blank on every email (no sent dates, no replies, …) | A header in row 1 of the agent's tab was renamed. Put back the name Cortex expects (`docs/PHASE2.md` §12), then **Sync now**. |
| "Paste the link of the agent's tab …", "The tab in the outreach sheet link isn't in the sheet any more …" or "The outreach sheet link opens Cortex's … tab …" | Cortex reads exactly the tab the link opens (`#gid=…`; renaming or moving it is fine). Open the agent's tab, copy the address and paste it in **Settings** → **Outreach**. A re-created tab is a new one, with a new link. |
| The sheet's **Summary**, **Notes** or a mailbox tab is out of date, or a renamed copy stopped updating | They change only when someone opens Outreach or clicks **Sync now**. Cortex writes the tabs named **Summary**, **Notes** and after each mailbox, and adds them when missing, so a renamed copy (or a renamed mailbox's old tab) is left behind: delete it. |
| A Gmail link on an email opens the wrong account or "conversation not found" | The thread is in the mailbox that sent it. Sign in to that mailbox in the same browser (Gmail's account switcher). |
