-- Cortex 0005: each person's Tools in My Work (the logins and links they use: Gmail, Apollo, Claude, …). Run once in
-- the Supabase SQL editor after 0004, BEFORE the app version that uses it goes live. Safe to re-run.
--
-- - One row per tool per person: name, link, username / login email and a short sign-in note. No passwords: the note
--   says how to sign in (Google, an invite, the team password manager).
-- - People see and edit their own; admins see and edit everyone's (they set up a new starter's list).

begin;

create table if not exists public.work_tools (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  position int not null default 0,
  name text not null default '',
  url text not null default '',
  username text not null default '',
  how text not null default '',
  notes text not null default '',
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create index if not exists work_tools_user_id_idx on public.work_tools (user_id);

-- RLS, touch(), grants and realtime (as 0002 §7).
alter table public.work_tools enable row level security;
create or replace trigger touch before insert or update on public.work_tools
  for each row execute function public.touch();
revoke all on public.work_tools from anon;
grant select, insert, update, delete on public.work_tools to authenticated;
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'work_tools') then
    alter publication supabase_realtime add table public.work_tools;
  end if;
end $$;

-- Who added a tool is whoever was signed in, and stays so (the SQL editor, with no user, may set it).
create or replace function public.protect_work_tool() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    new.created_by := case when tg_op = 'INSERT' then auth.uid() else old.created_by end;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_work_tool on public.work_tools;
create trigger protect_work_tool
  before insert or update on public.work_tools
  for each row execute function public.protect_work_tool();

-- Your own tools, or anyone's for admins (as todos).
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'work_tools' loop
    execute format('drop policy %I on public.work_tools', p.policyname);
  end loop;
end $$;

create policy tools_select on public.work_tools for select to authenticated
  using ((user_id = auth.uid() and public.is_staff()) or public.is_admin());
create policy tools_insert on public.work_tools for insert to authenticated
  with check ((user_id = auth.uid() and public.is_staff()) or public.is_admin());
create policy tools_update on public.work_tools for update to authenticated
  using ((user_id = auth.uid() and public.is_staff()) or public.is_admin())
  with check ((user_id = auth.uid() and public.is_staff()) or public.is_admin());
create policy tools_delete on public.work_tools for delete to authenticated
  using ((user_id = auth.uid() and public.is_staff()) or public.is_admin());

commit;
