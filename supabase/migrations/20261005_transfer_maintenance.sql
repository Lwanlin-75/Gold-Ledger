-- Additive migration for the inspected production JSONB schema. Never run supabase_setup.sql.
begin;
set local lock_timeout = '10s';
lock table public.gold_ledger in share row exclusive mode;

create schema transfer_maintenance;
revoke all on schema transfer_maintenance from public, anon, authenticated;

create table transfer_maintenance.items (
  item_id text primary key,
  worker text not null,
  counterparty text not null,
  date date not null,
  amount numeric not null check (amount <> 0 and amount not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  description text not null default '',
  created_at timestamptz,
  first_seen_at timestamptz not null default clock_timestamp(),
  available boolean not null default true,
  archived boolean not null default false,
  snapshot jsonb not null,
  check (worker <> counterparty)
);
create index items_date_pair on transfer_maintenance.items(date, worker, counterparty) where available;
create table transfer_maintenance.matches (
  match_id text primary key,
  status text not null check (status in ('active','legacy_conflict','cancelled')),
  created_at timestamptz,
  created_by uuid,
  source text not null check (source in ('manual_ui','maintenance','auto','legacy')),
  note text,
  total_out numeric not null,
  total_in numeric not null,
  difference numeric not null,
  original_record jsonb not null,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text
);
create table transfer_maintenance.members (
  match_id text not null references transfer_maintenance.matches(match_id),
  item_id text not null,
  direction text not null check (direction in ('outgoing','incoming')),
  active boolean not null,
  snapshot jsonb not null,
  primary key(match_id,item_id)
);
-- The database, not a frontend check, enforces one active match per item.
create unique index one_active_match_per_item on transfer_maintenance.members(item_id) where active;
create index members_item_claims on transfer_maintenance.members(item_id,match_id);
create table transfer_maintenance.audit (
  audit_id bigint generated always as identity primary key,
  match_id text not null references transfer_maintenance.matches(match_id),
  action text not null check (action in ('import','apply','undo')),
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  source text not null,
  note text,
  details jsonb not null
);
alter table transfer_maintenance.items enable row level security;
alter table transfer_maintenance.matches enable row level security;
alter table transfer_maintenance.members enable row level security;
alter table transfer_maintenance.audit enable row level security;
revoke all on all tables in schema transfer_maintenance from public, anon, authenticated;
revoke all on all sequences in schema transfer_maintenance from public, anon, authenticated;

create function transfer_maintenance.require_admin() returns void
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'admin_required' using errcode = '42501';
  end if;
end $$;

create function transfer_maintenance.lane(p_worker text,p_counterparty text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when (p_worker='JJ' and p_counterparty='PD Lv2') or (p_worker='PD Lv2' and p_counterparty='JJ') then 'A'
    when (p_worker='PD Lv2' and p_counterparty='PD Lv1') or (p_worker='PD Lv1' and p_counterparty='PD Lv2') then 'B'
    else 'other' end
$$;

create function transfer_maintenance.extract_items(p_worker text, p_data jsonb)
returns table(item_id text, worker text, counterparty text, date date, amount numeric, description text, snapshot jsonb)
language sql immutable set search_path = pg_catalog as $$
  with tx as (
    select d.key as day, t as item
    from jsonb_each(coalesce(p_data->'drafts','{}')) d
    cross join lateral jsonb_array_elements(d.value) t
    union all
    select h->>'date', t
    from jsonb_array_elements(coalesce(p_data->'history','[]')) h
    cross join lateral jsonb_array_elements(coalesce(h->'transactions','[]')) t
  )
  select item->>'id', p_worker, item->>'dest', day::date,
         (item->>'amount')::numeric, coalesce(item->>'desc',''), item
  from tx
  where nullif(item->>'id','') is not null
    and p_worker in ('JJ','PD Lv2','PD Lv1','倒模','Lv1车花','Lv1倒模','Lv1倒模车花')
    and item->>'dest' in ('JJ','PD Lv2','PD Lv1','倒模','Lv1车花','Lv1倒模','Lv1倒模车花')
    and item->>'dest' <> p_worker and (item->>'amount')::numeric <> 0
$$;

create function transfer_maintenance.sync_worker(p_worker text, p_data jsonb, p_backfill boolean default false)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare r record; old_item transfer_maintenance.items; ids text[] := '{}';
begin
  for r in select * from transfer_maintenance.extract_items(p_worker,p_data) loop
    select * into old_item from transfer_maintenance.items where item_id=r.item_id;
    if found and old_item.worker <> r.worker then
      raise exception 'ambiguous_item_id: %',r.item_id;
    end if;
    if r.item_id = any(ids) then
      if (old_item.date,old_item.amount,old_item.counterparty,old_item.description)
         is distinct from (r.date,r.amount,r.counterparty,r.description) then
        raise exception 'ambiguous_item_id: %',r.item_id;
      end if;
      continue;
    end if;
    ids := array_append(ids,r.item_id);
    if not p_backfill and old_item.item_id is not null and
       (old_item.date,old_item.amount,old_item.counterparty,old_item.description)
       is distinct from (r.date,r.amount,r.counterparty,r.description) and exists (
         select 1 from transfer_maintenance.members mm join transfer_maintenance.matches m using(match_id)
         where mm.item_id=r.item_id and m.status <> 'cancelled'
       ) then raise exception 'undo_match_before_editing: %',r.item_id; end if;
    insert into transfer_maintenance.items(item_id,worker,counterparty,date,amount,description,created_at,snapshot)
    values(r.item_id,r.worker,r.counterparty,r.date,r.amount,r.description,
      case when p_backfill then null else clock_timestamp() end,r.snapshot)
    on conflict(item_id) do update set counterparty=excluded.counterparty,date=excluded.date,
      amount=excluded.amount,description=excluded.description,snapshot=excluded.snapshot,available=true,archived=false;
  end loop;
  -- Archiving clears the UI's transactions. Keep their maintenance snapshots queryable.
  update transfer_maintenance.items i set archived=true
  where i.worker=p_worker and not (i.item_id=any(ids)) and exists (
    select 1 from jsonb_array_elements(coalesce(p_data->'history','[]')) h
    where h->>'date'=i.date::text and coalesce((h->>'exported')::boolean,false)
  );
  if not p_backfill and exists (
    select 1 from transfer_maintenance.items i join transfer_maintenance.members mm using(item_id)
    join transfer_maintenance.matches m using(match_id)
    where i.worker=p_worker and not(i.item_id=any(ids)) and not i.archived and i.available and m.status <> 'cancelled'
  ) then raise exception 'undo_match_before_deleting'; end if;
  update transfer_maintenance.items set available=false
  where worker=p_worker and not(item_id=any(ids)) and not archived;
end $$;

create function transfer_maintenance.match_sides(p_record jsonb)
returns table(direction text,item jsonb)
language sql immutable set search_path = pg_catalog as $$
  select 'outgoing',x from jsonb_array_elements(case
    when jsonb_typeof(p_record->'outgoing')='array' then p_record->'outgoing'
    when p_record ? 'itemIdA' then jsonb_build_array(jsonb_build_object('itemId',p_record->'itemIdA',
      'worker',p_record->'workerA','date',p_record->'dateA','amount',p_record->'amountA','desc',p_record->'descA'))
    else '[]'::jsonb end) x
  union all
  select 'incoming',x from jsonb_array_elements(case
    when jsonb_typeof(p_record->'incoming')='array' then p_record->'incoming'
    when p_record ? 'itemIdB' then jsonb_build_array(jsonb_build_object('itemId',p_record->'itemIdB',
      'worker',p_record->'workerB','date',p_record->'dateB','amount',p_record->'amountB','desc',p_record->'descB'))
    else '[]'::jsonb end) x
$$;

-- Backfill without touching a byte of gold_ledger data or renumbering old matches.
do $$ declare r record; h jsonb; s record; begin
  for r in select worker,data from public.gold_ledger where worker not like '\_\_%' escape '\' loop
    perform transfer_maintenance.sync_worker(r.worker,r.data,true);
  end loop;
  for h in select x from public.gold_ledger g cross join lateral jsonb_array_elements(coalesce(g.data->'history','[]')) x
      where g.worker='__TRANSFERS__' and x->>'kind'='match' loop
    insert into transfer_maintenance.matches(match_id,status,created_at,source,total_out,total_in,difference,original_record)
    values(h->>'id','active',null,'legacy',coalesce((h->>'totalOut')::numeric,abs((h->>'amountA')::numeric),0),
      coalesce((h->>'totalIn')::numeric,(h->>'amountB')::numeric,0),
      coalesce((h->>'diff')::numeric,0),h);
    -- Import all claims first as inactive, so historical conflicts can be retained safely.
    for s in select * from transfer_maintenance.match_sides(h) loop
      insert into transfer_maintenance.members values(h->>'id',s.item->>'itemId',s.direction,false,s.item)
      on conflict(match_id,item_id) do nothing;
    end loop;
    insert into transfer_maintenance.audit(match_id,action,source,details)
    values(h->>'id','import','legacy',h);
  end loop;
  update transfer_maintenance.matches m set status='legacy_conflict'
  where exists (select 1 from transfer_maintenance.members mm where mm.match_id=m.match_id
    and mm.item_id in (select item_id from transfer_maintenance.members group by item_id having count(*)>1));
  update transfer_maintenance.members mm set active=true
  from transfer_maintenance.matches m where m.match_id=mm.match_id and m.status='active';
end $$;

create function public.transfer_get_unmatched(p_start_date date default null,p_end_date date default null,
  p_worker text default null,p_counterparty text default null,p_lane text default 'primary')
returns table(item_id text,date date,created_at timestamptz,worker text,counterparty text,direction text,
  amount numeric,absolute_amount numeric,description text,matched boolean,match_id text,archived boolean,lane text)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  perform transfer_maintenance.require_admin();
  if p_start_date > p_end_date then raise exception 'invalid_date_range'; end if;
  if p_lane is null or p_lane not in ('primary','A','B','other','all') then raise exception 'invalid_lane'; end if;
  return query select i.item_id,i.date,i.created_at,i.worker,i.counterparty,
    case when i.amount<0 then 'outgoing' else 'incoming' end,i.amount,abs(i.amount),i.description,false,null::text,i.archived,
    transfer_maintenance.lane(i.worker,i.counterparty)
  from transfer_maintenance.items i where i.available
    and (p_start_date is null or i.date>=p_start_date) and (p_end_date is null or i.date<=p_end_date)
    and (p_worker is null or i.worker=p_worker) and (p_counterparty is null or i.counterparty=p_counterparty)
    and (p_lane='all' or (p_lane='primary' and transfer_maintenance.lane(i.worker,i.counterparty) in ('A','B'))
      or transfer_maintenance.lane(i.worker,i.counterparty)=p_lane)
    and not exists(select 1 from transfer_maintenance.members mm join transfer_maintenance.matches m using(match_id)
      where mm.item_id=i.item_id and m.status<>'cancelled')
  order by transfer_maintenance.lane(i.worker,i.counterparty),i.date,i.worker,i.counterparty,i.item_id;
end $$;

create function public.transfer_get_unmatched_by_lane(p_start_date date default null,p_end_date date default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare result jsonb; begin
  perform transfer_maintenance.require_admin();
  with u as (select * from public.transfer_get_unmatched(p_start_date,p_end_date,null,null,'all'))
  select jsonb_build_object('A',coalesce((select jsonb_agg(to_jsonb(x)) from u x where lane='A'),'[]'),
    'B',coalesce((select jsonb_agg(to_jsonb(x)) from u x where lane='B'),'[]'),
    'other',coalesce((select jsonb_agg(to_jsonb(x)) from u x where lane='other'),'[]')) into result;
  return result;
end $$;

create function public.transfer_maintenance_summary(p_start_date date default null,p_end_date date default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare result jsonb; begin
  perform transfer_maintenance.require_admin();
  with u as (select * from public.transfer_get_unmatched(p_start_date,p_end_date,null,null,'all')),
  pairs as (select case when amount<0 then worker else counterparty end as from_worker,
    case when amount<0 then counterparty else worker end as to_worker,
    count(*) as unmatched_total,count(*) filter(where amount<0) as outgoing,count(*) filter(where amount>0) as incoming
    from u group by 1,2)
  select jsonb_build_object('unmatched_total',(select count(*) from u),'outgoing',(select count(*) from u where amount<0),
    'incoming',(select count(*) from u where amount>0),'oldest_unmatched_date',(select min(date) from u),
    'older_than_7_days',(select count(*) from u where date < (now() at time zone 'Asia/Kuala_Lumpur')::date-7),
    'worker_pairs',coalesce((select jsonb_agg(to_jsonb(p) order by from_worker,to_worker) from pairs p),'[]'),
    'lanes',jsonb_build_object('A',(select count(*) from u where lane='A'),'B',(select count(*) from u where lane='B'),
      'other',(select count(*) from u where lane='other')),
    'legacy_conflict_matches',(select count(*) from transfer_maintenance.matches where status='legacy_conflict')) into result;
  return result;
end $$;

create function public.transfer_preview_match(p_outgoing_ids text[],p_incoming_ids text[],p_max_date_span integer default 7)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare ids text[]; n int; pair_count int; total_out numeric; total_in numeric; min_day date; max_day date; from_w text; to_w text;
begin
  perform transfer_maintenance.require_admin();
  if coalesce(cardinality(p_outgoing_ids),0)=0 or coalesce(cardinality(p_incoming_ids),0)=0 then
    return jsonb_build_object('valid',false,'reason','empty_selection'); end if;
  ids:=p_outgoing_ids||p_incoming_ids;
  if array_position(ids,null) is not null or exists(select 1 from unnest(ids) x where btrim(x)='') then
    return jsonb_build_object('valid',false,'reason','invalid_item_id'); end if;
  if (select count(distinct x) from unnest(ids) x) <> cardinality(ids) then
    return jsonb_build_object('valid',false,'reason','duplicate_id'); end if;
  if exists(select 1 from transfer_maintenance.members mm join transfer_maintenance.matches m using(match_id)
    where mm.item_id=any(ids) and m.status<>'cancelled') then
    return jsonb_build_object('valid',false,'reason','item_already_matched'); end if;
  select count(*),min(date),max(date) into n,min_day,max_day from transfer_maintenance.items where item_id=any(ids) and available;
  if n<>cardinality(ids) then return jsonb_build_object('valid',false,'reason','item_not_found'); end if;
  if exists(select 1 from transfer_maintenance.items where
    (item_id=any(p_outgoing_ids) and amount>=0) or (item_id=any(p_incoming_ids) and amount<=0)) then
    return jsonb_build_object('valid',false,'reason','wrong_direction'); end if;
  select count(distinct (case when amount<0 then worker else counterparty end,
    case when amount<0 then counterparty else worker end)),
    min(case when amount<0 then worker else counterparty end),min(case when amount<0 then counterparty else worker end)
    into pair_count,from_w,to_w from transfer_maintenance.items where item_id=any(ids);
  if pair_count<>1 then return jsonb_build_object('valid',false,'reason','worker_pair_mismatch'); end if;
  if p_max_date_span is null or p_max_date_span<0 or p_max_date_span>365 then
    return jsonb_build_object('valid',false,'reason','invalid_max_date_span'); end if;
  if max_day-min_day>p_max_date_span or max_day>(now() at time zone 'Asia/Kuala_Lumpur')::date then
    return jsonb_build_object('valid',false,'reason','date_range_exceeded'); end if;
  select sum(abs(amount)) filter(where amount<0),sum(amount) filter(where amount>0)
    into total_out,total_in from transfer_maintenance.items where item_id=any(ids);
  return jsonb_build_object('valid',true,'total_out',total_out,'total_in',total_in,'difference',total_in-total_out,
    'outgoing_count',cardinality(p_outgoing_ids),'incoming_count',cardinality(p_incoming_ids),
    'from_worker',from_w,'to_worker',to_w,'start_date',min_day,'end_date',max_day,'date_span',max_day-min_day);
end $$;

-- This routine is the sole final pairing implementation used by new and legacy entry points.
create function transfer_maintenance.apply_match(p_outgoing_ids text[],p_incoming_ids text[],p_note text,
  p_source text,p_max_date_span integer,p_match_id text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare result jsonb; rec jsonb; outs jsonb; ins jsonb; match_key text; d jsonb;
begin
  perform transfer_maintenance.require_admin();
  if p_source not in ('manual_ui','maintenance','auto') or p_source is null then raise exception 'invalid_source'; end if;
  -- Serialize the JSON history, then lock source rows and projected items in deterministic order.
  insert into public.gold_ledger(worker,data) values('__TRANSFERS__','{"history":[],"threshold":0.05}') on conflict do nothing;
  select data into d from public.gold_ledger where worker='__TRANSFERS__' for update;
  perform 1 from public.gold_ledger g where g.worker in
    (select i.worker from transfer_maintenance.items i where i.item_id=any(p_outgoing_ids||p_incoming_ids)) order by g.worker for update;
  perform 1 from transfer_maintenance.items where item_id=any(p_outgoing_ids||p_incoming_ids) order by item_id for update;
  result:=public.transfer_preview_match(p_outgoing_ids,p_incoming_ids,p_max_date_span);
  if not (result->>'valid')::boolean then raise exception '%',result->>'reason' using errcode='22023'; end if;
  match_key:=coalesce(p_match_id,gen_random_uuid()::text);
  if exists(select 1 from transfer_maintenance.matches where match_id=match_key) then raise exception 'match_id_exists'; end if;
  select jsonb_agg(jsonb_build_object('worker',i.worker,'date',i.date,'desc',i.description,'amount',i.amount,'itemId',i.item_id)
    order by s.ord) into outs from unnest(p_outgoing_ids) with ordinality s(id,ord) join transfer_maintenance.items i on i.item_id=s.id;
  select jsonb_agg(jsonb_build_object('worker',i.worker,'date',i.date,'desc',i.description,'amount',i.amount,'itemId',i.item_id)
    order by s.ord) into ins from unnest(p_incoming_ids) with ordinality s(id,ord) join transfer_maintenance.items i on i.item_id=s.id;
  rec:=jsonb_build_object('id',match_key,'kind','match','outgoing',outs,'incoming',ins,
    'totalOut',result->'total_out','totalIn',result->'total_in','diff',result->'difference',
    'matchedAt',(now() at time zone 'Asia/Kuala_Lumpur')::date,'createdAt',clock_timestamp(),
    'createdBy',auth.uid(),'source',p_source,'note',p_note);
  insert into transfer_maintenance.matches(match_id,status,created_at,created_by,source,note,total_out,total_in,difference,original_record)
  values(match_key,'active',(rec->>'createdAt')::timestamptz,auth.uid(),p_source,p_note,
    (result->>'total_out')::numeric,(result->>'total_in')::numeric,(result->>'difference')::numeric,rec);
  insert into transfer_maintenance.members(match_id,item_id,direction,active,snapshot)
    select match_key,s.item->>'itemId',s.direction,true,s.item from transfer_maintenance.match_sides(rec) s;
  insert into transfer_maintenance.audit(match_id,action,created_by,source,note,details)
    values(match_key,'apply',auth.uid(),p_source,p_note,rec);
  update public.gold_ledger set data=jsonb_set(d,'{history}',coalesce(d->'history','[]')||jsonb_build_array(rec)),updated_at=now()
    where worker='__TRANSFERS__';
  return result||jsonb_build_object('match_id',match_key,'created_by',auth.uid(),'source',p_source);
end $$;

create function public.transfer_apply_match(p_outgoing_ids text[],p_incoming_ids text[],p_note text default null,
  p_source text default 'maintenance',p_max_date_span integer default 7)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  return transfer_maintenance.apply_match(p_outgoing_ids,p_incoming_ids,p_note,p_source,p_max_date_span);
end $$;

create function public.transfer_undo_match(p_match_id text,p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare m transfer_maintenance.matches; d jsonb; ids jsonb;
begin
  perform transfer_maintenance.require_admin();
  if nullif(btrim(p_reason),'') is null then raise exception 'reason_required'; end if;
  select data into d from public.gold_ledger where worker='__TRANSFERS__' for update;
  select * into m from transfer_maintenance.matches where match_id=p_match_id for update;
  if not found then raise exception 'match_not_found'; end if;
  if m.status='cancelled' then return jsonb_build_object('match_id',p_match_id,'status','cancelled','already_cancelled',true); end if;
  select jsonb_agg(item_id order by item_id) into ids from transfer_maintenance.members where match_id=p_match_id;
  update transfer_maintenance.members set active=false where match_id=p_match_id;
  update transfer_maintenance.matches set status='cancelled',cancelled_at=clock_timestamp(),cancelled_by=auth.uid(),cancel_reason=p_reason
    where match_id=p_match_id;
  insert into transfer_maintenance.audit(match_id,action,created_by,source,note,details)
    values(p_match_id,'undo',auth.uid(),m.source,p_reason,jsonb_build_object('record',m.original_record,'item_ids',ids));
  -- Retain cancelled record in normalized storage, remove UI link for old clients.
  update public.gold_ledger set data=jsonb_set(d,'{history}',coalesce((select jsonb_agg(h order by ord)
    from jsonb_array_elements(coalesce(d->'history','[]')) with ordinality s(h,ord) where h->>'id'<>p_match_id),'[]')),updated_at=now()
    where worker='__TRANSFERS__';
  return jsonb_build_object('match_id',p_match_id,'status','cancelled','item_ids',ids,
    'still_reserved_item_ids',coalesce((select jsonb_agg(distinct mm.item_id) from transfer_maintenance.members mm
      join transfer_maintenance.matches x using(match_id) where mm.item_id in
      (select item_id from transfer_maintenance.members where match_id=p_match_id) and x.status<>'cancelled'),'[]'));
end $$;

create function public.transfer_find_candidates(p_start_date date default null,p_end_date date default null,
  p_worker text default null,p_counterparty text default null,p_max_difference numeric default 0.05,
  p_max_date_span integer default 2,p_limit integer default 200,p_lane text default 'primary',
  p_max_group_items integer default 3,p_pool_limit integer default 20)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare result jsonb;
begin
  perform transfer_maintenance.require_admin();
  if p_max_difference is null or p_max_difference<0 or p_max_difference in ('NaN'::numeric,'Infinity'::numeric)
    or p_max_date_span is null or p_max_date_span not between 0 and 2
    or p_limit is null or p_limit not between 1 and 1000 or p_max_group_items is null or p_max_group_items not between 1 and 3
    or p_pool_limit is null or p_pool_limit not between 1 and 30 then raise exception 'invalid_candidate_parameters'; end if;
  with recursive raw as (
    select u.*,case when u.amount<0 then u.worker else u.counterparty end as from_w,
      case when u.amount<0 then u.counterparty else u.worker end as to_w
    from public.transfer_get_unmatched(p_start_date,p_end_date,null,null,p_lane) u
  ), ranked as (
    select r.*,row_number() over(partition by r.from_w,r.to_w,r.direction order by r.date desc,r.item_id) as rn,
      count(*) over(partition by r.from_w,r.to_w,r.direction) as pool_size
    from raw r where (p_worker is null or r.from_w=p_worker) and (p_counterparty is null or r.to_w=p_counterparty)
  ), pool as (select * from ranked where rn<=p_pool_limit),
  combos as (
    select r.lane,r.from_w,r.to_w,r.direction,array[r.item_id] as ids,jsonb_build_array(to_jsonb(r)-'rn'-'pool_size'-'from_w'-'to_w') as items,
      r.absolute_amount as weight,r.date as min_day,r.date as max_day,r.rn as last_rn,1 as n,r.pool_size>p_pool_limit as truncated
    from pool r
    union all
    select c.lane,c.from_w,c.to_w,c.direction,c.ids||r.item_id,c.items||jsonb_build_array(to_jsonb(r)-'rn'-'pool_size'-'from_w'-'to_w'),
      c.weight+r.absolute_amount,least(c.min_day,r.date),greatest(c.max_day,r.date),r.rn,c.n+1,c.truncated
    from combos c join pool r on r.from_w=c.from_w and r.to_w=c.to_w and r.direction=c.direction and r.rn>c.last_rn
    where c.n<p_max_group_items and greatest(c.max_day,r.date)-least(c.min_day,r.date)<=p_max_date_span
  ), singles as materialized (select * from combos where n=1),
  multiples as materialized (select * from combos where n>1), links as (
    select to_jsonb(o) as o,to_jsonb(i) as i from singles o join singles i
      on i.from_w=o.from_w and i.to_w=o.to_w and i.direction='incoming'
      and abs(i.weight-o.weight)<=p_max_difference
      and greatest(o.max_day,i.max_day)-least(o.min_day,i.min_day)<=p_max_date_span
      where o.direction='outgoing'
    union all
    select to_jsonb(o),to_jsonb(i) from singles o join multiples i
      on i.from_w=o.from_w and i.to_w=o.to_w and i.direction='incoming'
      and abs(i.weight-o.weight)<=p_max_difference
      and greatest(o.max_day,i.max_day)-least(o.min_day,i.min_day)<=p_max_date_span
      where o.direction='outgoing'
    union all
    select to_jsonb(o),to_jsonb(i) from multiples o join singles i
      on i.from_w=o.from_w and i.to_w=o.to_w and i.direction='incoming' and i.n=1
      and abs(i.weight-o.weight)<=p_max_difference
      and greatest(o.max_day,i.max_day)-least(o.min_day,i.min_day)<=p_max_date_span
      where o.direction='outgoing' and o.n>1
  ), suggestions as (
    select l.o->>'lane' as lane,array(select jsonb_array_elements_text(l.o->'ids')) as out_ids,
      array(select jsonb_array_elements_text(l.i->'ids')) as in_ids,l.o->'items' as out_items,l.i->'items' as in_items,
      (l.o->>'weight')::numeric as out_weight,(l.i->>'weight')::numeric as in_weight,
      (l.i->>'weight')::numeric-(l.o->>'weight')::numeric as diff,
      greatest((l.o->>'max_day')::date,(l.i->>'max_day')::date)-least((l.o->>'min_day')::date,(l.i->>'min_day')::date) as span,
      (l.o->>'n')::int+(l.i->>'n')::int as size,(l.o->>'truncated')::boolean or (l.i->>'truncated')::boolean as truncated,
      exists(select 1 from jsonb_array_elements(l.o->'items') a cross join jsonb_array_elements(l.i->'items') b
        where (a->>'description' like '%上楼%' and b->>'description' like '%上楼%')
          or (a->>'description' like '%下楼%' and b->>'description' like '%下楼%')) as desc_support
    from links l
  ), claims as (
    select unnest(s.out_ids||s.in_ids) as item_id,count(*) as uses from suggestions s group by 1
  ), evaluated as (
    select s.*,exists(select 1 from claims c where c.item_id=any(s.out_ids||s.in_ids) and c.uses>1) as ambiguous from suggestions s
  ), final as (
  select md5(e.lane||array_to_string(e.out_ids,',')||'|'||array_to_string(e.in_ids,',')) as candidate_id,e.lane,
    e.out_ids as outgoing_ids,e.in_ids as incoming_ids,e.out_items as outgoing_items,e.in_items as incoming_items,
    e.out_weight as total_out,e.in_weight as total_in,e.diff as difference,e.span as date_span,
    case when e.ambiguous or e.truncated then 'AMBIGUOUS'
      when e.lane='B' and e.span=0 and e.size=2 then 'HIGH' else 'MEDIUM' end as confidence,
    case when e.ambiguous then 'multiple_possible_combinations' when e.truncated then 'search_pool_truncated'
      when e.size>2 then 'combined_weight_match' when e.diff=0 and e.span=0 then 'exact_weight_same_day'
      when e.diff=0 and e.span=1 then 'exact_weight_next_day' when e.desc_support then 'description_supports_match'
      else 'weight_within_threshold' end as reason,e.desc_support as description_support,e.truncated as search_truncated
  from evaluated e order by e.lane,e.ambiguous,e.truncated,e.span,abs(e.diff),e.desc_support desc,e.size,e.out_ids,e.in_ids limit p_limit
  )
  select jsonb_build_object('candidates',coalesce((select jsonb_agg(to_jsonb(f)) from final f),'[]'),
    'search',jsonb_build_object('pool_limit_per_direction',p_pool_limit,'max_group_items',p_max_group_items,'max_date_span',p_max_date_span,
      'eligible_items',(select count(*) from ranked),'searched_items',(select count(*) from pool),
      'pool_truncated',exists(select 1 from ranked where pool_size>p_pool_limit),
      'result_truncated',(select count(*) from evaluated)>p_limit,'total_candidates',(select count(*) from evaluated))) into result;
  return result;
end $$;

create function public.transfer_apply_matches_batch(p_groups jsonb,p_note text default null,p_max_date_span integer default 7)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare group_data jsonb; result jsonb; results jsonb:='[]'; idx int:=0; out_ids text[]; in_ids text[]; reason text; code text;
begin
  perform transfer_maintenance.require_admin();
  if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups) not between 1 and 100 then
    raise exception 'batch_requires_1_to_100_groups'; end if;
  for group_data in select x from jsonb_array_elements(p_groups) x loop
    idx:=idx+1;
    begin
      if jsonb_typeof(group_data->'outgoing_ids') is distinct from 'array' or jsonb_typeof(group_data->'incoming_ids') is distinct from 'array'
        then raise exception 'invalid_group_format'; end if;
      select array_agg(x) into out_ids from jsonb_array_elements_text(group_data->'outgoing_ids') x;
      select array_agg(x) into in_ids from jsonb_array_elements_text(group_data->'incoming_ids') x;
      result:=public.transfer_apply_match(out_ids,in_ids,coalesce(group_data->>'note',p_note),'maintenance',p_max_date_span);
      results:=results||jsonb_build_array(jsonb_build_object('group_index',idx,'success',true,'result',result));
    exception when others then
      get stacked diagnostics reason=message_text,code=returned_sqlstate;
      results:=results||jsonb_build_array(jsonb_build_object('group_index',idx,'success',false,'reason',reason,'sqlstate',code));
    end;
  end loop;
  return jsonb_build_object('results',results,'succeeded',(select count(*) from jsonb_array_elements(results) r where (r->>'success')::boolean),
    'failed',(select count(*) from jsonb_array_elements(results) r where not (r->>'success')::boolean));
end $$;

create function public.transfer_get_match(p_match_id text default null,p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  perform transfer_maintenance.require_admin();
  return coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('audit',
    (select jsonb_agg(to_jsonb(a) order by audit_id) from transfer_maintenance.audit a where a.match_id=m.match_id)) order by m.match_id)
    from transfer_maintenance.matches m where (p_match_id is null or m.match_id=p_match_id) and
      (p_status is null or m.status=p_status)),'[]');
end $$;

-- Protect the JSON compatibility surface too: generic admin writes cannot bypass matching.
create function transfer_maintenance.guard_and_sync_ledger() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare old_hist jsonb; new_hist jsonb; h jsonb;
begin
  if tg_op='DELETE' then
    if old.worker='__TRANSFERS__' or exists(select 1 from transfer_maintenance.items where worker=old.worker) then
      raise exception 'ledger_row_delete_not_supported'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and new.worker<>old.worker then raise exception 'worker_key_is_immutable'; end if;
  if new.worker='__TRANSFERS__' then
    old_hist:=case when tg_op='UPDATE' then coalesce(old.data->'history','[]') else '[]' end;
    new_hist:=coalesce(new.data->'history','[]');
    for h in select x from jsonb_array_elements(new_hist) x where x->>'kind'='match' loop
      if not exists(select 1 from transfer_maintenance.matches m where m.match_id=h->>'id' and m.status<>'cancelled'
          and m.original_record=h) then raise exception 'use_transfer_apply_match'; end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(old_hist) old_entry join transfer_maintenance.matches m on m.match_id=old_entry->>'id'
      where old_entry->>'kind'='match' and m.status<>'cancelled' and not exists(select 1 from jsonb_array_elements(new_hist) n where n=old_entry)) then
      raise exception 'use_transfer_undo_match'; end if;
  else
    perform transfer_maintenance.sync_worker(new.worker,new.data);
  end if;
  return new;
end $$;
create trigger transfer_maintenance_ledger_guard after insert or update or delete on public.gold_ledger
for each row execute function transfer_maintenance.guard_and_sync_ledger();

-- Route unchanged older UI clients through exactly the same final routine.
create or replace function public.append_special_record(p_key text,p_record jsonb,p_counter_field text default null,p_counter_increment integer default 0)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare d jsonb; cur_counter int; out_ids text[]; in_ids text[];
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_key='__TRANSFERS__' then
    if p_record->>'kind' is distinct from 'match' or p_counter_field is not null then raise exception 'invalid_transfer_record'; end if;
    select array_agg(item->>'itemId') filter(where direction='outgoing'),array_agg(item->>'itemId') filter(where direction='incoming')
      into out_ids,in_ids from transfer_maintenance.match_sides(p_record);
    perform transfer_maintenance.apply_match(out_ids,in_ids,p_record->>'note','manual_ui',7,p_record->>'id');
    return null;
  end if;
  select data into d from public.gold_ledger where worker=p_key for update;
  d:=coalesce(d,jsonb_build_object('history','[]'::jsonb));
  d:=jsonb_set(d,'{history}',coalesce(d->'history','[]')||jsonb_build_array(p_record));
  if p_counter_field is not null then
    cur_counter:=coalesce((d->>p_counter_field)::int,0)+p_counter_increment;
    d:=jsonb_set(d,array[p_counter_field],to_jsonb(cur_counter));
  end if;
  insert into public.gold_ledger(worker,data,updated_at) values(p_key,d,now())
    on conflict(worker) do update set data=excluded.data,updated_at=now();
  return cur_counter;
end $$;
create or replace function public.delete_match_record(p_key text,p_record_id text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_key<>'__TRANSFERS__' then raise exception 'invalid_transfer_key'; end if;
  perform public.transfer_undo_match(p_record_id,'Cancelled from manual UI');
end $$;

revoke all on all functions in schema transfer_maintenance from public,anon,authenticated;
revoke all on function public.transfer_get_unmatched(date,date,text,text,text),public.transfer_get_unmatched_by_lane(date,date),public.transfer_maintenance_summary(date,date),
  public.transfer_preview_match(text[],text[],integer),public.transfer_apply_match(text[],text[],text,text,integer),
  public.transfer_undo_match(text,text),public.transfer_find_candidates(date,date,text,text,numeric,integer,integer,text,integer,integer),
  public.transfer_get_match(text,text),public.transfer_apply_matches_batch(jsonb,text,integer) from public,anon;
grant execute on function public.transfer_get_unmatched(date,date,text,text,text),public.transfer_get_unmatched_by_lane(date,date),public.transfer_maintenance_summary(date,date),
  public.transfer_preview_match(text[],text[],integer),public.transfer_apply_match(text[],text[],text,text,integer),
  public.transfer_undo_match(text,text),public.transfer_find_candidates(date,date,text,text,numeric,integer,integer,text,integer,integer),
  public.transfer_get_match(text,text),public.transfer_apply_matches_batch(jsonb,text,integer) to authenticated;
-- Legacy functions still require admin inside their transfer branch.
revoke all on function public.append_special_record(text,jsonb,text,integer),public.delete_match_record(text,text) from public,anon;
grant execute on function public.append_special_record(text,jsonb,text,integer),public.delete_match_record(text,text) to authenticated;
notify pgrst,'reload schema';
commit;
