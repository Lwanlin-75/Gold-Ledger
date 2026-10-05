-- 补 3 条 PD Lv2 漏记（依据：Lv1↔Lv2 WhatsApp 群秤照片 + ➖/➕ 标记）
--   2026-08-17  PD Lv2 +9.19   来自 PD Lv1（Jackyleong 18:11 ➖9.19 → hui 18:18 ➕9.19）
--   2026-08-21  PD Lv2 +43.67  来自 PD Lv1（HaoRong 13:50 ➖43.67 → hui 14:38 ➕43.66）
--   2026-09-25  PD Lv2 -18.80  给 PD Lv1（hui 17:25 ➖18.80 → Jackyleong 17:31 ➕18.79）
-- 只改当天流水并重算当天「要有/损耗」，实重不动；后一天的「要有」来自前一天实重，不受影响。
-- 在 Supabase SQL editor 运行。已有同重量同去向流水则跳过，所以重复运行是安全的。
begin;
select set_config('request.jwt.claim.sub',(select id::text from public.profiles where email='jewelleryrosmerah@gmail.com'),true);

create temp table _fix(day text, amt numeric, dest text, descr text) on commit drop;
insert into _fix values
 ('2026-08-17',  9.19,'PD Lv1','上楼'),
 ('2026-08-21', 43.67,'PD Lv1','上楼'),
 ('2026-09-25',-18.80,'PD Lv1','下楼');

-- 事前：当天记录
select f.day,h->>'expected' as expected_before,h->>'actual' as actual,h->>'loss' as loss_before,h->'transactions' as tx_before
from _fix f join public.gold_ledger g on g.worker='PD Lv2'
cross join lateral jsonb_array_elements(g.data->'history') h where h->>'date'=f.day;

do $$
declare f record; h jsonb; tx jsonb;
begin
  for f in select * from _fix loop
    select x into h from public.gold_ledger g cross join lateral jsonb_array_elements(g.data->'history') x
      where g.worker='PD Lv2' and x->>'date'=f.day;
    if h is null then raise exception '找不到 PD Lv2 % 的已保存记录，停止', f.day; end if;
    if coalesce((h->>'exported')::boolean,false) then raise exception '% 已归档，不能改', f.day; end if;
    tx:=coalesce(h->'transactions','[]'::jsonb);
    if exists(select 1 from jsonb_array_elements(tx) t where (t->>'amount')::numeric=f.amt and t->>'dest'=f.dest) then
      raise notice '% 已有 % % ，跳过',f.day,f.amt,f.dest; continue;
    end if;
    tx:=tx||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'desc',f.descr,'amount',f.amt,'dest',f.dest));
    perform public.edit_history_record('PD Lv2',f.day,f.day,tx,(h->>'actual')::numeric);
  end loop;
end $$;

-- 事后：当天记录
select f.day,h->>'expected' as expected_after,h->>'actual' as actual,h->>'loss' as loss_after,h->'transactions' as tx_after
from _fix f join public.gold_ledger g on g.worker='PD Lv2'
cross join lateral jsonb_array_elements(g.data->'history') h where h->>'date'=f.day;
-- 看完结果没问题再 commit；有问题就改成 rollback。
commit;
