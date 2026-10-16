-- Cortex 0006: Projects and Marketing sub-boards (the sidebar's sub-menus), and each person's own Projects page. Run
-- once in the Supabase SQL editor after 0004 and 0005, BEFORE the app version that uses it goes live. One transaction;
-- safe to re-run. Contract: docs/PHASE2.md §11.
--
-- - public.boards: the boards under a module. Team boards (owner_id null) are added, renamed, ordered and deleted by
--   admins. To start: Projects → Landing Page, Tender Portal and General (the existing Projects board);
--   Marketing → Daily Automation, Posting schedule (the existing Marketing board), Campaigns and Events.
-- - A personal board (owner_id set; one per person, Projects only) shows as "<Name>'s Projects". Its owner edits it,
--   admins see and edit staff's, and the SuperAdmin sees and edits everyone's. Made for everyone now and for each new
--   profile from now on.
-- - board_groups.board_id and items.board_id say which board a group or task is on; board_key stays the module. Groups,
--   tasks, subtasks and updates now follow their board's access (public.board_level), the same rules as
--   boardLevel() in src/lib/access.js. Team boards keep the module's level (staff view Projects by default).

begin;

-- 1. Boards ------------------------------------------------------------------------------------------------------

create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('projects', 'marketing')),
  name text not null default '',
  owner_id uuid references public.profiles (id) on delete cascade,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  constraint boards_personal_projects check (owner_id is null or module = 'projects'),
  constraint boards_id_module_key unique (id, module)
);

create unique index if not exists boards_owner_key on public.boards (owner_id) where owner_id is not null;

-- The starting team boards, once per module (a module that already has team boards is left as it is).
do $$
begin
  if not exists (select 1 from public.boards where module = 'projects' and owner_id is null) then
    insert into public.boards (module, name, position)
    values ('projects', 'Landing Page', 0), ('projects', 'Tender Portal', 1), ('projects', 'General', 2);
  end if;
  if not exists (select 1 from public.boards where module = 'marketing' and owner_id is null) then
    insert into public.boards (module, name, position)
    values ('marketing', 'Daily Automation', 0), ('marketing', 'Posting schedule', 1), ('marketing', 'Campaigns', 2),
           ('marketing', 'Events', 3);
  end if;
end $$;

-- Everyone's own Projects page.
insert into public.boards (module, owner_id)
select 'projects', p.id from public.profiles p
on conflict (owner_id) where owner_id is not null do nothing;

-- 2. Groups and tasks sit on a board -----------------------------------------------------------------------------

alter table public.board_groups add column if not exists board_id uuid;
alter table public.items add column if not exists board_id uuid;

-- The existing Projects groups go on General, the Marketing ones on Posting schedule (else the module's first team
-- board, if an admin renamed them before a re-run).
update public.board_groups g set board_id = (
  select b.id from public.boards b
  where b.module = g.board_key and b.owner_id is null
  order by b.name = case g.board_key when 'projects' then 'General' else 'Posting schedule' end desc, b.position, b.id
  limit 1)
where g.board_id is null;

update public.items i set board_id = g.board_id
from public.board_groups g where g.id = i.group_id and i.board_id is distinct from g.board_id;

alter table public.board_groups alter column board_id set not null;
alter table public.items alter column board_id set not null;

-- A group is on a board of its own module, and a task on its group's board (moving a group moves its tasks).
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.board_groups'::regclass
                 and conname = 'board_groups_board_fkey') then
    alter table public.board_groups add constraint board_groups_board_fkey foreign key (board_id, board_key)
      references public.boards (id, module) on update cascade on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.board_groups'::regclass
                 and conname = 'board_groups_id_board_id_key') then
    alter table public.board_groups add constraint board_groups_id_board_id_key unique (id, board_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.items'::regclass
                 and conname = 'items_group_board_id_fkey') then
    alter table public.items add constraint items_group_board_id_fkey foreign key (group_id, board_id)
      references public.board_groups (id, board_id) on update cascade on delete cascade;
  end if;
end $$;

create index if not exists board_groups_board_id_idx on public.board_groups (board_id);
create index if not exists items_board_id_idx on public.items (board_id);

-- A board with no groups starts with one, so it has somewhere to add tasks.
insert into public.board_groups (board_key, board_id, name, color, position)
select b.module, b.id, case b.module when 'projects' then 'Active' else 'To do' end, '#c9ffe6', 0
from public.boards b
where not exists (select 1 from public.board_groups g where g.board_id = b.id);

-- Writes that don't name a board (an app version from before this migration, still open in a tab) land where they
-- did before: a new group on General / Posting schedule (else the module's first team board), a task on its group's
-- board.
create or replace function public.place_on_board() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'board_groups' then
    if new.board_id is null then
      new.board_id := (select id from public.boards
                       where module = new.board_key and owner_id is null
                       order by name = case new.board_key when 'projects' then 'General' else 'Posting schedule' end desc,
                                position, id
                       limit 1);
    end if;
  elsif new.board_id is null
     or (tg_op = 'UPDATE' and new.group_id is distinct from old.group_id and new.board_id = old.board_id) then
    new.board_id := (select board_id from public.board_groups where id = new.group_id);
  end if;
  return new;
end;
$$;

drop trigger if exists place_on_board on public.board_groups;
create trigger place_on_board before insert or update on public.board_groups
  for each row execute function public.place_on_board();
drop trigger if exists place_on_board on public.items;
create trigger place_on_board before insert or update on public.items
  for each row execute function public.place_on_board();

-- New people get their own Projects page (with one group) when their profile is made.
create or replace function public.add_personal_board() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_board uuid;
begin
  insert into public.boards (module, owner_id) values ('projects', new.id)
  on conflict (owner_id) where owner_id is not null do nothing
  returning id into v_board;
  if v_board is not null then
    insert into public.board_groups (board_key, board_id, name, color, position)
    values ('projects', v_board, 'Active', '#c9ffe6', 0);
  end if;
  return new;
end;
$$;

drop trigger if exists add_personal_board on public.profiles;
create trigger add_personal_board after insert on public.profiles
  for each row execute function public.add_personal_board();

-- 3. Access ------------------------------------------------------------------------------------------------------

-- Whose personal page the signed-in user may open: their own; staff's for admins; everyone's for the SuperAdmin.
create or replace function public.sees_person(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() and (
    p_user = auth.uid()
    or public.is_superadmin()
    or (public.is_admin() and exists (select 1 from public.profiles where id = p_user and role = 'staff'))
  );
$$;

-- 'none' | 'view' | 'edit' on a board: a team board has its module's level; a personal board is 'edit' for whoever may
-- open it (while they can see the module at all), else 'none'.
create or replace function public.board_level(p_board uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when b.owner_id is null then
        case when public.can_edit(b.module) then 'edit' when public.can_view(b.module) then 'view' else 'none' end
      when public.can_view(b.module) and public.sees_person(b.owner_id) then 'edit'
      else 'none'
    end
    from public.boards b where b.id = p_board), 'none');
$$;

create or replace function public.can_view_board(p_board uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.board_level(p_board) <> 'none';
$$;

create or replace function public.can_edit_board(p_board uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.board_level(p_board) = 'edit';
$$;

-- The board a task (and so its updates and subtasks) is on, read past the items policies.
create or replace function public.item_board_id(p_item uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select board_id from public.items where id = p_item;
$$;

revoke all on function public.sees_person(uuid) from public, anon;
revoke all on function public.board_level(uuid) from public, anon;
revoke all on function public.can_view_board(uuid) from public, anon;
revoke all on function public.can_edit_board(uuid) from public, anon;
revoke all on function public.item_board_id(uuid) from public, anon;
grant execute on function public.sees_person(uuid) to authenticated;
grant execute on function public.board_level(uuid) to authenticated;
grant execute on function public.can_view_board(uuid) to authenticated;
grant execute on function public.can_edit_board(uuid) to authenticated;
grant execute on function public.item_board_id(uuid) to authenticated;

-- 4. RLS, touch(), grants and realtime for boards (as 0002 §7) ---------------------------------------------------

alter table public.boards enable row level security;
create or replace trigger touch before insert or update on public.boards
  for each row execute function public.touch();
revoke all on public.boards from anon;
grant select, insert, update, delete on public.boards to authenticated;
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'boards') then
    alter publication supabase_realtime add table public.boards;
  end if;
end $$;

-- 5. Policies ----------------------------------------------------------------------------------------------------

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['boards', 'board_groups', 'items', 'item_updates', 'subtasks'] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- Boards: seen with the module (a personal one only by those who may open it); team boards are the admins' to add,
-- rename, order and delete. Personal boards come and go with their person.
create policy boards_select on public.boards for select to authenticated
  using (public.can_view(module) and (owner_id is null or public.sees_person(owner_id)));
create policy boards_insert on public.boards for insert to authenticated
  with check (owner_id is null and public.is_admin());
create policy boards_update on public.boards for update to authenticated
  using (owner_id is null and public.is_admin()) with check (owner_id is null and public.is_admin());
create policy boards_delete on public.boards for delete to authenticated
  using (owner_id is null and public.is_admin());

-- Groups and tasks: view the board to read, edit it to write.
do $$
declare t text;
begin
  foreach t in array array['board_groups', 'items'] loop
    execute format('create policy board_select on public.%I for select to authenticated
      using (public.can_view_board(board_id))', t);
    execute format('create policy board_insert on public.%I for insert to authenticated
      with check (public.can_edit_board(board_id))', t);
    execute format('create policy board_update on public.%I for update to authenticated
      using (public.can_edit_board(board_id)) with check (public.can_edit_board(board_id))', t);
    execute format('create policy board_delete on public.%I for delete to authenticated
      using (public.can_edit_board(board_id))', t);
  end loop;
end $$;

create policy board_select on public.subtasks for select to authenticated
  using (public.can_view_board(public.item_board_id(item_id)));
create policy board_insert on public.subtasks for insert to authenticated
  with check (public.can_edit_board(public.item_board_id(item_id)));
create policy board_update on public.subtasks for update to authenticated
  using (public.can_edit_board(public.item_board_id(item_id)))
  with check (public.can_edit_board(public.item_board_id(item_id)));
create policy board_delete on public.subtasks for delete to authenticated
  using (public.can_edit_board(public.item_board_id(item_id)));

-- Updates: their author (or an admin) edits and deletes them, on a board they can edit.
create policy board_select on public.item_updates for select to authenticated
  using (public.can_view_board(public.item_board_id(item_id)));
create policy author_insert on public.item_updates for insert to authenticated
  with check (user_id = auth.uid() and public.can_edit_board(public.item_board_id(item_id)));
create policy author_update on public.item_updates for update to authenticated
  using ((user_id = auth.uid() or public.is_admin()) and public.can_edit_board(public.item_board_id(item_id)))
  with check ((user_id = auth.uid() or public.is_admin()) and public.can_edit_board(public.item_board_id(item_id)));
create policy author_delete on public.item_updates for delete to authenticated
  using ((user_id = auth.uid() or public.is_admin()) and public.can_edit_board(public.item_board_id(item_id)));

commit;
