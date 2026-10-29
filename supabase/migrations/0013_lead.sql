-- Cortex 0013 (docs/PHASE2.md §21): the Lead on deals and clients: whether the work came through our partner LYCO (co-pitched) or is
-- AssetStack direct. Run in the Supabase SQL editor after 0012, BEFORE the app version that uses it goes live (the sync
-- engine sends the Lead with every deal and client it saves). Safe to re-run, also statement by statement (the SQL editor
-- may run it that way): no statement relies on another having run in the same transaction or session.
--
-- - deals.source and clients.source: '' (not set), 'lyco' (LYCO, co-pitched) or 'assetstack' (AssetStack direct).
--   Existing deals and clients start at '' (not set).
-- - Make client carries a deal's Lead to its new client. The app does that (it creates the client, as it does the rest
--   of the client's details), so there is no trigger here.
-- - No new policy: deals and clients keep 0002's module policies (Pipeline / Clients view to read, edit to write), which
--   cover every column, new ones included. Both tables are already in supabase_realtime.

begin;

-- 1. The columns ---------------------------------------------------------------------------------------------------

alter table public.deals add column if not exists source text not null default '';
alter table public.clients add column if not exists source text not null default '';

-- 2. The values ----------------------------------------------------------------------------------------------------

-- Named checks, added only when missing, so a re-run leaves them be.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname = 'deals_source_check') then
    alter table public.deals add constraint deals_source_check check (source in ('', 'lyco', 'assetstack'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.clients'::regclass and conname = 'clients_source_check') then
    alter table public.clients add constraint clients_source_check check (source in ('', 'lyco', 'assetstack'));
  end if;
end $$;

commit;

select 'Cortex 0013 applied' as done;
