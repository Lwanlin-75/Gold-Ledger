-- Roll back 20261007_transfer_lanes.sql: restores the original A/B-only lanes and same-day-only HIGH rule.
-- Business records, Matches, Issues and audit data are untouched (lane names already stored on Issues stay as text).
begin;
set local lock_timeout='10s';
do $$ begin
  if to_regprocedure('transfer_maintenance.candidates_base(date,date,text,text,numeric,integer,integer,text,integer,integer)') is null
     or to_regprocedure('transfer_maintenance.lane(text,text)') is null then
    raise exception 'run_20261005_transfer_maintenance_and_issues_first';
  end if;
end $$;

create or replace function transfer_maintenance.lane(p_worker text,p_counterparty text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when (p_worker='JJ' and p_counterparty='PD Lv2') or (p_worker='PD Lv2' and p_counterparty='JJ') then 'A'
    when (p_worker='PD Lv2' and p_counterparty='PD Lv1') or (p_worker='PD Lv1' and p_counterparty='PD Lv2') then 'B'
    else 'other' end
$$;

create or replace function public.transfer_get_unmatched(p_start_date date default null,p_end_date date default null,
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

create or replace function public.transfer_get_unmatched_by_lane(p_start_date date default null,p_end_date date default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare result jsonb; begin
  perform transfer_maintenance.require_admin();
  with u as (select * from public.transfer_get_unmatched(p_start_date,p_end_date,null,null,'all'))
  select jsonb_build_object('A',coalesce((select jsonb_agg(to_jsonb(x)) from u x where lane='A'),'[]'),
    'B',coalesce((select jsonb_agg(to_jsonb(x)) from u x where lane='B'),'[]'),
    'other',coalesce((select jsonb_agg(to_jsonb(x)) from u x where lane='other'),'[]')) into result;
  return result;
end $$;

create or replace function public.transfer_maintenance_summary(p_start_date date default null,p_end_date date default null)
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

create or replace function transfer_maintenance.candidates_base(p_start_date date default null,p_end_date date default null,
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

notify pgrst,'reload schema';
commit;
