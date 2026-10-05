import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { todayInMalaysia, shiftDay, WriteGate } from '../src/ledgerSafety.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const db=new PGlite();
const ADMIN='00000000-0000-0000-0000-000000000001', JJ='00000000-0000-0000-0000-000000000002', PD='00000000-0000-0000-0000-000000000003';
const q=(sql,args=[])=>db.query(sql,args);
const rpc=async(name,args=[]) => (await q(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as r`,args)).rows[0].r;
const actor=async(id)=>q("select set_config('request.jwt.claim.sub',$1,false)",[id]);
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('PASS',name);};
await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table profiles(id uuid primary key,email text,role text not null,created_at timestamptz default now());
create table gold_ledger(worker text primary key,data jsonb not null,updated_at timestamptz not null default now());
alter table gold_ledger enable row level security;
insert into profiles(id,role) values('${ADMIN}','admin'),('${JJ}','user'),('${PD}','user');`);
await db.exec(fs.readFileSync(path.join(root,'tests/production-functions.sql'),'utf8'));
for(const migration of ['20261005_transfer_maintenance.sql','20261005_transfer_issues.sql','20261006_ledger_safety.sql'])
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',migration),'utf8'));
await actor(ADMIN);
await rpc('transfer_set_employee_workers',[JJ,['JJ']]);
await rpc('transfer_set_employee_workers',[PD,['PD Lv1','PD Lv2']]);
const day=(await q('select transfer_maintenance.business_today()::text as day')).rows[0].day;
const yesterday=shiftDay(day,-1);
const item=(id,amount,dest='老板')=>({id,amount,dest,desc:id});
const add=(worker,id,amount,dest,date=day)=>rpc('upsert_draft_item',[worker,date,item(id,amount,dest)]);
await test('Malaysia midnight, date shifts and synchronous settlement gate',async()=>{
  assert.equal(todayInMalaysia(new Date('2026-10-04T16:01:00Z')),'2026-10-05');
  assert.equal(todayInMalaysia(new Date('2026-10-04T15:59:00Z')),'2026-10-04');
  assert.equal(shiftDay('2026-01-01',-1),'2025-12-31');
  const gate=new WriteGate();assert.throws(()=>gate.begin());gate.recovered();gate.begin();
  assert.equal(gate.canWrite(),false);assert.throws(()=>gate.begin());gate.finish(false);
  assert.equal(gate.canWrite(),false);gate.recovered();assert.equal(gate.canWrite(),true);
});
await test('JJ and PD scopes enforced on all Worker write RPCs; admin retains all',async()=>{
  await actor(JJ);assert.deepEqual(await rpc('ledger_get_worker_scope'),['JJ']);await add('JJ','jj-allowed',-1);
  for(const worker of ['PD Lv1','PD Lv2','倒模']) {
    await assert.rejects(add(worker,'denied-'+worker,-1),/worker_scope_denied/);
    await assert.rejects(rpc('remove_draft_item',[worker,day,'x']),/worker_scope_denied/);
    await assert.rejects(rpc('save_day',[worker,day,10]),/worker_scope_denied/);
    await assert.rejects(rpc('edit_history_record',[worker,day,day,[],10]),/worker_scope_denied/);
  }
  await actor(PD);assert.deepEqual(await rpc('ledger_get_worker_scope'),['PD Lv1','PD Lv2']);
  await add('PD Lv1','pd1-allowed',1);await add('PD Lv2','pd2-allowed',1);
  await assert.rejects(add('JJ','pd-denied',1),/worker_scope_denied/);
  await actor(ADMIN);assert.equal((await rpc('ledger_get_worker_scope')).length,6);
});
await test('draft retries are idempotent and conflicting UUIDs fail',async()=>{
  await actor(JJ);await add('JJ','retry-id',-2);await add('JJ','retry-id',-2);
  const d=(await q("select data from gold_ledger where worker='JJ'")).rows[0].data;
  assert.equal(d.drafts[day].filter(x=>x.id==='retry-id').length,1);
  await assert.rejects(add('JJ','retry-id',-3),/item_id_conflict/);
  await assert.rejects(add('JJ','future',1,'老板',shiftDay(day,1)),/date_outside_allowed_range/);
  await assert.rejects(add('JJ','old',1,'老板',shiftDay(day,-4)),/date_outside_allowed_range/);
  await actor(ADMIN);
});
await test('save preserves boxWeight and prevents duplicate day/late drafts',async()=>{
  await rpc('update_special_field',['JJ','boxWeight',200.38]);
  await rpc('save_day',['JJ',day,100]);
  const d=(await q("select data from gold_ledger where worker='JJ'")).rows[0].data;
  assert.equal(d.boxWeight,200.38);assert.equal(d.history[0].transactions.length,2);
  await assert.rejects(rpc('save_day',['JJ',day,100]),/save_days_in_order/);
  await assert.rejects(add('JJ','late-draft',1),/day_already_saved_edit_history/);
  await rpc('ledger_undo_last_day',['JJ',d.history[0],'test undo']);
  const undone=(await q("select data from gold_ledger where worker='JJ'")).rows[0].data;
  assert.equal(undone.history.length,0);assert.equal(undone.drafts[day].length,2);
  await assert.rejects(rpc('ledger_undo_last_day',['JJ',d.history[0],'stale']),/ledger_changed_refresh_required/);
});
let shipment;
await test('shipment and flow are atomic, weight authoritative, scope checked',async()=>{
  await actor(PD);
  shipment={id:'shipment-test',fromWorker:'PD Lv2',toWorker:'PD门市',date:day,items:[{category:'戒指',weight:5}],sentTotal:999,sentItemId:'ship-flow',status:'pending'};
  const r=await rpc('shipment_create_with_flow',[shipment,'出货 戒指']);assert.equal(r.sentTotal,5);
  await rpc('shipment_create_with_flow',[shipment,'出货 戒指']);
  assert.equal((await q("select jsonb_array_length(data->'history') as n from gold_ledger where worker='__SHIPMENTS__'")).rows[0].n,1);
  await assert.rejects(rpc('shipment_create_with_flow',[{...shipment,id:'bad-scope',fromWorker:'JJ'},'x']),/worker_scope_denied/);
  await assert.rejects(rpc('append_special_record',['__SHIPMENTS__',shipment]),/use_shipment_create_with_flow/);
  await assert.rejects(rpc('update_special_record',['__SHIPMENTS__','shipment-test',{status:'confirmed'}]),/not_authorized/);
  await actor(ADMIN);
  await rpc('save_day',['PD Lv2',day,200]);
  await assert.rejects(rpc('shipment_create_with_flow',[{...shipment,id:'bad-day',sentItemId:'bad-flow'},'x']),/day_already_saved/);
  assert.equal((await q("select jsonb_array_length(data->'history') as n from gold_ledger where worker='__SHIPMENTS__'")).rows[0].n,1);
});
await test('shipment deletion removes history flow and recomputes in same transaction',async()=>{
  await rpc('shipment_delete_with_flow',['shipment-test','test deletion']);
  const d=(await q("select data from gold_ledger where worker='PD Lv2'")).rows[0].data;
  assert.ok(!d.history[0].transactions.some(x=>x.id==='ship-flow'));assert.equal(d.history[0].total,1);
  const events=await rpc('ledger_get_audit',['PD Lv2']);assert.ok(events.some(x=>x.before_data.history?.some(h=>h.transactions?.some(t=>t.id==='ship-flow'))));
});
await test('archive is all-or-nothing for changed export and preserves unmatched/open issues',async()=>{
  await add('倒模','archive-ok',-2,'老板',yesterday);await rpc('save_day',['倒模',yesterday,20]);
  await add('PD Lv1','archive-unmatched',-3,'JJ');await rpc('save_day',['PD Lv1',day,30]);
  const record=async(w)=>(await q('select data->\'history\'->0 as r from gold_ledger where worker=$1',[w])).rows[0].r;
  const ok=await record('倒模'),blocked=await record('PD Lv1');
  await assert.rejects(rpc('ledger_archive_batch',[[{worker:'倒模',date:yesterday,record:ok},{worker:'PD Lv1',date:day,record:{...blocked,actual:999}}]]),/ledger_changed_since_export/);
  assert.equal((await record('倒模')).exported,false);
  const result=await rpc('ledger_archive_batch',[[{worker:'倒模',date:yesterday,record:ok},{worker:'PD Lv1',date:day,record:blocked}]]);
  assert.equal(result.archived_days,1);assert.equal(result.retained.length,1);
  assert.ok((await record('PD Lv1')).transactions.some(x=>x.id==='archive-unmatched'));
  await actor(JJ);await assert.rejects(rpc('ledger_archive_batch',[[]]),/not_authorized/);
  await assert.rejects(rpc('ledger_get_audit'),/not_authorized/);await actor(ADMIN);
});
await test('private bypass implementations and audit table inaccessible to authenticated',async()=>{
  await actor(JJ);await db.exec('set role authenticated');
  await assert.rejects(q('select * from transfer_maintenance.ledger_events'),/permission denied/);
  await assert.rejects(q("select transfer_maintenance.remove_draft_base('PD Lv2',$1,'x')",[day]),/permission denied/);
  await db.exec('reset role');
});
await test('new safety layer retains transfer matching and red Issue review lifecycle',async()=>{
  await actor(ADMIN);
  await add('JJ','safety-out',-10,'PD Lv2',yesterday);
  await add('PD Lv2','safety-in-a',4,'JJ',yesterday);
  await add('PD Lv2','safety-in-b',6,'JJ',yesterday);
  const p=await rpc('transfer_preview_match',[['safety-out'],['safety-in-a','safety-in-b']]);assert.equal(p.valid,true);
  const m=await rpc('transfer_apply_match',[['safety-out'],['safety-in-a','safety-in-b'],'safe after upgrade']);assert.equal(m.total_in,10);
  await add('JJ','safety-issue-out',-81.55,'PD Lv1');await add('PD Lv1','safety-issue-in',81.20,'JJ',yesterday);
  const i=await rpc('transfer_create_issue',['WEIGHT_MISMATCH',['safety-issue-out'],['safety-issue-in'],'Please reweigh']);
  await actor(PD);const notices=await rpc('transfer_get_worker_transfer_notices',['PD Lv1']);assert.ok(notices.issues.some(x=>x.id===i.id));
  const reviewed=await rpc('transfer_mark_issue_reviewed',[i.id,'Checked; administrator review needed']);assert.equal(reviewed.is_red,true);
  await actor(ADMIN);await rpc('transfer_resolve_issue',[i.id,'KEEP_SEPARATE','Different shipments; explanation accepted']);
});
await test('safety rollback preserves ledger and audit and restores prior RPCs',async()=>{
  await actor(ADMIN);
  const before=(await q('select worker,data,updated_at from gold_ledger order by worker')).rows;
  const count=(await q('select count(*)::int as n from transfer_maintenance.ledger_events')).rows[0].n;
  await db.exec(fs.readFileSync(path.join(root,'supabase/rollback/20261006_ledger_safety.sql'),'utf8'));
  assert.deepEqual((await q('select worker,data,updated_at from gold_ledger order by worker')).rows,before);
  assert.equal((await q('select count(*)::int as n from transfer_maintenance.ledger_events')).rows[0].n,count);
  await db.exec(fs.readFileSync(path.join(root,'supabase/rollback/20261005_transfer_maintenance.sql'),'utf8'));
  assert.equal((await q('select count(*)::int as n from transfer_maintenance_archive_20261005.ledger_events')).rows[0].n,count);
});
await db.close();console.log(JSON.stringify({passed}));
