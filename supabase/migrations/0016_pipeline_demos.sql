-- Cortex 0016 (docs/PHASE2.md §26): Pipeline › Demos, the deals' tasks. Clients › Demos moves there, and no automatic
-- row any more. Run in the Supabase SQL editor after 0015 (it needs its board), once the release that shows Pipeline ›
-- Demos is live. Safe to re-run, also statement by statement (the SQL editor may run it that way). No new table or
-- column: the app opens without it. Demo mode does the same in src/data/seed.js (migrate(): 'pipelineDemos').
--
-- - Why (owner, 2026-11-01): Clients › Demos should sit under Pipeline and be the tasks for every deal in the pipeline; a
--   task added on a deal (Add task) lives there, and nothing is added by itself next to it.
-- - 1. 0014's automatic row (deal_demo_row: a deal reaching Demos or Proposal sent got a row named after it) goes, if it
--   was ever run. Running 0014 after this would bring it back: don't.
-- - 2. 0015's board (fixed id) is called Demos. It stays an Operations board underneath (Operations' access: staff
--   edit); the app shows it as Pipeline's and lists it under Pipeline in the sidebar.
-- - 3. Clients' team board(s) named Demos (0007's starting board): their groups, in their order, with their tasks
--   (owners, updates, subtasks, status and Deal kept), go after Pipeline › Demos' own groups, and the emptied board is
--   deleted. Tasks keep their Client value, unused there (the board has no Client column). Moving between modules is
--   refused to the app (same_audience); this block switches that check off for its own moves only, and back on.

begin;

-- 1. No automatic row.
drop trigger if exists deal_demo_row on public.deals;
drop function if exists public.deal_demo_row();

-- 2. Its name.
update public.boards set name = 'Demos'
where id = 'dea15000-0000-4000-8000-000000000001' and name = 'Deal tasks';

-- 3. Clients › Demos moves onto it.
do $$
declare
  v_to constant uuid := 'dea15000-0000-4000-8000-000000000001';
  v_next int;
  b record;
begin
  if not exists (select 1 from public.boards where id = v_to) then
    raise notice 'Pipeline › Demos is missing (run 0015 first): Clients › Demos stays where it is';
    return;
  end if;
  for b in select id from public.boards where module = 'clients' and owner_id is null and name = 'Demos' order by position, id loop
    alter table public.board_groups disable trigger same_audience;
    alter table public.items disable trigger same_audience;
    select coalesce(max(position), -1) + 1 into v_next from public.board_groups where board_id = v_to;
    update public.board_groups set board_id = v_to, board_key = 'projects', position = v_next + position where board_id = b.id;
    update public.items set board_id = v_to, board_key = 'projects' where board_id = b.id;
    alter table public.board_groups enable trigger same_audience;
    alter table public.items enable trigger same_audience;
    delete from public.boards where id = b.id;
  end loop;
end $$;

commit;

select 'Cortex 0016 applied' as done;
