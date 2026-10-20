-- Cortex 0008: Pipeline's stages are Opportunities → Contacted → First meetings → Demos. Run in the Supabase SQL editor
-- after 0007. Safe to re-run, also statement by statement (the SQL editor may run it that way). Contract:
-- docs/PHASE2.md §14.
--
-- - There's no Won stage: a deal made a client leaves the board (it lives in Clients), and Make client sits on Demos.
--   Deals still at Won move to Demos (those already made a client keep their client and stay off the board).
-- - A meeting booked moves a deal on to First meetings from Opportunities or Contacted (never back from later on). The
--   contact_pipeline trigger is 0003's, with that one change.
-- - deals.stage is free text (no check), so nothing else changes; the app shows any other stage in Opportunities.

begin;

update public.deals set stage = 'Demos' where stage = 'Won';

create or replace function public.contact_pipeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_booked boolean := new.status = 'Meeting booked';
  v_name text := coalesce(nullif(btrim(new.name), ''), nullif(btrim(new.org), ''), 'contact');
  v_owner uuid := coalesce(new.owner_id, auth.uid());
  v_day date := public.user_today(coalesce(new.owner_id, auth.uid()));
  v_deal uuid;
  v_stage text;
begin
  if new.status is null or new.status not in ('Replied', 'Meeting booked')
     or (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return null;
  end if;

  select id, stage into v_deal, v_stage from public.deals where contact_id = new.id order by position, id limit 1;
  if v_deal is null then
    insert into public.deals (name, stage, owner_id, priority, next_step, contact_id, position)
    values (
      coalesce(nullif(btrim(new.org), ''), new.name),
      case when v_booked then 'First meetings' else 'Opportunities' end,
      v_owner, 'P2',
      case when v_booked then 'Prepare meeting with ' else 'Reply to ' end || v_name,
      new.id,
      (select coalesce(max(position) + 1, 0) from public.deals));
  elsif v_booked and v_stage in ('Opportunities', 'Contacted') then
    update public.deals set stage = 'First meetings' where id = v_deal;
  end if;

  if v_owner is not null then
    insert into public.todos (assignee_id, title, day, category, source, ref, position)
    values (
      v_owner,
      case when v_booked then 'Prepare: meeting with ' || v_name else 'Follow up: ' || v_name || ' replied' end,
      v_day, 'Outreach', 'automation', 'contact:' || new.id,
      public.next_todo_position(v_owner, v_day))
    on conflict do nothing;
  end if;

  return null;
end;
$$;

commit;
