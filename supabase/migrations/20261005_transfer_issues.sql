-- Run after 20261005_transfer_maintenance.sql. No automatic matching or issue resolution.
begin;
set local lock_timeout='10s';
lock table public.gold_ledger in share row exclusive mode;
create table transfer_maintenance.settings (
  singleton boolean primary key default true check(singleton),
  transfer_receive_wait_hours numeric not null default 48 check(transfer_receive_wait_hours between 1 and 720),
  investigation_difference numeric not null default 2 check(investigation_difference between 0.21 and 20)
);
insert into transfer_maintenance.settings(singleton) values(true);
create table transfer_maintenance.configuration_events (
  event_id bigint generated always as identity primary key,created_at timestamptz not null default clock_timestamp(),
  actor uuid not null,event_type text not null,metadata jsonb not null
);
alter table transfer_maintenance.configuration_events enable row level security;
-- Never infer identity from a selectable frontend Worker or from the email's spelling.
create table transfer_maintenance.employee_workers (
  employee_id uuid not null references public.profiles(id) on delete cascade, worker text not null,
  assigned_at timestamptz not null default clock_timestamp(),assigned_by uuid not null,
  primary key(employee_id,worker),
  check(worker in ('JJ','PD Lv2','PD Lv1','倒模','Lv1车花','Lv1倒模','Lv1倒模车花'))
);
create table transfer_maintenance.transfer_issues (
  id uuid primary key default gen_random_uuid(),
  issue_type text not null check(issue_type in ('WEIGHT_MISMATCH','SENT_NOT_RECEIVED','POSSIBLE_WRONG_WEIGHT',
    'POSSIBLE_WRONG_DIRECTION','POSSIBLE_MISSING_ENTRY','POSSIBLE_DUPLICATE_ENTRY','OTHER')),
  lane text not null, status text not null default 'WAITING_STAFF'
    check(status in ('OPEN','WAITING_STAFF','STAFF_REPLIED','READY_FOR_REVIEW','RESOLVED')),
  severity text not null default 'RED' check(severity in ('RED','YELLOW')),
  outgoing_item_ids text[] not null,incoming_item_ids text[] not null,
  total_out numeric not null,total_in numeric not null,difference numeric not null,
  reason text not null,created_at timestamptz not null default clock_timestamp(),created_by uuid not null,
  assigned_workers text[] not null,initial_items jsonb not null,
  possible_resolution_found boolean not null default false,
  resolved_at timestamptz,resolved_by uuid,resolution_type text,resolution_note text,match_id text,
  check(cardinality(assigned_workers)>0)
);
create index issues_open_lane on transfer_maintenance.transfer_issues(lane,created_at) where status<>'RESOLVED';
create index issues_out_ids on transfer_maintenance.transfer_issues using gin(outgoing_item_ids);
create index issues_in_ids on transfer_maintenance.transfer_issues using gin(incoming_item_ids);
create table transfer_maintenance.transfer_issue_events (
  event_id bigint generated always as identity primary key,issue_id uuid not null references transfer_maintenance.transfer_issues(id),
  event_type text not null check(event_type in ('issue_created','staff_comment','item_updated','staff_marked_checked',
    'admin_review','match_created','issue_resolved','issue_reopened','possible_resolution_found')),
  actor uuid,actor_role text not null,timestamp timestamptz not null default clock_timestamp(),message text,metadata jsonb not null default '{}'
);
create index issue_events_history on transfer_maintenance.transfer_issue_events(issue_id,event_id);
alter table transfer_maintenance.settings enable row level security;
alter table transfer_maintenance.employee_workers enable row level security;
alter table transfer_maintenance.transfer_issues enable row level security;
alter table transfer_maintenance.transfer_issue_events enable row level security;
revoke all on all tables in schema transfer_maintenance from public,anon,authenticated;
revoke all on all sequences in schema transfer_maintenance from public,anon,authenticated;

create function transfer_maintenance.issue_access(p_id uuid) returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not exists(select 1 from transfer_maintenance.transfer_issues i where i.id=p_id and
    (public.is_admin() or exists(select 1 from transfer_maintenance.employee_workers w where w.employee_id=auth.uid() and w.worker=any(i.assigned_workers))))
    then raise exception 'issue_access_denied' using errcode='42501'; end if;
end $$;
create function transfer_maintenance.issue_detail(p_id uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select to_jsonb(i)||jsonb_build_object('is_red',i.status<>'RESOLVED' and i.severity='RED',
    'current_items',coalesce((select jsonb_agg(to_jsonb(t) order by t.item_id) from transfer_maintenance.items t
      where t.item_id=any(i.outgoing_item_ids||i.incoming_item_ids)),'[]'),
    'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.event_id) from transfer_maintenance.transfer_issue_events e where e.issue_id=i.id),'[]'))
  from transfer_maintenance.transfer_issues i where i.id=p_id
$$;
create function public.transfer_get_issue(p_issue_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin perform transfer_maintenance.issue_access(p_issue_id);return transfer_maintenance.issue_detail(p_issue_id);end $$;
create function public.transfer_get_open_issues(p_start_date date default null,p_end_date date default null,
  p_lane text default null,p_issue_type text default null,p_status text default null,p_worker text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode='42501';end if;
  if p_start_date>p_end_date then raise exception 'invalid_date_range';end if;
  return coalesce((select jsonb_agg(transfer_maintenance.issue_detail(i.id) order by i.created_at,i.id)
    from transfer_maintenance.transfer_issues i where i.status<>'RESOLVED'
    and (p_start_date is null or (i.created_at at time zone 'Asia/Kuala_Lumpur')::date>=p_start_date)
    and (p_end_date is null or (i.created_at at time zone 'Asia/Kuala_Lumpur')::date<=p_end_date)
    and (p_lane is null or i.lane=p_lane) and (p_issue_type is null or i.issue_type=p_issue_type)
    and (p_status is null or i.status=p_status) and (p_worker is null or p_worker=any(i.assigned_workers))
    and (public.is_admin() or exists(select 1 from transfer_maintenance.employee_workers w
      where w.employee_id=auth.uid() and w.worker=any(i.assigned_workers)))),'[]');
end $$;

create function public.transfer_set_employee_workers(p_employee_id uuid,p_workers text[]) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous text[];begin
  perform transfer_maintenance.require_admin();
  if p_workers is null or array_position(p_workers,null) is not null then raise exception 'invalid_workers';end if;
  select array_agg(worker order by worker) into previous from transfer_maintenance.employee_workers where employee_id=p_employee_id;
  delete from transfer_maintenance.employee_workers where employee_id=p_employee_id;
  insert into transfer_maintenance.employee_workers(employee_id,worker,assigned_by)
    select p_employee_id,w,auth.uid() from (select distinct unnest(p_workers) w) x;
  insert into transfer_maintenance.configuration_events(actor,event_type,metadata)
    values(auth.uid(),'employee_workers_changed',jsonb_build_object('employee_id',p_employee_id,'before',previous,'after',p_workers));
  return jsonb_build_object('employee_id',p_employee_id,'previous_workers',coalesce(previous,'{}'),'workers',p_workers);
end $$;
create function public.transfer_get_issue_settings() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin perform transfer_maintenance.require_admin();return (select to_jsonb(s) from transfer_maintenance.settings s);end $$;
create function public.transfer_set_issue_settings(p_transfer_receive_wait_hours numeric,p_investigation_difference numeric default 2)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous jsonb;begin perform transfer_maintenance.require_admin();
  select to_jsonb(s) into previous from transfer_maintenance.settings s for update;
  update transfer_maintenance.settings set transfer_receive_wait_hours=p_transfer_receive_wait_hours,investigation_difference=p_investigation_difference;
  insert into transfer_maintenance.configuration_events(actor,event_type,metadata)
    values(auth.uid(),'issue_settings_changed',jsonb_build_object('before',previous,'after',public.transfer_get_issue_settings()));
  return public.transfer_get_issue_settings();
end $$;

create function public.transfer_create_issue(p_issue_type text,p_outgoing_ids text[],p_incoming_ids text[],p_reason text,p_severity text default 'RED')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare ids text[];assigned text[];i uuid;outs numeric;ins numeric;issue_lane text;items jsonb;begin
  perform transfer_maintenance.require_admin();
  ids:=coalesce(p_outgoing_ids,'{}')||coalesce(p_incoming_ids,'{}');
  if cardinality(ids)=0 or cardinality(ids)>100 or array_position(ids,null) is not null
    or (select count(distinct x) from unnest(ids) x)<>cardinality(ids) then raise exception 'invalid_issue_items';end if;
  if nullif(btrim(p_reason),'') is null then raise exception 'reason_required';end if;
  -- Same lock order as Apply. Issues can also investigate existing historical matches.
  insert into public.gold_ledger(worker,data) values('__TRANSFERS__','{"history":[],"threshold":0.05}') on conflict do nothing;
  perform 1 from public.gold_ledger where worker='__TRANSFERS__' for update;
  perform 1 from transfer_maintenance.items where item_id=any(ids) order by item_id for update;
  if (select count(*) from transfer_maintenance.items where item_id=any(ids))<>cardinality(ids) then raise exception 'item_not_found';end if;
  if (select count(distinct least(worker,counterparty)||'|'||greatest(worker,counterparty)) from transfer_maintenance.items where item_id=any(ids))<>1
    then raise exception 'worker_pair_mismatch';end if;
  if exists(select 1 from transfer_maintenance.transfer_issues where status<>'RESOLVED' and
    (outgoing_item_ids||incoming_item_ids)&&ids) then raise exception 'item_has_open_issue';end if;
  select array_agg(distinct w order by w) into assigned from transfer_maintenance.items t cross join lateral unnest(array[t.worker,t.counterparty]) w where t.item_id=any(ids);
  select coalesce(sum(abs(amount)) filter(where item_id=any(coalesce(p_outgoing_ids,'{}'))),0),
    coalesce(sum(abs(amount)) filter(where item_id=any(coalesce(p_incoming_ids,'{}'))),0),min(transfer_maintenance.lane(worker,counterparty)),
    jsonb_agg(to_jsonb(t) order by item_id) into outs,ins,issue_lane,items from transfer_maintenance.items t where item_id=any(ids);
  if p_issue_type='WEIGHT_MISMATCH' and (coalesce(cardinality(p_outgoing_ids),0)=0 or coalesce(cardinality(p_incoming_ids),0)=0 or abs(ins-outs)<=0.20)
    then raise exception 'weight_issue_requires_both_sides_and_difference_over_0_20';end if;
  if p_issue_type='SENT_NOT_RECEIVED' and (coalesce(cardinality(p_outgoing_ids),0)=0 or coalesce(cardinality(p_incoming_ids),0)<>0
    or exists(select 1 from transfer_maintenance.items where item_id=any(p_outgoing_ids) and amount>=0))
    then raise exception 'sent_issue_requires_outgoing_only';end if;
  insert into transfer_maintenance.transfer_issues(issue_type,lane,severity,outgoing_item_ids,incoming_item_ids,total_out,total_in,difference,
    reason,created_by,assigned_workers,initial_items)
  values(p_issue_type,issue_lane,p_severity,coalesce(p_outgoing_ids,'{}'),coalesce(p_incoming_ids,'{}'),outs,ins,ins-outs,p_reason,auth.uid(),assigned,items) returning id into i;
  insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,message,metadata)
    values(i,'issue_created',auth.uid(),'admin',p_reason,jsonb_build_object('initial_items',items,'total_out',outs,'total_in',ins,'difference',ins-outs,'assigned_workers',assigned));
  return transfer_maintenance.issue_detail(i);
end $$;

create function public.transfer_add_issue_comment(p_issue_id uuid,p_comment text,p_item_ids text[] default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare issue transfer_maintenance.transfer_issues;begin
  perform transfer_maintenance.issue_access(p_issue_id);
  select * into issue from transfer_maintenance.transfer_issues where id=p_issue_id for update;
  if issue.status='RESOLVED' then raise exception 'issue_is_resolved';end if;
  if nullif(btrim(p_comment),'') is null or length(p_comment)>5000 then raise exception 'invalid_comment';end if;
  if p_item_ids is not null and (array_position(p_item_ids,null) is not null or not p_item_ids<@(issue.outgoing_item_ids||issue.incoming_item_ids))
    then raise exception 'unrelated_item_ids';end if;
  insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,message,metadata)
    values(p_issue_id,'staff_comment',auth.uid(),case when public.is_admin() then 'admin' else 'user' end,p_comment,
      jsonb_build_object('employee',auth.uid(),'workers',(select jsonb_agg(worker) from transfer_maintenance.employee_workers where employee_id=auth.uid()),
        'related_item_ids',coalesce(p_item_ids,issue.outgoing_item_ids||issue.incoming_item_ids)));
  update transfer_maintenance.transfer_issues set status=case when status='READY_FOR_REVIEW' then status else 'STAFF_REPLIED' end where id=p_issue_id;
  return transfer_maintenance.issue_detail(p_issue_id);
end $$;
create function public.transfer_mark_issue_reviewed(p_issue_id uuid,p_comment text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.transfer_add_issue_comment(p_issue_id,p_comment);
  insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,message)
    values(p_issue_id,'staff_marked_checked',auth.uid(),case when public.is_admin() then 'admin' else 'user' end,p_comment);
  update transfer_maintenance.transfer_issues set status='READY_FOR_REVIEW' where id=p_issue_id;
  return transfer_maintenance.issue_detail(p_issue_id);
end $$;

-- Extend the existing validation. Large differences and open Issues cannot be force-matched.
alter function public.transfer_preview_match(text[],text[],integer) set schema transfer_maintenance;
alter function transfer_maintenance.transfer_preview_match(text[],text[],integer) rename to preview_base;
create function public.transfer_preview_match(p_outgoing_ids text[],p_incoming_ids text[],p_max_date_span integer default 7)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;begin
  result:=transfer_maintenance.preview_base(p_outgoing_ids,p_incoming_ids,p_max_date_span);
  if not (result->>'valid')::boolean then return result;end if;
  if abs((result->>'difference')::numeric)>0.20 then
    return result||jsonb_build_object('valid',false,'reason','weight_mismatch_requires_investigation','action','REQUIRES_INVESTIGATION');end if;
  if exists(select 1 from transfer_maintenance.transfer_issues where status<>'RESOLVED' and
    (outgoing_item_ids||incoming_item_ids)&&(p_outgoing_ids||p_incoming_ids)) then
    return result||jsonb_build_object('valid',false,'reason','item_has_open_issue','action','REQUIRES_INVESTIGATION');end if;
  return result||jsonb_build_object('action','MATCHABLE');
end $$;

create function public.transfer_resolve_issue(p_issue_id uuid,p_resolution_type text,p_resolution_note text,
  p_outgoing_ids text[] default null,p_incoming_ids text[] default null,p_max_date_span integer default 7)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare issue transfer_maintenance.transfer_issues;result jsonb;out_ids text[];in_ids text[];begin
  perform transfer_maintenance.require_admin();
  perform 1 from public.gold_ledger where worker='__TRANSFERS__' for update;
  select * into issue from transfer_maintenance.transfer_issues where id=p_issue_id;
  if not found then raise exception 'issue_not_found';end if;
  perform 1 from public.gold_ledger g where g.worker in
    (select worker from transfer_maintenance.items where item_id=any(issue.outgoing_item_ids||issue.incoming_item_ids||coalesce(p_outgoing_ids,'{}')||coalesce(p_incoming_ids,'{}')))
    order by g.worker for update;
  perform 1 from transfer_maintenance.items where item_id=any(issue.outgoing_item_ids||issue.incoming_item_ids||coalesce(p_outgoing_ids,'{}')||coalesce(p_incoming_ids,'{}')) order by item_id for update;
  select * into issue from transfer_maintenance.transfer_issues where id=p_issue_id for update;
  if not found then raise exception 'issue_not_found';end if;
  if issue.status='RESOLVED' then raise exception 'issue_is_resolved';end if;
  if p_resolution_type is null or p_resolution_type not in ('MATCH_AND_RESOLVE','RESOLVE_NO_MATCH','KEEP_SEPARATE','CORRECTED_AND_MATCHED','OTHER')
    then raise exception 'invalid_resolution_type';end if;
  if nullif(btrim(p_resolution_note),'') is null then raise exception 'resolution_note_required';end if;
  insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,message,metadata)
    values(p_issue_id,'admin_review',auth.uid(),'admin',p_resolution_note,jsonb_build_object('resolution_type',p_resolution_type,'current',transfer_maintenance.issue_detail(p_issue_id)->'current_items'));
  update transfer_maintenance.transfer_issues set status='RESOLVED',resolved_by=auth.uid(),resolved_at=clock_timestamp(),
    resolution_type=p_resolution_type,resolution_note=p_resolution_note where id=p_issue_id;
  if p_resolution_type in ('MATCH_AND_RESOLVE','CORRECTED_AND_MATCHED') then
    out_ids:=coalesce(p_outgoing_ids,issue.outgoing_item_ids);in_ids:=coalesce(p_incoming_ids,issue.incoming_item_ids);
    if not (out_ids||in_ids)&&(issue.outgoing_item_ids||issue.incoming_item_ids) then raise exception 'resolution_items_unrelated';end if;
    if exists(select 1 from transfer_maintenance.items where item_id=any(out_ids||in_ids) and
      not (worker=any(issue.assigned_workers) and counterparty=any(issue.assigned_workers))) then raise exception 'worker_pair_mismatch';end if;
    result:=public.transfer_apply_match(out_ids,in_ids,p_resolution_note,'maintenance',p_max_date_span);
    update transfer_maintenance.transfer_issues set match_id=result->>'match_id' where id=p_issue_id;
    insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,message,metadata)
      values(p_issue_id,'match_created',auth.uid(),'admin',p_resolution_note,result);
  end if;
  insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,message,metadata)
    values(p_issue_id,'issue_resolved',auth.uid(),'admin',p_resolution_note,jsonb_build_object('resolution_type',p_resolution_type,'match',result));
  return transfer_maintenance.issue_detail(p_issue_id);
end $$;
create function public.transfer_reopen_issue(p_issue_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare issue transfer_maintenance.transfer_issues;begin
  perform transfer_maintenance.require_admin();
  perform 1 from public.gold_ledger where worker='__TRANSFERS__' for update;
  select * into issue from transfer_maintenance.transfer_issues where id=p_issue_id for update;
  if not found then raise exception 'issue_not_found';end if;
  if issue.status<>'RESOLVED' then raise exception 'issue_already_open';end if;
  if nullif(btrim(p_reason),'') is null then raise exception 'reason_required';end if;
  -- Reopening never silently undoes a match. Admin must use the audited Undo RPC when necessary.
  insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,message,metadata)
    values(p_issue_id,'issue_reopened',auth.uid(),'admin',p_reason,jsonb_build_object('previous_resolution',to_jsonb(issue)));
  update transfer_maintenance.transfer_issues set status='WAITING_STAFF',possible_resolution_found=false where id=p_issue_id;
  return transfer_maintenance.issue_detail(p_issue_id);
end $$;

create function public.transfer_review_issue(p_issue_id uuid,p_note text,p_status text default 'WAITING_STAFF') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform transfer_maintenance.require_admin();
  if p_status is null or p_status not in ('OPEN','WAITING_STAFF','STAFF_REPLIED','READY_FOR_REVIEW') or nullif(btrim(p_note),'') is null
    then raise exception 'invalid_review';end if;
  perform 1 from transfer_maintenance.transfer_issues where id=p_issue_id and status<>'RESOLVED' for update;
  if not found then raise exception 'open_issue_not_found';end if;
  insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,message,metadata)
    values(p_issue_id,'admin_review',auth.uid(),'admin',p_note,jsonb_build_object('keep_open',true,'status',p_status));
  update transfer_maintenance.transfer_issues set status=p_status where id=p_issue_id;
  return transfer_maintenance.issue_detail(p_issue_id);
end $$;

create function public.transfer_get_worker_transfer_notices(p_worker text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare waiting jsonb;hours numeric;begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode='42501';end if;
  if not public.is_admin() and not exists(select 1 from transfer_maintenance.employee_workers where employee_id=auth.uid() and worker=p_worker)
    then return jsonb_build_object('issues','[]'::jsonb,'waiting','[]'::jsonb);end if;
  select transfer_receive_wait_hours into hours from transfer_maintenance.settings;
  select coalesce(jsonb_agg(jsonb_build_object('item_id',t.item_id,'date',t.date,'worker',t.worker,'counterparty',t.counterparty,'amount',t.amount,
    'deadline',coalesce(t.created_at,((t.date+1)::timestamp at time zone 'Asia/Kuala_Lumpur'))+make_interval(secs=>(hours*3600)::double precision),
    'severity','YELLOW','overdue',coalesce(t.created_at,((t.date+1)::timestamp at time zone 'Asia/Kuala_Lumpur'))+make_interval(secs=>(hours*3600)::double precision)<=now()) order by t.date,t.item_id),'[]') into waiting
    from transfer_maintenance.items t where t.available and t.amount<0 and p_worker in (t.worker,t.counterparty)
    and not exists(select 1 from transfer_maintenance.members m join transfer_maintenance.matches x using(match_id) where m.item_id=t.item_id and x.status<>'cancelled')
    and not exists(select 1 from transfer_maintenance.transfer_issues i where i.status<>'RESOLVED' and t.item_id=any(i.outgoing_item_ids||i.incoming_item_ids))
    and not exists(select 1 from transfer_maintenance.items r where r.available and r.amount>0 and r.worker=t.counterparty and r.counterparty=t.worker and abs(r.date-t.date)<=2
      and not exists(select 1 from transfer_maintenance.members m join transfer_maintenance.matches x using(match_id) where m.item_id=r.item_id and x.status<>'cancelled'));
  return jsonb_build_object('issues',public.transfer_get_open_issues(p_worker=>p_worker),'waiting',waiting);
end $$;

-- Projection changes are append-only audit events. No trigger ever clears red or creates a match.
create function transfer_maintenance.capture_issue_item_change() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare i record;begin
  if tg_op='UPDATE' and (new.date,new.amount,new.description,new.counterparty,new.available,new.archived,new.snapshot)
    is not distinct from (old.date,old.amount,old.description,old.counterparty,old.available,old.archived,old.snapshot) then return new;end if;
  for i in select * from transfer_maintenance.transfer_issues where new.item_id=any(outgoing_item_ids||incoming_item_ids) for update loop
    insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,metadata)
      values(i.id,'item_updated',auth.uid(),case when auth.uid() is null then 'system' when public.is_admin() then 'admin' else 'user' end,
        jsonb_build_object('item_id',new.item_id,'before',case when tg_op='UPDATE' then to_jsonb(old) else null end,'after',to_jsonb(new)));
    if i.status<>'RESOLVED' then update transfer_maintenance.transfer_issues set status='READY_FOR_REVIEW' where id=i.id;end if;
  end loop;
  if new.available and new.amount>0 then
    for i in select * from transfer_maintenance.transfer_issues where issue_type='SENT_NOT_RECEIVED' and status<>'RESOLVED'
      and new.worker=any(assigned_workers) and new.counterparty=any(assigned_workers)
      and exists(select 1 from transfer_maintenance.items t where t.item_id=any(outgoing_item_ids) and t.worker=new.counterparty
        and t.counterparty=new.worker and abs(t.date-new.date)<=2) and not possible_resolution_found for update loop
      update transfer_maintenance.transfer_issues set possible_resolution_found=true,status='READY_FOR_REVIEW' where id=i.id;
      insert into transfer_maintenance.transfer_issue_events(issue_id,event_type,actor,actor_role,message,metadata)
        values(i.id,'possible_resolution_found',auth.uid(),'system','New receiving entry requires administrator review',jsonb_build_object('item',to_jsonb(new)));
    end loop;
  end if;
  return new;
end $$;
create trigger transfer_issue_item_changes after insert or update on transfer_maintenance.items for each row execute function transfer_maintenance.capture_issue_item_change();

-- Candidate API keeps its signature and adds action. Investigations use a separate bounded window.
alter function public.transfer_find_candidates(date,date,text,text,numeric,integer,integer,text,integer,integer) set schema transfer_maintenance;
alter function transfer_maintenance.transfer_find_candidates(date,date,text,text,numeric,integer,integer,text,integer,integer) rename to candidates_base;
create function public.transfer_find_candidates(p_start_date date default null,p_end_date date default null,
  p_worker text default null,p_counterparty text default null,p_max_difference numeric default 0.05,
  p_max_date_span integer default 2,p_limit integer default 200,p_lane text default 'primary',p_max_group_items integer default 3,p_pool_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare normal jsonb;wide jsonb;groups jsonb;maximum numeric;begin
  perform transfer_maintenance.require_admin();
  if p_max_difference>0.20 then raise exception 'matchable_threshold_cannot_exceed_0_20';end if;
  normal:=transfer_maintenance.candidates_base(p_start_date,p_end_date,p_worker,p_counterparty,p_max_difference,p_max_date_span,p_limit,p_lane,p_max_group_items,p_pool_limit);
  select investigation_difference into maximum from transfer_maintenance.settings;
  wide:=transfer_maintenance.candidates_base(p_start_date,p_end_date,p_worker,p_counterparty,maximum,p_max_date_span,p_limit,p_lane,p_max_group_items,p_pool_limit);
  select coalesce(jsonb_agg(c||jsonb_build_object('action',case
    when exists(select 1 from transfer_maintenance.transfer_issues i where i.status<>'RESOLVED' and (i.outgoing_item_ids||i.incoming_item_ids)&&
      (array(select jsonb_array_elements_text(c->'outgoing_ids'))||array(select jsonb_array_elements_text(c->'incoming_ids')))) then 'REQUIRES_INVESTIGATION'
    when abs((c->>'difference')::numeric)>0.20 then 'REQUIRES_INVESTIGATION'
    when c->>'confidence'='AMBIGUOUS' then 'AMBIGUOUS' else 'MATCHABLE' end,
    'reason',case when abs((c->>'difference')::numeric)>0.20 then 'WEIGHT_MISMATCH' else c->>'reason' end)),'[]') into groups
  from (select c from jsonb_array_elements(normal->'candidates') c
    union all select c from jsonb_array_elements(wide->'candidates') c where abs((c->>'difference')::numeric)>0.20) x;
  return jsonb_build_object('candidates',groups,'search',normal->'search','investigation_search',wide->'search','investigation_difference',maximum);
end $$;

-- Explicit maintenance invocation only. Zero corresponding incoming entries is a conservative rule;
-- any nearby incoming entry is left for combination/weight review rather than asserted missing.
create function public.transfer_scan_receive_exceptions(p_create_issues boolean default false,p_lane text default 'primary')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare wait_hours numeric;row_data record;deadline timestamptz;results jsonb:='[]';created jsonb;begin
  perform transfer_maintenance.require_admin();select transfer_receive_wait_hours into wait_hours from transfer_maintenance.settings;
  for row_data in select u.* from public.transfer_get_unmatched(null,null,null,null,p_lane) u where amount<0
    and not exists(select 1 from transfer_maintenance.transfer_issues i where i.status<>'RESOLVED' and u.item_id=any(i.outgoing_item_ids||i.incoming_item_ids))
    and not exists(select 1 from public.transfer_get_unmatched(null,null,null,null,p_lane) r
      where r.amount>0 and r.worker=u.counterparty and r.counterparty=u.worker and abs(r.date-u.date)<=2)
    order by u.date,u.item_id loop
    -- Historical rows have no trustworthy created_at; use the end of their business day.
    deadline:=coalesce(row_data.created_at,((row_data.date+1)::timestamp at time zone 'Asia/Kuala_Lumpur'))+make_interval(secs=>(wait_hours*3600)::double precision);
    created:=null;
    if deadline<=clock_timestamp() and p_create_issues then
      created:=public.transfer_create_issue('SENT_NOT_RECEIVED',array[row_data.item_id],'{}','Receive deadline exceeded; check receipt or missing entry','RED');
    end if;
    results:=results||jsonb_build_array(to_jsonb(row_data)||jsonb_build_object('deadline',deadline,
      'severity',case when deadline<=clock_timestamp() then 'RED' else 'YELLOW' end,
      'action',case when deadline<=clock_timestamp() then 'REQUIRES_INVESTIGATION' else 'WAITING_FOR_ENTRY' end,'issue',created));
  end loop;
  return jsonb_build_object('transfer_receive_wait_hours',wait_hours,'items',results);
end $$;

-- No update/delete RPC or table grant exists for issue history.
revoke all on all functions in schema transfer_maintenance from public,anon,authenticated;
revoke all on function public.transfer_get_issue(uuid),public.transfer_get_open_issues(date,date,text,text,text,text),
  public.transfer_create_issue(text,text[],text[],text,text),public.transfer_add_issue_comment(uuid,text,text[]),
  public.transfer_mark_issue_reviewed(uuid,text),public.transfer_resolve_issue(uuid,text,text,text[],text[],integer),public.transfer_reopen_issue(uuid,text),
  public.transfer_review_issue(uuid,text,text),public.transfer_get_worker_transfer_notices(text),
  public.transfer_set_employee_workers(uuid,text[]),public.transfer_get_issue_settings(),public.transfer_set_issue_settings(numeric,numeric),
  public.transfer_scan_receive_exceptions(boolean,text),public.transfer_preview_match(text[],text[],integer),
  public.transfer_find_candidates(date,date,text,text,numeric,integer,integer,text,integer,integer) from public,anon;
grant execute on function public.transfer_get_issue(uuid),public.transfer_get_open_issues(date,date,text,text,text,text),
  public.transfer_create_issue(text,text[],text[],text,text),public.transfer_add_issue_comment(uuid,text,text[]),
  public.transfer_mark_issue_reviewed(uuid,text),public.transfer_resolve_issue(uuid,text,text,text[],text[],integer),public.transfer_reopen_issue(uuid,text),
  public.transfer_review_issue(uuid,text,text),public.transfer_get_worker_transfer_notices(text),
  public.transfer_set_employee_workers(uuid,text[]),public.transfer_get_issue_settings(),public.transfer_set_issue_settings(numeric,numeric),
  public.transfer_scan_receive_exceptions(boolean,text),public.transfer_preview_match(text[],text[],integer),
  public.transfer_find_candidates(date,date,text,text,numeric,integer,integer,text,integer,integer) to authenticated;
notify pgrst,'reload schema';
commit;
