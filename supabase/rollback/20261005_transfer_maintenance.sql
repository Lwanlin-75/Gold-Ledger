-- First deploy the previous frontend. Keep all audit tables and current ledger data.
begin;
set local lock_timeout='10s';
lock table public.gold_ledger in share row exclusive mode;
drop trigger transfer_maintenance_ledger_guard on public.gold_ledger;
drop trigger transfer_issue_item_changes on transfer_maintenance.items;
do $$ declare f record;begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'transfer\_%' escape '\' loop
    execute 'drop function '||f.signature;
  end loop;
end $$;
CREATE OR REPLACE FUNCTION public.append_special_record(p_key text, p_record jsonb, p_counter_field text DEFAULT NULL::text, p_counter_increment integer DEFAULT 0)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d jsonb;
  new_history jsonb;
  cur_counter int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select data into d from gold_ledger where worker = p_key for update;
  if d is null then
    d := jsonb_build_object('history', '[]'::jsonb);
  end if;
  new_history := coalesce(d->'history','[]'::jsonb) || jsonb_build_array(p_record);
  d := jsonb_set(d, '{history}', new_history);
  if p_counter_field is not null then
    cur_counter := coalesce((d->>p_counter_field)::int, 0) + p_counter_increment;
    d := jsonb_set(d, array[p_counter_field], to_jsonb(cur_counter));
  end if;
  insert into gold_ledger(worker, data, updated_at) values (p_key, d, now())
  on conflict (worker) do update set data = excluded.data, updated_at = now();
  return cur_counter;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_match_record(p_key text, p_record_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d jsonb;
  target jsonb;
  new_history jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select data into d from gold_ledger where worker = p_key for update;
  if d is null then return; end if;

  select elem into target
  from jsonb_array_elements(coalesce(d->'history','[]'::jsonb)) elem
  where (elem->>'id') = p_record_id;

  if target is null then return; end if;
  if (target->>'kind') is distinct from 'match' then
    raise exception 'not authorized to delete this record type';
  end if;

  select coalesce(jsonb_agg(elem), '[]'::jsonb) into new_history
  from jsonb_array_elements(coalesce(d->'history','[]'::jsonb)) elem
  where (elem->>'id') <> p_record_id;

  update gold_ledger set data = jsonb_set(d,'{history}', new_history), updated_at = now()
  where worker = p_key;
end;
$function$;
revoke all on function public.append_special_record(text,jsonb,text,integer),public.delete_match_record(text,text) from public,anon;
grant execute on function public.append_special_record(text,jsonb,text,integer),public.delete_match_record(text,text) to authenticated;
alter schema transfer_maintenance rename to transfer_maintenance_archive_20261005;
notify pgrst,'reload schema';
commit;
