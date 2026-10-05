-- 在 Supabase SQL Editor 运行（先运行 migrations/20261007_transfer_lanes.sql）。
-- JJ 账号：JJ、倒模；PD 账号：PD Lv1、PD Lv2、Lv1倒模、Lv1车花。
-- 可重复运行。
begin;
select set_config('request.jwt.claim.sub',(select id::text from public.profiles where email='jewelleryrosmerah@gmail.com'),true);
select public.transfer_set_employee_workers((select id from public.profiles where email='jj@jjstore.local'),array['JJ','倒模']);
select public.transfer_set_employee_workers((select id from public.profiles where email='pdlv2@jjstore.local'),array['PD Lv1','PD Lv2','Lv1倒模','Lv1车花']);
commit;
-- 检查
select p.email,array_agg(e.worker order by e.worker) as workers from transfer_maintenance.employee_workers e join public.profiles p on p.id=e.employee_id group by p.email;
