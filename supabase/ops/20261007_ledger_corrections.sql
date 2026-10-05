-- 补漏记 + 纠正笔误（依据：出进重量群 / Lv1↔Lv2 群的秤照片）
-- 在 Supabase SQL editor 一次性运行即可。可重复运行(已存在的会跳过)。
-- 只改被编辑那一天的流水并重算当天「要有/损耗」，实重不动；已归档的天会跳过并在结果里说明。
-- 金额符号 = 台账符号（负=发出，正=收到）。dest：JJ 这边写 'PD Lv2'，Lv2 这边写 'JJ' / 'PD Lv1'。
begin;
select set_config('request.jwt.claim.sub',(select id::text from public.profiles where email='jewelleryrosmerah@gmail.com'),true);

create temp table _fix(worker text, day text, op text, amt numeric, newamt numeric, dest text, descr text) on commit drop;
insert into _fix values
 -- ===== PD Lv1↔Lv2 =====
 ('PD Lv2','2026-08-17','add',   9.19, null,'PD Lv1','上楼'),
 ('PD Lv2','2026-08-21','add',  43.67, null,'PD Lv1','上楼'),
 ('PD Lv2','2026-09-25','add', -18.80, null,'PD Lv1','下楼'),
 ('PD Lv2','2026-09-25','dedupe',-20.87,null,null,null),        -- 照片只有一笔 20.87/20.86
 -- ===== JJ↔PD Lv2 补漏记 =====
 ('JJ'    ,'2026-08-01','add',-109.29, null,'PD Lv2','补:志凯8/1 18:28出'),
 ('PD Lv2','2026-08-11','add',  11.24, null,'JJ','补:jian 8/11 09:34收'),
 ('PD Lv2','2026-08-11','add',  55.07, null,'JJ','补:jian 8/11 09:35收'),
 ('JJ'    ,'2026-08-14','add', -24.26, null,'PD Lv2','补:wk 8/14 17:20出pd'),
 ('JJ'    ,'2026-08-14','add',  23.02, null,'PD Lv2','补:掉色回 8/14'),
 ('PD Lv2','2026-08-23','add',  32.62, null,'JJ','补:hui 8/23 09:18加(志凯8/22出)'),
 ('PD Lv2','2026-08-23','add', -25.01, null,'JJ','补:hui 8/23 18:18出掉色'),
 ('PD Lv2','2026-08-30','add',  64.35, null,'JJ','补:志凯8/30 09:31出镭射'),
 ('PD Lv2','2026-09-09','add',  11.43, null,'JJ','补:hui 9/9 18:27(42.26=30.85+11.43)'),
 ('JJ'    ,'2026-09-12','add', -61.63, null,'PD Lv2','补:wk 9/12 15:10出'),
 -- ===== 笔误纠正（改金额）=====
 ('PD Lv2','2026-08-12','amend', 109.80, 109.90,null,null),
 ('JJ'    ,'2026-08-14','amend', -22.00, -22.93,null,null),
 ('JJ'    ,'2026-09-08','amend',  42.47,  42.27,null,null);

create temp table _res(worker text, day text, op text, amt numeric, result text) on commit drop;

do $$
declare f record; h jsonb; tx jsonb; newtx jsonb; found boolean; seen boolean; t jsonb; ord int;
begin
  for f in select * from _fix loop
    select x into h from public.gold_ledger g cross join lateral jsonb_array_elements(g.data->'history') x
      where g.worker=f.worker and x->>'date'=f.day;
    if h is null then insert into _res values(f.worker,f.day,f.op,f.amt,'跳过:该日没有保存记录'); continue; end if;
    if coalesce((h->>'exported')::boolean,false) then insert into _res values(f.worker,f.day,f.op,f.amt,'跳过:已归档'); continue; end if;
    tx:=coalesce(h->'transactions','[]'::jsonb);

    if f.op='add' then
      if exists(select 1 from jsonb_array_elements(tx) e where (e->>'amount')::numeric=f.amt and e->>'dest'=f.dest) then
        insert into _res values(f.worker,f.day,f.op,f.amt,'跳过:已存在'); continue; end if;
      if not exists(select 1 from public.gold_ledger g cross join lateral jsonb_array_elements(g.data->'history') x
                    cross join lateral jsonb_array_elements(coalesce(x->'transactions','[]'::jsonb)) e
                    where g.worker=f.worker and e->>'dest'=f.dest) then
        insert into _res values(f.worker,f.day,f.op,f.amt,'跳过:去向名 '||f.dest||' 在该账号从未出现，需人工确认'); continue; end if;
      newtx:=tx||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'desc',f.descr,'amount',f.amt,'dest',f.dest));

    elsif f.op='amend' then
      if exists(select 1 from jsonb_array_elements(tx) e where (e->>'amount')::numeric=f.newamt) then
        insert into _res values(f.worker,f.day,f.op,f.amt,'跳过:已是 '||f.newamt); continue; end if;
      found:=false; newtx:='[]'::jsonb;
      for t in select e from jsonb_array_elements(tx) e loop
        if not found and (t->>'amount')::numeric=f.amt then
          t:=jsonb_set(t,'{amount}',to_jsonb(f.newamt)); found:=true; end if;
        newtx:=newtx||jsonb_build_array(t);
      end loop;
      if not found then insert into _res values(f.worker,f.day,f.op,f.amt,'跳过:找不到该金额'); continue; end if;

    elsif f.op='dedupe' then
      if (select count(*) from jsonb_array_elements(tx) e where (e->>'amount')::numeric=f.amt)<>2 then
        insert into _res values(f.worker,f.day,f.op,f.amt,'跳过:不是恰好两笔'); continue; end if;
      seen:=false; newtx:='[]'::jsonb;
      for t in select e from jsonb_array_elements(tx) e loop
        if not seen and (t->>'amount')::numeric=f.amt then seen:=true; newtx:=newtx||jsonb_build_array(t);
        elsif seen and (t->>'amount')::numeric=f.amt then null; -- 丢掉第二笔
        else newtx:=newtx||jsonb_build_array(t); end if;
      end loop;
      -- 只丢一笔：上面会丢掉所有后续同额，这里限制为只丢一笔
      if (select count(*) from jsonb_array_elements(newtx) e where (e->>'amount')::numeric=f.amt)<1 then
        insert into _res values(f.worker,f.day,f.op,f.amt,'跳过:异常'); continue; end if;
    end if;

    perform public.edit_history_record(f.worker,f.day,f.day,newtx,(h->>'actual')::numeric);
    insert into _res values(f.worker,f.day,f.op,f.amt,'已执行');
  end loop;
end $$;

select * from _res order by day, worker;
-- 看结果：全部「已执行」或合理的「跳过」就 commit；有疑问把下一行改成 rollback。
commit;
