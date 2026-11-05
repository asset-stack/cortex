-- Cortex 0014 (docs/PHASE2.md §23): a deal that reaches Demos or Proposal sent gets its row on Clients › Demos, by itself.
-- Run in the Supabase SQL editor after 0013. Safe to re-run, also statement by statement (the SQL editor may run it that
-- way): no statement relies on another having run in the same transaction or session. No new table or column: the app
-- needs nothing from it to open, and the row arrives through the items sync like any task. Demo mode does the same in
-- src/lib/automations.js (dealDemoRowLocal()); change both together.
--
-- - Why: the owner wants every deal in Demos or Proposal sent on Clients › Demos, once, without anyone adding it by hand.
-- - When: only as a deal ENTERS Demos or Proposal sent: added there, or moved there from another stage. Moving between
--   the two (Demos ⇄ Proposal sent), or saving a deal that is already there, adds nothing, so a row someone deleted
--   stays deleted until the deal leaves the two and comes back.
-- - No double-ups: nothing is added when a task on any Clients team board already links the deal (values.deal).
-- - Where: the first Clients team board (by position; Demos to start), in its first group. A Clients module with no
--   team board, or a board with no group, gets nothing (and the deal still saves).
-- - The row: a task named after the deal, its Owner the deal's owner (none when it has none), Not started, linked to the
--   deal (values.deal) and, once the deal has one, its client (values.client). Not a hand-over: no assignedBy /
--   assignedAt, so it needs no accepting.
-- - Security definer (as 0008's contact_pipeline): whoever moves the deal may have only Clients view, and the row is
--   added all the same. Who may add, change or delete tasks on Clients boards is unchanged (0006's board policies).

begin;

-- 1. The rule ------------------------------------------------------------------------------------------------------

create or replace function public.deal_demo_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_board uuid;
  v_group uuid;
begin
  if not coalesce(new.stage in ('Demos', 'Proposal sent'), false)
     or (tg_op = 'UPDATE' and coalesce(old.stage in ('Demos', 'Proposal sent'), false)) then
    return null;
  end if;

  if exists (select 1 from public.items i join public.boards b on b.id = i.board_id
             where b.module = 'clients' and b.owner_id is null and i."values" ->> 'deal' = new.id::text) then
    return null;
  end if;

  select id into v_board from public.boards
  where module = 'clients' and owner_id is null order by position, id limit 1;
  if v_board is null then
    return null;
  end if;
  select id into v_group from public.board_groups where board_id = v_board order by position, id limit 1;
  if v_group is null then
    return null;
  end if;

  insert into public.items (board_key, board_id, group_id, position, name, "values", done)
  values (
    'clients', v_board, v_group,
    (select coalesce(max(position) + 1, 0) from public.items where group_id = v_group),
    coalesce(nullif(btrim(new.name), ''), 'Deal'),
    jsonb_build_object(
      'people', case when new.owner_id is null then '[]'::jsonb else jsonb_build_array(new.owner_id::text) end,
      'status', 'Not started',
      'deal', new.id::text)
      || case when new.client_id is null then '{}'::jsonb else jsonb_build_object('client', new.client_id::text) end,
    false);

  return null;
end;
$$;

revoke all on function public.deal_demo_row() from public, anon, authenticated;

-- 2. The trigger ---------------------------------------------------------------------------------------------------

drop trigger if exists deal_demo_row on public.deals;
create trigger deal_demo_row after insert or update of stage on public.deals
  for each row execute function public.deal_demo_row();

commit;

select 'Cortex 0014 applied' as done;
