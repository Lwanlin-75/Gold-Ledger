CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'user')
  on conflict (id) do nothing;
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.update_special_field(p_key text, p_field text, p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb;
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  select data into d from gold_ledger where worker = p_key;
  if d is null then d := '{}'::jsonb; end if;
  d := jsonb_set(d, array[p_field], p_value);
  insert into gold_ledger(worker, data, updated_at) values (p_key, d, now())
  on conflict (worker) do update set data = excluded.data, updated_at = now();
end;
$function$;
CREATE OR REPLACE FUNCTION public.admin_get_row(p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb;
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  select data into d from gold_ledger where worker = p_key;
  return d;
end;
$function$;
CREATE OR REPLACE FUNCTION public.admin_upsert_row(p_worker text, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  insert into gold_ledger(worker, data, updated_at) values (p_worker, p_data, now())
  on conflict (worker) do update set data = excluded.data, updated_at = now();
end;
$function$;
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$function$;
CREATE OR REPLACE FUNCTION public.get_ledger_rows(p_keys text[])
 RETURNS TABLE(worker text, data jsonb, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if is_admin() then
    return query
      select g.worker, g.data, g.updated_at
      from gold_ledger g
      where g.worker = any(p_keys);
  else
    return query
      select
        g.worker,
        jsonb_set(
          g.data,
          '{history}',
          coalesce((
            select jsonb_agg(h)
            from jsonb_array_elements(coalesce(g.data->'history','[]'::jsonb)) h
            where (h->>'date')::date >= (current_date - interval '3 days')
          ), '[]'::jsonb)
        ) as data,
        g.updated_at
      from gold_ledger g
      where g.worker = any(p_keys);
  end if;
end;
$function$;
CREATE OR REPLACE FUNCTION public.upsert_draft_item(p_worker text, p_date text, p_item jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into gold_ledger(worker, data, updated_at)
  values (p_worker, jsonb_build_object('lastWeight', null, 'history', '[]'::jsonb, 'drafts', '{}'::jsonb), now())
  on conflict (worker) do nothing;

  update gold_ledger
  set data = jsonb_set(
        data,
        array['drafts', p_date],
        coalesce(data#>array['drafts', p_date], '[]'::jsonb) || jsonb_build_array(p_item)
      ),
      updated_at = now()
  where worker = p_worker;
end;
$function$;
CREATE OR REPLACE FUNCTION public.remove_draft_item(p_worker text, p_date text, p_item_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  filtered jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select coalesce(jsonb_agg(elem), '[]'::jsonb) into filtered
  from gold_ledger, jsonb_array_elements(coalesce(data#>array['drafts', p_date], '[]'::jsonb)) elem
  where worker = p_worker and (elem->>'id') <> p_item_id;

  update gold_ledger
  set data = jsonb_set(data, array['drafts', p_date], filtered),
      updated_at = now()
  where worker = p_worker;
end;
$function$;
CREATE OR REPLACE FUNCTION public.save_day(p_worker text, p_date text, p_actual numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  cur_data jsonb;
  hist jsonb;
  drafts jsonb;
  day_txns jsonb;
  last_record jsonb;
  prev_weight numeric;
  total numeric;
  expected numeric;
  loss numeric;
  new_record jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  select data into cur_data from gold_ledger where worker = p_worker for update;
  if cur_data is null then
    cur_data := jsonb_build_object('lastWeight', null, 'history', '[]'::jsonb, 'drafts', '{}'::jsonb);
  end if;

  hist := coalesce(cur_data->'history', '[]'::jsonb);
  drafts := coalesce(cur_data->'drafts', '{}'::jsonb);
  day_txns := coalesce(drafts->p_date, '[]'::jsonb);

  if jsonb_array_length(hist) > 0 then
    last_record := hist->(jsonb_array_length(hist)-1);
    prev_weight := (last_record->>'actual')::numeric;
  else
    prev_weight := null;
  end if;

  select coalesce(sum((t->>'amount')::numeric),0) into total
  from jsonb_array_elements(day_txns) t;

  if prev_weight is not null then
    expected := prev_weight + total;
    loss := p_actual - expected;
  else
    expected := null;
    loss := null;
  end if;

  new_record := jsonb_build_object(
    'date', p_date, 'prevWeight', prev_weight, 'transactions', day_txns,
    'total', total, 'expected', expected, 'actual', p_actual, 'loss', loss, 'exported', false
  );

  insert into gold_ledger(worker, data, updated_at)
  values (p_worker, jsonb_build_object(
      'lastWeight', p_actual,
      'history', hist || jsonb_build_array(new_record),
      'drafts', drafts - p_date
    ), now())
  on conflict (worker) do update
    set data = jsonb_build_object(
      'lastWeight', p_actual,
      'history', hist || jsonb_build_array(new_record),
      'drafts', drafts - p_date
    ),
    updated_at = now();
end;
$function$;
CREATE OR REPLACE FUNCTION public.admin_delete_special_record(p_key text, p_record_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d jsonb;
  new_history jsonb;
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  select data into d from gold_ledger where worker = p_key for update;
  if d is null then return; end if;
  select coalesce(jsonb_agg(elem), '[]'::jsonb) into new_history
  from jsonb_array_elements(coalesce(d->'history','[]'::jsonb)) elem
  where (elem->>'id') <> p_record_id;
  update gold_ledger set data = jsonb_set(d,'{history}', new_history), updated_at = now() where worker = p_key;
end;
$function$;
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
CREATE OR REPLACE FUNCTION public.update_special_record(p_key text, p_record_id text, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d jsonb;
  new_history jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select data into d from gold_ledger where worker = p_key for update;
  if d is null then raise exception 'not found'; end if;
  select coalesce(jsonb_agg(
    case when (elem->>'id') = p_record_id then elem || p_patch else elem end
  ), '[]'::jsonb) into new_history
  from jsonb_array_elements(coalesce(d->'history','[]'::jsonb)) elem;
  update gold_ledger set data = jsonb_set(d, '{history}', new_history), updated_at = now() where worker = p_key;
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
CREATE OR REPLACE FUNCTION public.get_special_row(p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select data into d from gold_ledger where worker = p_key;
  if d is null then return null; end if;
  if is_admin() then
    return d;
  else
    return jsonb_set(
      d, '{history}',
      coalesce((
        select jsonb_agg(h) from jsonb_array_elements(coalesce(d->'history','[]'::jsonb)) h
        where coalesce(
                (h->>'date'), (h->>'sentDate'), (h->>'receivedDate'), (h->>'matchedAt'), '1970-01-01'
              )::date
              >= (current_date - interval '3 days')
      ), '[]'::jsonb)
    );
  end if;
end;
$function$;
CREATE OR REPLACE FUNCTION public.edit_history_record(p_worker text, p_old_date text, p_new_date text, p_transactions jsonb, p_actual numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d jsonb;
  hist jsonb;
  idx int;
  n int;
  rec jsonb;
  prev numeric;
  total numeric;
  expected numeric;
  loss numeric;
  i int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  select data into d from gold_ledger where worker = p_worker for update;
  if d is null then raise exception 'worker not found'; end if;

  hist := coalesce(d->'history', '[]'::jsonb);
  n := jsonb_array_length(hist);

  idx := null;
  for i in 0..n-1 loop
    if (hist->i->>'date') = p_old_date then
      idx := i;
      exit;
    end if;
  end loop;
  if idx is null then
    raise exception 'record not found for date %', p_old_date;
  end if;

  if not is_admin() and p_old_date::date < (current_date - interval '3 days') then
    raise exception 'not authorized to edit records older than 3 days';
  end if;

  if coalesce((hist->idx->>'exported')::boolean, false) then
    raise exception 'record already archived, cannot edit';
  end if;

  rec := hist->idx;
  rec := jsonb_set(rec, '{date}', to_jsonb(p_new_date));
  rec := jsonb_set(rec, '{transactions}', p_transactions);
  rec := jsonb_set(rec, '{actual}', to_jsonb(p_actual));
  hist := jsonb_set(hist, array[idx::text], rec);

  if idx = 0 then
    prev := null;
  else
    prev := (hist->(idx - 1)->>'actual')::numeric;
  end if;

  for i in idx..n - 1 loop
    rec := hist->i;
    if coalesce((rec->>'exported')::boolean, false) then
      rec := jsonb_set(rec, '{prevWeight}', to_jsonb(prev));
    else
      select coalesce(sum((t->>'amount')::numeric), 0) into total
        from jsonb_array_elements(coalesce(rec->'transactions', '[]'::jsonb)) t;
      if prev is not null then
        expected := prev + total;
        loss := (rec->>'actual')::numeric - expected;
      else
        expected := null;
        loss := null;
      end if;
      rec := jsonb_set(rec, '{prevWeight}', to_jsonb(prev));
      rec := jsonb_set(rec, '{total}', to_jsonb(total));
      rec := jsonb_set(
        rec, '{expected}',
        case when expected is null then 'null'::jsonb else to_jsonb(expected) end
      );
      rec := jsonb_set(
        rec, '{loss}',
        case when loss is null then 'null'::jsonb else to_jsonb(loss) end
      );
    end if;
    hist := jsonb_set(hist, array[i::text], rec);
    prev := (rec->>'actual')::numeric;
  end loop;

  d := jsonb_set(d, '{history}', hist);
  d := jsonb_set(d, '{lastWeight}', to_jsonb(prev));
  update gold_ledger set data = d, updated_at = now() where worker = p_worker;
end;
$function$;
