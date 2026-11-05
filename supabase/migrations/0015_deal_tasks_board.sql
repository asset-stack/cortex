-- Cortex 0015 (docs/PHASE2.md §25): Pipeline › Deal tasks, the one board a deal's next steps live on.
-- Run in the Supabase SQL editor after 0014, once the release that knows the board is live (an older app would show it
-- as an ordinary Operations board, in the menu and in New task). Safe to re-run, also statement by statement (the SQL
-- editor may run it that way). No new table or column: the app opens without it (a deal's Add next step then uses
-- Operations' boards, as before),
-- and the board arrives through the boards sync like any other. Demo mode makes the same board in src/data/seed.js
-- (the seed and migrate()); keep the id in step with DEAL_TASKS_BOARD in src/data/boards.js.
--
-- - Why: the owner wants a task added on a deal (e.g. a demo to prepare, for Josh) to live with the deal, in the CRM, and
--   show in its owner's task lists, not on Operations › Team Tasks as well.
-- - What: one team board with a fixed id, named Deal tasks, with one group (Next steps). Underneath it is an Operations
--   ('projects') board: Operations' access (staff edit, as when next steps were on Team Tasks), its policies and
--   triggers, and its tasks can move to and from Operations' boards. The app shows it as Pipeline's and puts it in no
--   menu; its columns are its own (Owner, Also on, Status, Priority, Due, Deal).
-- - Nothing else changes: who may add, change or delete tasks, groups and boards is 0006's, as for every team board.

begin;

insert into public.boards (id, module, name, position)
select 'dea15000-0000-4000-8000-000000000001', 'projects', 'Deal tasks',
  coalesce((select max(position) + 1 from public.boards where module = 'projects' and owner_id is null), 0)
where not exists (select 1 from public.boards where id = 'dea15000-0000-4000-8000-000000000001');

insert into public.board_groups (board_key, board_id, name, color, position)
select 'projects', 'dea15000-0000-4000-8000-000000000001', 'Next steps', '#c9ffe6', 0
where exists (select 1 from public.boards where id = 'dea15000-0000-4000-8000-000000000001')
  and not exists (select 1 from public.board_groups where board_id = 'dea15000-0000-4000-8000-000000000001');

commit;

select 'Cortex 0015 applied' as done;
