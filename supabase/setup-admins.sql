-- Admins: run in the Supabase SQL editor after the migration. Replace the placeholder with real
-- @assetstackai.com addresses (keep those out of git). Admins can edit org settings and change
-- anyone's role or active flag; everyone else signs in as a member.

insert into public.admin_emails (email) values
  ('you@assetstackai.com')
on conflict do nothing;

-- For people who signed in before being listed above.
update public.profiles set role = 'admin'
where lower(email) in (select lower(email) from public.admin_emails);
