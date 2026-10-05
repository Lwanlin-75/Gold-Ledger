-- Additive safety upgrade. Requires both 20261005 transfer migrations.
begin;
set local lock_timeout='10s';
lock table public.gold_ledger in share row exclusive mode;

create table transfer_maintenance.ledger_safety_function_backup as
select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('upsert_draft_item','remove_draft_item','save_day','edit_history_record',
  'update_special_field','append_special_record','update_special_record','admin_delete_special_record','get_ledger_rows','get_special_row');
alter table transfer_maintenance.ledger_safety_function_backup enable row level security;
revoke all on transfer_maintenance.ledger_safety_function_backup from public,anon,authenticated;

create function transfer_maintenance.business_today() returns date
language sql stable set search_path=pg_catalog as $$select (now() at time zone 'Asia/Kuala_Lumpur')::date$$;

create function transfer_maintenance.require_worker(p_worker text,p_date text default null) returns void
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated';end if;
  if p_worker not in ('JJ','PD Lv2','PD Lv1','倒模','Lv1车花','Lv1倒模') then raise exception 'invalid_worker';end if;
  if not public.is_admin() and not exists(select 1 from transfer_maintenance.employee_workers
    where employee_id=auth.uid() and worker=p_worker) then raise exception 'worker_scope_denied';end if;
  if p_date is not null and (p_date::date>transfer_maintenance.business_today() or
    (not public.is_admin() and p_date::date<transfer_maintenance.business_today()-3)) then
    raise exception 'date_outside_allowed_range';end if;
end $$;

create function public.ledger_get_worker_scope() returns text[]
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated';end if;
  if public.is_admin() then return array['JJ','PD Lv2','PD Lv1','倒模','Lv1车花','Lv1倒模'];end if;
  return coalesce((select array_agg(worker order by worker) from transfer_maintenance.employee_workers
    where employee_id=auth.uid()),'{}'::text[]);
end $$;

do $$declare p record;definition text;begin
  for p in select oid from pg_proc where oid in ('public.get_ledger_rows(text[])'::regprocedure,'public.get_special_row(text)'::regprocedure) loop
    definition:=replace(pg_get_functiondef(p.oid),'current_date','transfer_maintenance.business_today()');
    execute definition;
  end loop;
end $$;

-- Record every committed ledger mutation. Audit failure rolls back the mutation.
create table transfer_maintenance.ledger_events(
  event_id bigint generated always as identity primary key,
  worker text not null, operation text not null, actor_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  reason text, before_data jsonb, after_data jsonb
);
alter table transfer_maintenance.ledger_events enable row level security;
revoke all on transfer_maintenance.ledger_events from public,anon,authenticated;
create function transfer_maintenance.audit_ledger() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  insert into transfer_maintenance.ledger_events(worker,operation,actor_id,reason,before_data,after_data)
  values(coalesce(new.worker,old.worker),tg_op,auth.uid(),nullif(current_setting('ledger.operation',true),''),
    case when tg_op<>'INSERT' then old.data end,case when tg_op<>'DELETE' then new.data end);
  return coalesce(new,old);
end $$;
create trigger ledger_mutation_audit after insert or update or delete on public.gold_ledger
for each row execute function transfer_maintenance.audit_ledger();

create function public.ledger_get_audit(p_worker text default null,p_before_id bigint default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if not public.is_admin() then raise exception 'not_authorized';end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by event_id desc) from
    (select * from transfer_maintenance.ledger_events where (p_worker is null or worker=p_worker)
      and (p_before_id is null or event_id<p_before_id) order by event_id desc limit greatest(1,least(p_limit,100))) x),'[]');
end $$;

create or replace function public.upsert_draft_item(p_worker text,p_date text,p_item jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d jsonb; prior jsonb;
begin
  perform transfer_maintenance.require_worker(p_worker,p_date);
  if jsonb_typeof(p_item)<>'object' or nullif(p_item->>'id','') is null or
    nullif(btrim(p_item->>'desc'),'') is null or nullif(p_item->>'dest','') is null or
    (p_item->>'amount')::numeric=0 or (p_item->>'amount')::numeric is null then raise exception 'invalid_item';end if;
  perform set_config('ledger.operation','add_draft',true);
  insert into public.gold_ledger(worker,data) values(p_worker,jsonb_build_object('lastWeight',null,'history','[]'::jsonb,'drafts','{}'::jsonb))
    on conflict(worker) do nothing;
  select data into d from public.gold_ledger where worker=p_worker for update;
  select t into prior from (
    select t from jsonb_each(coalesce(d->'drafts','{}')) x cross join lateral jsonb_array_elements(x.value) t
    union all select t from jsonb_array_elements(coalesce(d->'history','[]')) h cross join lateral jsonb_array_elements(coalesce(h->'transactions','[]')) t
  ) tx where t->>'id'=p_item->>'id' limit 1;
  if prior is not null then
    if prior=p_item then return;end if;
    raise exception 'item_id_conflict';
  end if;
  if exists(select 1 from jsonb_array_elements(coalesce(d->'history','[]')) h where h->>'date'=p_date) then
    raise exception 'day_already_saved_edit_history';end if;
  d:=jsonb_set(d,'{drafts}',coalesce(d->'drafts','{}'));
  d:=jsonb_set(d,array['drafts',p_date],coalesce(d#>array['drafts',p_date],'[]')||jsonb_build_array(p_item));
  update public.gold_ledger set data=d,updated_at=now() where worker=p_worker;
end $$;

-- Preserve inspected implementations privately; wrappers add scope and lock before read.
alter function public.remove_draft_item(text,text,text) set schema transfer_maintenance;
alter function transfer_maintenance.remove_draft_item(text,text,text) rename to remove_draft_base;
create function public.remove_draft_item(p_worker text,p_date text,p_item_id text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform transfer_maintenance.require_worker(p_worker,p_date);
  perform 1 from public.gold_ledger where worker=p_worker for update;
  perform set_config('ledger.operation','delete_draft',true);
  perform transfer_maintenance.remove_draft_base(p_worker,p_date,p_item_id);
end $$;

alter function public.edit_history_record(text,text,text,jsonb,numeric) set schema transfer_maintenance;
alter function transfer_maintenance.edit_history_record(text,text,text,jsonb,numeric) rename to edit_history_base;
-- Fix the inherited UTC permission boundary without changing historical rows.
do $$declare definition text;begin
  definition:=pg_get_functiondef('transfer_maintenance.edit_history_base(text,text,text,jsonb,numeric)'::regprocedure);
  definition:=replace(definition,'current_date','transfer_maintenance.business_today()');
  execute definition;
end $$;
create function public.edit_history_record(p_worker text,p_old_date text,p_new_date text,p_transactions jsonb,p_actual numeric)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform transfer_maintenance.require_worker(p_worker,p_old_date);
  perform transfer_maintenance.require_worker(p_worker,p_new_date);
  if p_actual is null or p_actual<0 or jsonb_typeof(p_transactions)<>'array' then raise exception 'invalid_history';end if;
  if exists(select 1 from jsonb_array_elements(p_transactions) t group by t->>'id' having count(*)>1)
    or exists(select 1 from jsonb_array_elements(p_transactions) t where nullif(t->>'id','') is null) then raise exception 'duplicate_item_id';end if;
  perform 1 from public.gold_ledger where worker=p_worker for update;
  if p_old_date<>p_new_date and exists(select 1 from public.gold_ledger g cross join lateral jsonb_array_elements(coalesce(g.data->'history','[]')) h
    where g.worker=p_worker and h->>'date'=p_new_date) then raise exception 'date_already_exists';end if;
  perform set_config('ledger.operation','edit_history',true);
  perform transfer_maintenance.edit_history_base(p_worker,p_old_date,p_new_date,p_transactions,p_actual);
end $$;

create or replace function public.save_day(p_worker text,p_date text,p_actual numeric) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d jsonb; hist jsonb; tx jsonb; prev numeric; total numeric; expected numeric;
begin
  perform transfer_maintenance.require_worker(p_worker,p_date);
  if p_actual is null or p_actual<0 then raise exception 'invalid_actual';end if;
  perform set_config('ledger.operation','save_day',true);
  insert into public.gold_ledger(worker,data) values(p_worker,jsonb_build_object('lastWeight',null,'history','[]'::jsonb,'drafts','{}'::jsonb)) on conflict(worker) do nothing;
  select data into d from public.gold_ledger where worker=p_worker for update;
  hist:=coalesce(d->'history','[]');
  if exists(select 1 from jsonb_array_elements(hist) h where h->>'date'>=p_date) then raise exception 'save_days_in_order';end if;
  tx:=coalesce(d#>array['drafts',p_date],'[]');
  prev:=(hist->-1->>'actual')::numeric;
  select coalesce(sum((t->>'amount')::numeric),0) into total from jsonb_array_elements(tx) t;
  expected:=prev+total;
  d:=jsonb_set(d,'{history}',hist||jsonb_build_array(jsonb_build_object('date',p_date,'prevWeight',prev,'transactions',tx,
    'total',total,'expected',expected,'actual',p_actual,'loss',p_actual-expected,'exported',false)));
  d:=jsonb_set(d,'{drafts}',coalesce(d->'drafts','{}')-p_date);
  d:=jsonb_set(d,'{lastWeight}',to_jsonb(p_actual));
  update public.gold_ledger set data=d,updated_at=now() where worker=p_worker;
end $$;

-- Atomic field mutation; the old implementation had a read/overwrite race.
create or replace function public.update_special_field(p_key text,p_field text,p_value jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not public.is_admin() then raise exception 'not_authorized';end if;
  if not ((p_key in ('__SHIPMENTS__','__TRANSFERS__') and p_field='threshold') or
      (p_key in ('JJ','PD Lv2','PD Lv1','倒模','Lv1车花','Lv1倒模') and p_field='boxWeight'))
    or (p_value#>>'{}')::numeric<0 or p_value='null' then raise exception 'invalid_setting';end if;
  perform set_config('ledger.operation','update_'||p_field,true);
  insert into public.gold_ledger(worker,data) values(p_key,jsonb_build_object(p_field,p_value))
    on conflict(worker) do update set data=jsonb_set(public.gold_ledger.data,array[p_field],p_value),updated_at=now();
end $$;

-- Generic JSON entry points may not bypass the shipment transaction or Worker scope.
alter function public.append_special_record(text,jsonb,text,integer) set schema transfer_maintenance;
alter function transfer_maintenance.append_special_record(text,jsonb,text,integer) rename to append_special_base;
create function public.append_special_record(p_key text,p_record jsonb,p_counter_field text default null,p_counter_increment integer default 0)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_key='__SHIPMENTS__' then raise exception 'use_shipment_create_with_flow';end if;
  if not public.is_admin() then raise exception 'not_authorized';end if;
  return transfer_maintenance.append_special_base(p_key,p_record,p_counter_field,p_counter_increment);
end $$;
alter function public.update_special_record(text,text,jsonb) set schema transfer_maintenance;
alter function transfer_maintenance.update_special_record(text,text,jsonb) rename to update_special_base;
create function public.update_special_record(p_key text,p_record_id text,p_patch jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not public.is_admin() then raise exception 'not_authorized';end if;
  if p_key<>'__SHIPMENTS__' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in
    ('status','confirmDate','confirmWeight','serial','diff')) then raise exception 'invalid_shipment_patch';end if;
  perform set_config('ledger.operation','confirm_shipment',true);
  perform transfer_maintenance.update_special_base(p_key,p_record_id,p_patch);
end $$;

create function public.shipment_create_with_flow(p_record jsonb,p_flow_description text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d jsonb; existing jsonb; total numeric; rec jsonb; worker_name text;
begin
  worker_name:=p_record->>'fromWorker';
  perform transfer_maintenance.require_worker(worker_name,p_record->>'date');
  if worker_name not in ('JJ','PD Lv2','Lv1车花') or p_record->>'toWorker' is distinct from 'PD门市' or
    nullif(p_record->>'id','') is null or nullif(p_record->>'sentItemId','') is null or
    nullif(btrim(p_flow_description),'') is null or jsonb_typeof(p_record->'items')<>'array' then raise exception 'invalid_shipment';end if;
  select sum((t->>'weight')::numeric) into total from jsonb_array_elements(p_record->'items') t;
  if total is null or total<=0 or exists(select 1 from jsonb_array_elements(p_record->'items') t where (t->>'weight')::numeric<=0) then raise exception 'invalid_shipment_weight';end if;
  -- Special row first, then source Worker: same order as Match/Issue/Archive.
  insert into public.gold_ledger(worker,data) values('__SHIPMENTS__',jsonb_build_object('history','[]'::jsonb,'threshold',0.05)) on conflict(worker) do nothing;
  select data into d from public.gold_ledger where worker='__SHIPMENTS__' for update;
  rec:=p_record||jsonb_build_object('sentTotal',total,'status','pending','serial','','confirmDate',null,'confirmWeight',null,'diff',null);
  select h into existing from jsonb_array_elements(coalesce(d->'history','[]')) h where h->>'id'=rec->>'id';
  if existing is not null then
    if existing=rec then return existing;end if;
    raise exception 'shipment_id_conflict';
  end if;
  perform public.upsert_draft_item(worker_name,rec->>'date',jsonb_build_object('id',rec->>'sentItemId','desc',p_flow_description,'amount',-total,'dest','PD门市'));
  perform set_config('ledger.operation','create_shipment_with_flow',true);
  update public.gold_ledger set data=jsonb_set(d,'{history}',coalesce(d->'history','[]')||jsonb_build_array(rec)),updated_at=now() where worker='__SHIPMENTS__';
  return rec;
end $$;

create function transfer_maintenance.recompute_history(hist jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare prev numeric; r jsonb; result jsonb:='[]'; total numeric;
begin
  for r in select h from jsonb_array_elements(hist) h loop
    if not coalesce((r->>'exported')::boolean,false) then
      select coalesce(sum((t->>'amount')::numeric),0) into total from jsonb_array_elements(coalesce(r->'transactions','[]')) t;
      r:=r||jsonb_build_object('total',total,'expected',prev+total,'loss',(r->>'actual')::numeric-prev-total);
    end if;
    r:=r||jsonb_build_object('prevWeight',prev);result:=result||jsonb_build_array(r);prev:=(r->>'actual')::numeric;
  end loop;
  return result;
end $$;

create function public.shipment_delete_with_flow(p_record_id text,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare ship jsonb; r jsonb; d jsonb; hist jsonb; drafts jsonb; result jsonb:='[]'; day_key text; flow_id text;
begin
  if not public.is_admin() or nullif(btrim(p_reason),'') is null then raise exception 'not_authorized_or_reason_required';end if;
  select data into ship from public.gold_ledger where worker='__SHIPMENTS__' for update;
  select h into r from jsonb_array_elements(coalesce(ship->'history','[]')) h where h->>'id'=p_record_id;
  if r is null then return jsonb_build_object('already_deleted',true);end if;
  flow_id:=r->>'sentItemId';
  select data into d from public.gold_ledger where worker=r->>'fromWorker' for update;
  if flow_id is not null then
    if exists(select 1 from jsonb_array_elements(coalesce(d->'history','[]')) h where h->>'date'=r->>'date'
      and coalesce((h->>'exported')::boolean,false)) then raise exception 'shipment_flow_archived_review_required';end if;
    drafts:=coalesce(d->'drafts','{}');
    for day_key in select jsonb_object_keys(drafts) loop
      drafts:=jsonb_set(drafts,array[day_key],coalesce((select jsonb_agg(t) from jsonb_array_elements(drafts->day_key) t where t->>'id'<>flow_id),'[]'));
    end loop;
    for hist in select h from jsonb_array_elements(coalesce(d->'history','[]')) h loop
      hist:=jsonb_set(hist,'{transactions}',coalesce((select jsonb_agg(t) from jsonb_array_elements(coalesce(hist->'transactions','[]')) t where t->>'id'<>flow_id),'[]'));
      result:=result||jsonb_build_array(hist);
    end loop;
    result:=transfer_maintenance.recompute_history(result);
    d:=d||jsonb_build_object('drafts',drafts,'history',result,'lastWeight',result->-1->'actual');
    perform set_config('ledger.operation','delete_shipment: '||p_reason,true);
    update public.gold_ledger set data=d,updated_at=now() where worker=r->>'fromWorker';
  end if;
  update public.gold_ledger set data=jsonb_set(ship,'{history}',coalesce((select jsonb_agg(h) from jsonb_array_elements(ship->'history') h where h->>'id'<>p_record_id),'[]')),updated_at=now() where worker='__SHIPMENTS__';
  return jsonb_build_object('deleted',true);
end $$;
create or replace function public.admin_delete_special_record(p_key text,p_record_id text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_key<>'__SHIPMENTS__' then raise exception 'use_transfer_undo_match';end if;
  perform public.shipment_delete_with_flow(p_record_id,'Cancelled from shipment UI');
end $$;

create function public.ledger_undo_last_day(p_worker text,p_expected_record jsonb,p_reason text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d jsonb; hist jsonb; r jsonb; drafts jsonb;
begin
  if not public.is_admin() or nullif(btrim(p_reason),'') is null then raise exception 'not_authorized_or_reason_required';end if;
  perform transfer_maintenance.require_worker(p_worker);
  select data into d from public.gold_ledger where worker=p_worker for update;
  hist:=coalesce(d->'history','[]');r:=hist->-1;
  if r is null or r<>p_expected_record then raise exception 'ledger_changed_refresh_required';end if;
  if coalesce((r->>'exported')::boolean,false) then raise exception 'archived_day_cannot_undo';end if;
  drafts:=coalesce(d->'drafts','{}');
  drafts:=jsonb_set(drafts,array[r->>'date'],coalesce(r->'transactions','[]')||coalesce(drafts->(r->>'date'),'[]'));
  hist:=hist-(jsonb_array_length(hist)-1);
  perform set_config('ledger.operation','undo_day: '||p_reason,true);
  update public.gold_ledger set data=d||jsonb_build_object('history',hist,'drafts',drafts,'lastWeight',hist->-1->'actual'),updated_at=now() where worker=p_worker;
end $$;

create function public.ledger_archive_batch(p_records jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare request jsonb; r jsonb; d jsonb; idx integer; protected boolean; archived integer:=0; retained jsonb:='[]';
begin
  if not public.is_admin() then raise exception 'not_authorized';end if;
  if jsonb_typeof(p_records)<>'array' or jsonb_array_length(p_records)>1000 then raise exception 'invalid_archive_batch';end if;
  if exists(select 1 from jsonb_array_elements(p_records) x group by x->>'worker',x->>'date' having count(*)>1) then raise exception 'duplicate_archive_record';end if;
  -- Shared lock order with pairing/issue resolution.
  perform 1 from public.gold_ledger where worker='__TRANSFERS__' for update;
  perform 1 from public.gold_ledger where worker in(select x->>'worker' from jsonb_array_elements(p_records) x) order by worker for update;
  for request in select x from jsonb_array_elements(p_records) x loop
    perform transfer_maintenance.require_worker(request->>'worker');
    select data into d from public.gold_ledger where worker=request->>'worker';
    select h,ord::integer-1 into r,idx from jsonb_array_elements(coalesce(d->'history','[]')) with ordinality x(h,ord) where h->>'date'=request->>'date';
    if r is null or r is distinct from request->'record' then raise exception 'ledger_changed_since_export';end if;
    if coalesce((r->>'exported')::boolean,false) then continue;end if;
    select exists(select 1 from jsonb_array_elements(coalesce(r->'transactions','[]')) t
      where exists(select 1 from transfer_maintenance.transfer_issues i where i.status<>'RESOLVED' and t->>'id'=any(i.outgoing_item_ids||i.incoming_item_ids))
        or exists(select 1 from transfer_maintenance.items ti where ti.item_id=t->>'id' and not exists(
          select 1 from transfer_maintenance.members m join transfer_maintenance.matches a using(match_id) where m.item_id=ti.item_id and a.status<>'cancelled'))
        or exists(select 1 from public.gold_ledger s cross join lateral jsonb_array_elements(coalesce(s.data->'history','[]')) h
          where s.worker='__SHIPMENTS__' and h->>'sentItemId'=t->>'id')) into protected;
    protected:=protected or exists(select 1 from transfer_maintenance.items ti
      join transfer_maintenance.transfer_issues issue on ti.item_id=any(issue.outgoing_item_ids||issue.incoming_item_ids)
      where ti.worker=request->>'worker' and ti.date::text=request->>'date' and issue.status<>'RESOLVED');
    if protected then
      retained:=retained||jsonb_build_array(jsonb_build_object('worker',request->>'worker','date',request->>'date','reason','unmatched_open_issue_or_shipment'));
      continue;
    end if;
    perform set_config('ledger.operation','archive_exported_batch',true);
    d:=jsonb_set(d,array['history',idx::text],r||jsonb_build_object('exported',true,'transactions','[]'::jsonb));
    update public.gold_ledger set data=d,updated_at=now() where worker=request->>'worker';archived:=archived+1;
  end loop;
  return jsonb_build_object('archived_days',archived,'retained',retained);
end $$;

-- No public/private execution paths may expose underlying bypass implementations.
revoke all on all functions in schema transfer_maintenance from public,anon,authenticated;
revoke all on function public.ledger_get_worker_scope(),public.ledger_get_audit(text,bigint,integer),
  public.shipment_create_with_flow(jsonb,text),public.shipment_delete_with_flow(text,text),
  public.ledger_undo_last_day(text,jsonb,text),public.ledger_archive_batch(jsonb) from public,anon;
grant execute on function public.ledger_get_worker_scope(),public.ledger_get_audit(text,bigint,integer),
  public.shipment_create_with_flow(jsonb,text),public.shipment_delete_with_flow(text,text),
  public.ledger_undo_last_day(text,jsonb,text),public.ledger_archive_batch(jsonb) to authenticated;
revoke all on function public.upsert_draft_item(text,text,jsonb),public.remove_draft_item(text,text,text),
  public.edit_history_record(text,text,text,jsonb,numeric),public.save_day(text,text,numeric),
  public.append_special_record(text,jsonb,text,integer),public.update_special_record(text,text,jsonb) from public,anon;
grant execute on function public.upsert_draft_item(text,text,jsonb),public.remove_draft_item(text,text,text),
  public.edit_history_record(text,text,text,jsonb,numeric),public.save_day(text,text,numeric),
  public.append_special_record(text,jsonb,text,integer),public.update_special_record(text,text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
