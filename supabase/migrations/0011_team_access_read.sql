-- Cortex 0011: every active teammate can read everyone's module access levels (None / View / Edit per module), so the
-- Team pages, the Owner picker and New task work out what another person can see and edit the same way for staff as for
-- admins (docs/PHASE2.md §18). Until now staff read only their own levels, so to them every other staff member looked
-- like the staff defaults. Levels aren't secret; changing them stays the SuperAdmin's alone (insert, update and delete
-- are unchanged). Run in the Supabase SQL editor after 0010, before the app version that uses it goes live. Safe to
-- re-run, also statement by statement.

begin;

drop policy if exists access_select on public.module_access;
create policy access_select on public.module_access for select to authenticated
  using (public.is_staff());

commit;
