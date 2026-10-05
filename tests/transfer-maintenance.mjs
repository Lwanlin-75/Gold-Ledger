import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const ADMIN='00000000-0000-0000-0000-000000000001';
const WORKER='00000000-0000-0000-0000-000000000002';
const checks=[];
async function test(name,fn) {await fn(); checks.push(name); console.log('PASS',name);}
const q = (sql,params=[])=>db.query(sql,params);
const rpc = async (name,args=[]) => (await q(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`,args)).rows[0].result;
const day=new Date().toISOString().slice(0,10);
const item=(id,amount,dest)=>({id,amount,dest,desc:`test ${id}`});
await db.exec(`create role anon; create role authenticated; create role service_role;
 create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table public.profiles(id uuid primary key,email text,role text not null default 'user',created_at timestamptz not null default now());
 create table public.gold_ledger(worker text primary key,data jsonb not null,updated_at timestamptz not null default now());
 alter table public.gold_ledger enable row level security;
 alter table public.profiles enable row level security;
 insert into profiles(id,role) values('${ADMIN}','admin'),('${WORKER}','user');`);
// The fixture is exported from the live schema, not the outdated setup script.
await db.exec(fs.readFileSync(path.join(root,'tests/production-functions.sql'),'utf8'));
let prod;
if (process.env.TRANSFER_PRODUCTION_FIXTURE) {
  prod=JSON.parse(fs.readFileSync(process.env.TRANSFER_PRODUCTION_FIXTURE,'utf8').replace(/^\uFEFF/,''));
  for (const row of prod.rows) await q('insert into gold_ledger(worker,data,updated_at) values($1,$2,$3)',[row.worker,row.data,row.updated_at]);
}
const before=(await q('select worker,data,updated_at from gold_ledger order by worker')).rows;
await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261005_transfer_maintenance.sql'),'utf8'));
await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261005_transfer_issues.sql'),'utf8'));
await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261007_transfer_lanes.sql'),'utf8'));
await test('production JSON, historical match IDs and updated_at unchanged by migration',async()=>{
  assert.deepEqual((await q('select worker,data,updated_at from gold_ledger order by worker')).rows,before);
});
await q("select set_config('request.jwt.claim.sub',$1,false)",[ADMIN]);
await test('existing duplicate claims are quarantined without releasing their items',async()=>{
  if (!prod) return;
  const conflicts=await rpc('transfer_get_match',[null,'legacy_conflict']);
  assert.ok(conflicts.length>0);
  assert.equal((await q('select count(*)::int as n from (select item_id from transfer_maintenance.members where active group by item_id having count(*)>1) x')).rows[0].n,0);
});
// All fixtures below are synthetic. They only run in this isolated database.
async function add(worker,id,amount,dest,date=day) {return rpc('upsert_draft_item',[worker,date,item(id,amount,dest)]);}
await test('6 and 50 unmatched do not block new draft entries',async()=>{
  await q("select set_config('request.jwt.claim.sub',$1,false)",[WORKER]);
  for(let n=0;n<6;n++) await add('JJ',`cap${n}`,-1,'PD Lv2');
  await add('JJ','after6',-2,'老板');
  for(let n=6;n<50;n++) await add('JJ',`cap${n}`,-1,'PD Lv2');
  await add('JJ','after50',-2,'老板');
  const data=(await q("select data from gold_ledger where worker='JJ'")).rows[0].data;
  assert.ok(data.drafts[day].some(x=>x.id==='after6'));
  assert.ok(data.drafts[day].some(x=>x.id==='after50'));
  await q("select set_config('request.jwt.claim.sub',$1,false)",[ADMIN]);
});
await test('get seven days and filter both directions of a worker pair',async()=>{
  const all=(await q('select * from transfer_get_unmatched($1::date-6,$1::date)',[day])).rows;
  assert.ok(all.filter(x=>x.item_id.startsWith('cap')).length===50);
  const pair=(await q('select * from transfer_get_unmatched(null,null,$1,$2)',['JJ','PD Lv2'])).rows;
  assert.ok(pair.every(x=>x.worker==='JJ'&&x.counterparty==='PD Lv2'));
});
await add('JJ','out30',-30,'PD Lv2'); await add('JJ','out20',-20,'PD Lv2'); await add('JJ','out50',-50,'PD Lv2');
await add('PD Lv2','in100',100,'JJ'); await add('JJ','out100',-100,'PD Lv2');
await test('preview 1:1 and N:1 is read only with precise totals',async()=>{
  let p=await rpc('transfer_preview_match',[['out100'],['in100']]); assert.equal(p.valid,true); assert.equal(p.difference,0);
  p=await rpc('transfer_preview_match',[['out30','out20','out50'],['in100']]); assert.equal(p.valid,true); assert.equal(p.total_out,100); assert.equal(p.outgoing_count,3);
  assert.equal((await rpc('transfer_preview_match',[['out30','out30'],['in100']])).reason,'duplicate_id');
  await add('PD Lv1','wrong',100,'JJ');
  assert.equal((await rpc('transfer_preview_match',[['out100'],['wrong']])).reason,'worker_pair_mismatch');
  assert.equal((await rpc('transfer_preview_match',[['missing'],['in100']])).reason,'item_not_found');
});
let match;
await test('apply N:1, double pairing rejection and full rollback',async()=>{
  match=await rpc('transfer_apply_match',[['out30','out20','out50'],['in100'],'test']); assert.equal(match.total_out,100);
  assert.equal((await rpc('transfer_preview_match',[['out30'],['wrong']])).reason,'item_already_matched');
  const before=(await q('select count(*)::int as n from transfer_maintenance.matches')).rows[0].n;
  await assert.rejects(rpc('transfer_apply_match',[['out30','out100'],['wrong']]),/item_already_matched/);
  assert.equal((await q('select count(*)::int as n from transfer_maintenance.matches')).rows[0].n,before);
  assert.equal((await rpc('transfer_preview_match',[['out100'],['wrong']])).reason,'worker_pair_mismatch');
});
await test('undo restores every item to unmatched and keeps audit',async()=>{
  const u=await rpc('transfer_undo_match',[match.match_id,'mistaken pairing']); assert.equal(u.status,'cancelled');
  const all=(await q('select * from transfer_get_unmatched()')).rows;
  for(const id of ['out30','out20','out50','in100']) assert.ok(all.some(x=>x.item_id===id));
  const history=await rpc('transfer_get_match',[match.match_id]); assert.equal(history[0].audit.length,2);
});
await test('1:N and N:N apply',async()=>{
  await add('PD Lv2','in30',30,'JJ'); await add('PD Lv2','in70',70,'JJ');
  let m=await rpc('transfer_apply_match',[['out100'],['in30','in70']]); assert.equal(m.incoming_count,2);
  await rpc('transfer_undo_match',[m.match_id,'test']);
  m=await rpc('transfer_apply_match',[['out30','out20','out50'],['in30','in70']]); assert.equal(m.outgoing_count,3); assert.equal(m.incoming_count,2);
  await rpc('transfer_undo_match',[m.match_id,'test']);
});
await test('unchanged legacy manual RPC uses final logic and undo auditing',async()=>{
  await rpc('append_special_record',['__TRANSFERS__',{id:'legacy-ui-test',kind:'match',itemIdA:'out100',itemIdB:'in100',amountA:-1,amountB:999}]);
  const m=(await rpc('transfer_get_match',['legacy-ui-test']))[0]; assert.equal(m.total_out,100); assert.equal(m.total_in,100); assert.equal(m.source,'manual_ui');
  await rpc('delete_match_record',['__TRANSFERS__','legacy-ui-test']);
  assert.equal((await rpc('transfer_get_match',['legacy-ui-test']))[0].status,'cancelled');
});
await test('save_day and archive preserve unmatched maintenance entries',async()=>{
  await rpc('save_day',['JJ',day,1000]);
  let all=(await q('select * from transfer_get_unmatched()')).rows; assert.ok(all.some(x=>x.item_id==='out100'));
  const d=(await q("select data from gold_ledger where worker='JJ'")).rows[0].data;
  for(const h of d.history) if(h.date===day) {h.exported=true;h.transactions=[];}
  await rpc('admin_upsert_row',['JJ',d]);
  all=(await q('select * from transfer_get_unmatched()')).rows; assert.ok(all.some(x=>x.item_id==='out100'&&x.archived));
});
await test('read-only candidate helper and summary',async()=>{
  const count=(await q('select count(*)::int as n from transfer_maintenance.matches')).rows[0].n;
  const c=await rpc('transfer_find_candidates',[day,day,'JJ','PD Lv2',0.05,2,200,'A',3,20]); assert.equal(c.search.pool_truncated,true);
  const s=await rpc('transfer_maintenance_summary',[day,day]); assert.ok(s.unmatched_total>=50); assert.ok(s.worker_pairs.length>0);
  assert.equal((await q('select count(*)::int as n from transfer_maintenance.matches')).rows[0].n,count);
});
await test('300 unmatched do not block Worker entry',async()=>{
  await q("select set_config('request.jwt.claim.sub',$1,false)",[WORKER]);
  for(let n=50;n<300;n++) await add('JJ',`cap${n}`,-1,'PD Lv2');
  await add('JJ','after300',-2,'老板');
  assert.ok((await q("select data from gold_ledger where worker='JJ'")).rows[0].data.drafts[day].some(x=>x.id==='after300'));
  await q("select set_config('request.jwt.claim.sub',$1,false)",[ADMIN]);
});
const isolatedDay='2026-01-15';
await test('Lane grouping and combination candidates ignore different descriptions',async()=>{
  await add('JJ','a-out',-76.60,'PD Lv2',isolatedDay);
  await add('PD Lv2','a-in1',35.85,'JJ',isolatedDay);
  await add('PD Lv2','a-in2',40.75,'JJ',isolatedDay);
  await add('PD Lv2','b-out1',-58.12,'PD Lv1',isolatedDay);
  await add('PD Lv2','b-out2',-23.43,'PD Lv1',isolatedDay);
  await add('PD Lv1','b-in',81.54,'PD Lv2',isolatedDay);
  await add('PD Lv2','b-exact-out',-12.34,'PD Lv1',isolatedDay);
  await add('PD Lv1','b-exact-in',12.34,'PD Lv2',isolatedDay);
  const lanes=await rpc('transfer_get_unmatched_by_lane',[isolatedDay,isolatedDay]);
  assert.ok(lanes.A.every(x=>x.lane==='A')); assert.ok(lanes.B.every(x=>x.lane==='B'));
  const c=await rpc('transfer_find_candidates',[isolatedDay,isolatedDay]);
  const a=c.candidates.find(x=>x.outgoing_ids.includes('a-out')&&x.incoming_ids.length===2);
  assert.ok(a); assert.equal(a.total_out,76.6); assert.equal(a.total_in,76.6); assert.equal(a.confidence,'MEDIUM');
  const b=c.candidates.find(x=>x.incoming_ids.includes('b-in')&&x.outgoing_ids.length===2);
  assert.ok(b); assert.ok(Math.abs(b.difference+0.01)<1e-8);
  assert.equal(c.candidates.find(x=>x.outgoing_ids.includes('b-exact-out')).confidence,'HIGH');
  for(const x of c.candidates) for(const key of ['candidate_id','lane','outgoing_items','incoming_items','date_span','reason']) assert.ok(key in x);
  await add('PD Lv1','b-alternate',12.34,'PD Lv2',isolatedDay);
  const ambiguous=await rpc('transfer_find_candidates',[isolatedDay,isolatedDay]);
  assert.ok(ambiguous.candidates.filter(x=>x.outgoing_ids.includes('b-exact-out')).every(x=>x.confidence==='AMBIGUOUS'));
});
await test('1:3 and 3:1 candidate search, then batch reports independent failures',async()=>{
  const date='2026-01-16';
  await add('JJ','triple-out',-100.13,'PD Lv2',date);
  for(const [id,weight] of [['triple-in1',20.01],['triple-in2',30.02],['triple-in3',50.1]]) await add('PD Lv2',id,weight,'JJ',date);
  await add('PD Lv2','triple-in',210.17,'JJ',date);
  for(const [id,weight] of [['triple-out1',60.01],['triple-out2',70.02],['triple-out3',80.14]]) await add('JJ',id,-weight,'PD Lv2',date);
  const c=await rpc('transfer_find_candidates',[date,date]);
  assert.ok(c.candidates.some(x=>x.outgoing_ids.length===1&&x.incoming_ids.length===3));
  assert.ok(c.candidates.some(x=>x.outgoing_ids.length===3&&x.incoming_ids.length===1));
  const groups=[{outgoing_ids:['triple-out'],incoming_ids:['triple-in1','triple-in2','triple-in3']},
    {outgoing_ids:['triple-out'],incoming_ids:['triple-in']},
    {outgoing_ids:['triple-out1','triple-out2','triple-out3'],incoming_ids:['triple-in']},{}];
  const b=await rpc('transfer_apply_matches_batch',[groups,'weekly review']);
  assert.equal(b.succeeded,2);assert.equal(b.failed,2);
  assert.equal(b.results[1].reason,'item_already_matched');assert.equal(b.results[3].reason,'invalid_group_format');
  for(const r of b.results.filter(x=>x.success)) await rpc('transfer_undo_match',[r.result.match_id,'test cleanup']);
});
await test('Worker and unauthenticated maintenance calls are rejected',async()=>{
  for (const id of [WORKER,'']) {
    await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);
    for(const [name,args] of [['transfer_get_unmatched',[]],['transfer_maintenance_summary',[]],['transfer_preview_match',[['out100'],['in100']]],
      ['transfer_apply_match',[['out100'],['in100']]],['transfer_undo_match',[match.match_id,'no']],['transfer_find_candidates',[]],['transfer_get_match',[]],
      ['transfer_apply_matches_batch',[[{outgoing_ids:['out100'],incoming_ids:['in100']}]]],['transfer_get_unmatched_by_lane',[]],
      ['transfer_create_issue',['OTHER',['out100'],['in100'],'no']],['transfer_set_issue_settings',[1]],['transfer_scan_receive_exceptions',[]]])
      await assert.rejects(rpc(name,args),/admin_required/);
  }
  await q("select set_config('request.jwt.claim.sub',$1,false)",[ADMIN]);
});
await test('private tables and internal routines unavailable to authenticated role',async()=>{
  await db.exec('set role authenticated');
  await assert.rejects(q('select * from transfer_maintenance.items'),/permission denied/);
  await db.exec('reset role');
});
let issueId;
await test('large weight differences require investigation and cannot apply',async()=>{
  const d='2026-01-17';
  await add('JJ','issue-out',-81.55,'PD Lv2',d); await add('PD Lv2','issue-in',81.20,'JJ',d);
  const candidates=await rpc('transfer_find_candidates',[d,d]);
  const c=candidates.candidates.find(x=>x.outgoing_ids.includes('issue-out'));
  assert.equal(c.action,'REQUIRES_INVESTIGATION');assert.equal(c.reason,'WEIGHT_MISMATCH');
  const p=await rpc('transfer_preview_match',[['issue-out'],['issue-in']]);assert.equal(p.valid,false);assert.equal(p.reason,'weight_mismatch_requires_investigation');
  await assert.rejects(rpc('transfer_apply_match',[['issue-out'],['issue-in']]),/weight_mismatch_requires_investigation/);
  const issue=await rpc('transfer_create_issue',['WEIGHT_MISMATCH',['issue-out'],['issue-in'],'Investigate discrepancy']);
  issueId=issue.id;assert.equal(issue.is_red,true);assert.equal(issue.events.length,1);
  await assert.rejects(rpc('transfer_create_issue',['OTHER',['issue-out'],[],'duplicate']),/item_has_open_issue/);
});
await test('only assigned employees see and comment, and cannot resolve',async()=>{
  const OTHER='00000000-0000-0000-0000-000000000003';
  await q('insert into profiles(id,role) values($1,$2)',[OTHER,'user']);
  await rpc('transfer_set_employee_workers',[WORKER,['PD Lv2']]);
  await q("select set_config('request.jwt.claim.sub',$1,false)",[OTHER]);
  assert.deepEqual(await rpc('transfer_get_open_issues'),[]);
  await assert.rejects(rpc('transfer_add_issue_comment',[issueId,'not mine']),/issue_access_denied/);
  await q("select set_config('request.jwt.claim.sub',$1,false)",[WORKER]);
  assert.ok((await rpc('transfer_get_open_issues')).some(x=>x.id===issueId));
  let i=await rpc('transfer_add_issue_comment',[issueId,'Reweighed; previously mistyped.']);assert.equal(i.status,'STAFF_REPLIED');assert.equal(i.is_red,true);
  i=await rpc('transfer_mark_issue_reviewed',[issueId,'Checked; ready for admin review.']);assert.equal(i.status,'READY_FOR_REVIEW');assert.equal(i.is_red,true);
  await assert.rejects(rpc('transfer_resolve_issue',[issueId,'RESOLVE_NO_MATCH','no']),/admin_required/);
  await assert.rejects(rpc('transfer_reopen_issue',[issueId,'no']),/admin_required/);
  await q("select set_config('request.jwt.claim.sub',$1,false)",[ADMIN]);
});
await test('item correction keeps red, records before/after and atomic resolve+match',async()=>{
  await rpc('remove_draft_item',['PD Lv2','2026-01-17','issue-in']);
  await add('PD Lv2','issue-in',81.53,'JJ','2026-01-17');
  let i=await rpc('transfer_get_issue',[issueId]);assert.equal(i.is_red,true);
  assert.equal(i.total_in,81.2);assert.equal(i.current_items.find(x=>x.item_id==='issue-in').amount,81.53);
  assert.ok(i.events.some(x=>x.event_type==='item_updated'&&x.metadata.before&&x.metadata.after));
  await assert.rejects(rpc('transfer_apply_match',[['issue-out'],['issue-in']]),/item_has_open_issue/);
  await assert.rejects(rpc('transfer_resolve_issue',[issueId,'CORRECTED_AND_MATCHED','bad IDs',['issue-out'],['wrong']]),/worker_pair_mismatch/);
  assert.equal((await rpc('transfer_get_issue',[issueId])).status,'READY_FOR_REVIEW');
  i=await rpc('transfer_resolve_issue',[issueId,'CORRECTED_AND_MATCHED','Staff confirmed corrected receipt']);
  assert.equal(i.is_red,false);assert.ok(i.match_id);assert.ok(i.events.some(x=>x.event_type==='match_created'));
  assert.ok(i.events.some(x=>x.event_type==='staff_comment'));
  const reopened=await rpc('transfer_reopen_issue',[issueId,'New evidence']);assert.equal(reopened.is_red,true);
  assert.ok(reopened.events.some(x=>x.event_type==='issue_reopened'));assert.equal(reopened.match_id,i.match_id);
  await rpc('transfer_resolve_issue',[issueId,'OTHER','Reviewed existing match; explanation accepted']);
});
await test('receive deadline configurable, late receipt never clears red',async()=>{
  await rpc('transfer_set_issue_settings',[24,2]);
  await add('PD Lv1','late-out',-333.33,'PD Lv2','2026-01-20');
  await q("update transfer_maintenance.items set created_at=now()-interval '25 hours' where item_id='late-out'");
  let scan=await rpc('transfer_scan_receive_exceptions',[false,'B']);assert.ok(scan.items.some(x=>x.item_id==='late-out'&&x.severity==='RED'));
  scan=await rpc('transfer_scan_receive_exceptions',[true,'B']);const i=scan.items.find(x=>x.item_id==='late-out').issue;
  assert.ok(i&&i.issue_type==='SENT_NOT_RECEIVED');
  await add('PD Lv2','late-in',333.33,'PD Lv1','2026-01-21');
  const ready=await rpc('transfer_get_issue',[i.id]);assert.equal(ready.status,'READY_FOR_REVIEW');assert.equal(ready.is_red,true);assert.equal(ready.possible_resolution_found,true);
  const resolved=await rpc('transfer_resolve_issue',[i.id,'MATCH_AND_RESOLVE','Confirmed late entry',['late-out'],['late-in']]);
  assert.equal(resolved.is_red,false);assert.ok(resolved.events.some(x=>x.event_type==='possible_resolution_found'));
  await add('PD Lv1','fresh-out',-444.44,'PD Lv2','2026-01-25');
  scan=await rpc('transfer_scan_receive_exceptions',[false,'B']);assert.ok(scan.items.some(x=>x.item_id==='fresh-out'&&x.severity==='YELLOW'&&x.issue===null));
});
await test('lanes C/D (JJ with Lv1倒模/Lv1车花) and next-day B matching',async()=>{
  const sh=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
  await q("select set_config('request.jwt.claim.sub',$1,false)",[ADMIN]);
  const base=sh(day,-40); // isolated date window, other tests' items are not in range
  const sc=[['PD Lv2',0,'PD Lv1',0,'B','HIGH'],['PD Lv2',-1,'PD Lv1',0,'B','HIGH'],['PD Lv1',-1,'PD Lv2',0,'B','HIGH'],
    ['PD Lv2',-2,'PD Lv1',0,'B','MEDIUM'],['PD Lv2',-3,'PD Lv1',0,'B',null],['JJ',-1,'PD Lv2',0,'A','MEDIUM'],
    ['JJ',0,'Lv1倒模',0,'C','MEDIUM'],['Lv1倒模',-1,'JJ',0,'C','MEDIUM'],['JJ',0,'Lv1车花',0,'D','MEDIUM'],['Lv1车花',-1,'JJ',0,'D','MEDIUM']];
  const W=[41.37,63.91,88.07,117.43,152.29,29.53,71.19,97.61,133.07,166.83];
  for(let k=0;k<sc.length;k++){const [ow,od,iw,id_]=sc[k];
    await add(ow,`L${k}o`,-W[k],iw,sh(base,od)); await add(iw,`L${k}i`,W[k],ow,sh(base,id_));}
  const lanes=Object.fromEntries((await q("select item_id,lane from transfer_get_unmatched($1::date-10,$1::date,null,null,'all') where item_id like 'L%'",[base])).rows.map(r=>[r.item_id,r.lane]));
  const r=await rpc('transfer_find_candidates',[sh(base,-10),base,null,null,0.05,2,200,'all']);
  const found=new Map(r.candidates.map(c=>[c.outgoing_ids[0],c]));
  sc.forEach(([,, , ,lane,conf],k)=>{
    assert.equal(lanes[`L${k}o`],lane,`lane ${k}`);
    const c=found.get(`L${k}o`);
    if(conf===null) assert.equal(c,undefined,`case ${k} should not match`); else {assert.ok(c,`case ${k} found`);assert.equal(c.confidence,conf,`conf ${k}`);}
  });
  const prim=(await q("select distinct lane from transfer_get_unmatched($1::date-10,$1::date,null,null,'primary') where item_id like 'L%'",[base])).rows.map(x=>x.lane).sort();
  assert.deepEqual(prim,['A','B','C','D']);
  const bl=await rpc('transfer_get_unmatched_by_lane',[sh(base,-10),base]);
  assert.ok(bl.C&&bl.D);
  await assert.rejects(()=>rpc('transfer_find_candidates',[sh(base,-10),base,null,null,0.05,3,200,'all']),/invalid_candidate_parameters/);
});
await test('lane migration rollback restores original lanes',async()=>{
  await db.exec(fs.readFileSync(path.join(root,'supabase/rollback/20261007_transfer_lanes.sql'),'utf8'));
  const n=(await q("select count(*)::int n from transfer_get_unmatched(current_date-60,current_date,null,null,'all') where item_id like 'L%' and lane='other'")).rows[0].n;
  assert.ok(n>0);
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261007_transfer_lanes.sql'),'utf8'));
});
await test('rollback preserves all audit and ledger data',async()=>{
  const ledger=(await q('select worker,data,updated_at from gold_ledger order by worker')).rows;
  const counts=(await q('select (select count(*) from transfer_maintenance.audit)::int as matches,(select count(*) from transfer_maintenance.transfer_issue_events)::int as issues')).rows[0];
  await db.exec(fs.readFileSync(path.join(root,'supabase/rollback/20261005_transfer_maintenance.sql'),'utf8'));
  assert.deepEqual((await q('select worker,data,updated_at from gold_ledger order by worker')).rows,ledger);
  assert.deepEqual((await q('select (select count(*) from transfer_maintenance_archive_20261005.audit)::int as matches,(select count(*) from transfer_maintenance_archive_20261005.transfer_issue_events)::int as issues')).rows[0],counts);
});
await db.close();
console.log(JSON.stringify({passed:checks.length,checks},null,2));
