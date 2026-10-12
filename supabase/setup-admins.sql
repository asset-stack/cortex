-- Admins: run in the Supabase SQL editor after the migrations (0001, then 0002). Replace the placeholders
-- with real @assetstackai.com addresses in lower case, one ('address', 'role') per line, and keep those
-- addresses out of git. Roles: 'superadmin' (also changes roles, active flags and module access; list at
-- least one) or 'admin' (Settings, finance, approvals). Anyone not listed signs up as staff. Safe to re-run.

insert into public.admin_emails (email, role) values
  ('you@assetstackai.com', 'superadmin'),
  ('colleague@assetstackai.com', 'admin')
on conflict (email) do update set role = excluded.role;

-- For people who signed in before being listed above. This only promotes (SuperAdmins first, so there is
-- one before anything else changes); demote people in Settings → Team.
update public.profiles p set role = 'superadmin'
where p.role <> 'superadmin'
  and exists (select 1 from public.admin_emails a where lower(a.email) = lower(p.email) and a.role = 'superadmin');

update public.profiles p set role = 'admin'
where p.role = 'staff'
  and exists (select 1 from public.admin_emails a where lower(a.email) = lower(p.email) and a.role = 'admin');
