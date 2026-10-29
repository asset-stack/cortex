-- Cortex 0015: every deal's stage history (docs/PHASE2.md §22). Run in the Supabase SQL editor after 0014. Safe to re-run,
-- also statement by statement (the SQL editor may run it that way). The app opens and works without it (the history and
-- the reports that need it stay empty until it has run).
--
-- - deal_stage_history: a row each time a deal is added (from '' to its stage), moves stage, or is made a client (to
--   'Won'), with when and who. Written only by the log_deal_stage trigger (security definer), never by the app; read with
--   Pipeline view, like deals; it goes with its deal. Synced (read only) for the deal's timeline and the Pipeline reports
--   (time in each stage, conversion, wins).
-- - Existing deals, once: a starting row at their current stage, when they reached it (stage_at), by nobody, or 'Won'
--   for one already made a client.

begin;

create table if not exists public.deal_stage_history (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  from_stage text not null default '' check (char_length(from_stage) <= 60),
  to_stage text not null default '' check (char_length(to_stage) <= 60),
  changed_at timestamptz not null default now(),
  changed_by uuid references public.profiles (id) on delete set null
);
create index if not exists deal_stage_history_deal_idx on public.deal_stage_history (deal_id, changed_at);

-- A deal added, moved to another stage, or made a client (its client set for the first time: Won).
create or replace function public.log_deal_stage() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.deal_stage_history (deal_id, from_stage, to_stage, changed_by)
    values (new.id, '', left(coalesce(new.stage, ''), 60), auth.uid());
  else
    if new.stage is distinct from old.stage then
      insert into public.deal_stage_history (deal_id, from_stage, to_stage, changed_by)
      values (new.id, left(coalesce(old.stage, ''), 60), left(coalesce(new.stage, ''), 60), auth.uid());
    end if;
    if new.client_id is not null and old.client_id is null then
      insert into public.deal_stage_history (deal_id, from_stage, to_stage, changed_by)
      values (new.id, left(coalesce(new.stage, ''), 60), 'Won', auth.uid());
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.log_deal_stage() from public, anon, authenticated;

drop trigger if exists log_deal_stage on public.deals;
create trigger log_deal_stage after insert or update of stage, client_id on public.deals
  for each row execute function public.log_deal_stage();

-- Read only, on Pipeline's access level; the trigger writes.
alter table public.deal_stage_history enable row level security;
revoke all on public.deal_stage_history from anon, authenticated;
grant select on public.deal_stage_history to authenticated;

do $$
declare
  p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'deal_stage_history' loop
    execute format('drop policy %I on public.deal_stage_history', p.policyname);
  end loop;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'deal_stage_history') then
    alter publication supabase_realtime add table public.deal_stage_history;
  end if;
end $$;

create policy module_select on public.deal_stage_history for select to authenticated
  using (public.is_staff() and public.can_view('pipeline'));

-- Existing deals: where they stand, once.
insert into public.deal_stage_history (deal_id, from_stage, to_stage, changed_at)
select d.id, '', case when d.client_id is not null then 'Won' else left(d.stage, 60) end, coalesce(d.stage_at, d.updated_at, now())
from public.deals d
where not exists (select 1 from public.deal_stage_history h where h.deal_id = d.id);

commit;

select 'Cortex 0015 applied' as done;
