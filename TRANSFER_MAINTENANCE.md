# 转手维护与异常调查

## 部署顺序

适用于 2026-10-05 检查过的生产结构：`public.gold_ledger(worker text primary key, data jsonb, updated_at timestamptz)`，`profiles(id uuid,email,role)`，现有 `auth.uid()` / `is_admin()`。**不要执行旧 `supabase_setup.sql`**。

1. 备份当前 `gold_ledger`、函数定义、权限和部署版本。备份只放在公司受控位置，不提交真实流水到 GitHub。
2. 依次执行 `supabase/migrations/20261005_transfer_maintenance.sql`、`20261005_transfer_issues.sql`。两份脚本各自事务化，锁等待最多 10 秒；失败则整份回滚。不是重复执行脚本，已安装时不要再次运行。
3. 使用管理员账号绑定员工：`transfer_set_employee_workers(employee UUID, ARRAY['JJ'])`。登录邮箱从 `profiles` 查 UUID，不能根据邮箱字符串猜身份；一个账号可授权多个 Worker。
4. 部署新 `src/App.jsx` 和 `src/TransferIssues.jsx`。普通录入、维修和历史补录不再有未配对数量上限。
5. 检查摘要、Lane 原始流水、候选、管理员/普通员工权限。**部署不会创建 Issue、自动配对或修改旧配对**。第一次扫描先用 `p_create_issues=false`，管理员检查后再明确创建。

后台表放在未暴露的 `transfer_maintenance` schema，开启 RLS，无客户端表读写权限。只有受控 `SECURITY DEFINER` RPC 提供能力，固定 search_path。维护/设置/配对/撤销/Resolve/Reopen 都在数据库验证 Admin；员工公告及留言根据 `auth.uid()` 和授权 Worker 判断，前端切换 Worker 无法扩大访问。

## 保存与兼容

保留原始 `gold_ledger` JSON 格式与旧配对 ID，迁移不改写历史内容或 updated_at。`items` 投影同时涵盖 drafts/history；归档清空明细时保留维护快照。旧数据没有可信创建时间，返回 `created_at=null`，不伪造时间；新转手保存真实 first-seen 创建时间。

既有旧格式 `itemIdA/itemIdB` 和新格式 `outgoing/incoming` 都导入。历史上一个 item 被多个 Match 引用时，相关组标记 `legacy_conflict`，旧 JSON 保留，所有引用仍占用该 item。管理员必须逐组审查和撤销，最后一个引用撤销后才释放；不自动纠错。历史上混合多组 Worker 的旧 Match 也保留，但新 Match 必须只有一个互相对应的 Worker Pair。

所有最终配对入口（新单组、批量、旧 `append_special_record` 的转手分支）调用同一个事务函数：锁转手历史行、按顺序锁 Worker 行和 item、重新 Preview、写 Match/成员/Audit/UI JSON。有效成员上有数据库唯一索引。重复提交返回 `item_already_matched`；失败不会残留半组。由于共用历史 JSON，Apply 会串行执行。普通流水不会因为 unmatched 数量受限。

通用 JSON 更新不能绕过配对/撤销。已配对项目修改重量、日期、去向或删除时必须先 Undo。Issue 与 Match 是独立状态；Open Issue 的项目禁止直接 Apply，必须使用原子 Resolve+Match。归档不清除 Issue 或 Audit。

重量按 PostgreSQL numeric 计算，`difference=total_in-total_out`，延续既有 UI 约定。正常候选默认 ≤0.05g；0.05–0.20g 需要管理员人工确认后可 Preview/Apply；**超过 0.20g 始终拒绝配对，进入调查，不能通过调大候选 threshold 绕过**。

## 每周维护

管理员 Supabase 客户端例子（使用现有登录 Session，绝不能给员工 service_role key）：

```js
// 业务日期按 Asia/Kuala_Lumpur；例：2026-09-29 至 2026-10-05。
const window = {p_start_date: '2026-09-29', p_end_date: '2026-10-05'};
const raw = await supabase.rpc('transfer_get_unmatched_by_lane', window);
// raw.data.A = JJ ↔ PD Lv2；B = PD Lv2 ↔ PD Lv1；other 单独保留。
const suggestions = await supabase.rpc('transfer_find_candidates', {
  ...window, p_lane: 'A', p_max_difference: 0.05,
});
// 审查 candidates + 原始流水。边界日期需要把查询扩大 ±2 天，避免漏掉跨周接收。
const chosen = [{outgoing_ids: ['OUT_ID'], incoming_ids: ['IN1_ID','IN2_ID'], note:'管理员已确认'}];
for (const group of chosen) {
  const preview = await supabase.rpc('transfer_preview_match', {
    p_outgoing_ids: group.outgoing_ids, p_incoming_ids: group.incoming_ids,
  });
  if (preview.error || !preview.data.valid) throw new Error(preview.error?.message || preview.data.reason);
}
// 仅提交管理员确认过的组，不要把全部候选直接交给 Apply。
const results = await supabase.rpc('transfer_apply_matches_batch', {p_groups: chosen});
// 检查每组 success / reason / sqlstate；批量不是整批原子事务。
const open = await supabase.rpc('transfer_get_open_issues', {p_status:'STAFF_REPLIED'});
const overdue = await supabase.rpc('transfer_scan_receive_exceptions', {p_create_issues:false});
```

Lane B 优先同一天、正负互反、近似重量；无重叠的同日 1:1 为 HIGH。上楼/下楼仅辅助评分。Lane A 即使准确也保守返回 MEDIUM。任何 item 存在多种组合，返回 AMBIGUOUS。**description 不作为排除条件**。

候选原生搜索 1:1、1:2、2:1、1:3、3:1。Preview/Apply 支持任意有限 1:N/N:1/N:N。候选暂不枚举 N:N，避免组合爆炸。每个有向 Worker Pair 每侧默认只搜索最近 20 个 item，最大 30，每侧最大 3 个，日期跨度最大 2 天。可缩小日期范围或分方向查询覆盖更多数据；不能把有限搜索结果视为完整答案。

`transfer_find_candidates` 返回 `{candidates,search,investigation_search,investigation_difference}`。两个 search 对象明确显示 eligible/searched 数量、pool_truncated、result_truncated、total_candidates。被截断的组不标 HIGH。每组包含 candidate_id/lane/outgoing_ids/incoming_ids/outgoing_items/incoming_items/total_out/total_in/difference/date_span/confidence/reason/action。action 分 MATCHABLE、REQUIRES_INVESTIGATION、AMBIGUOUS。宽阈值调查搜索默认 ≤2g，可配置；不是推断所有异常的保证，严重错重/错方向/漏记可人工建 Issue。

## 异常与员工跟进

`transfer_issues` 保存初始双方快照、初始重量/差异、assigned_workers、状态、最终处理及关联 Match；`transfer_issue_events` 是追加历史，没有删除/覆盖接口。记录 issue_created、staff_comment、item_updated（before/after）、staff_marked_checked、admin_review、match_created、issue_resolved、issue_reopened 和 possible_resolution_found。

默认：WAITING_STAFF + RED。普通员工只可留言/提交已检查，分别转 STAFF_REPLIED / READY_FOR_REVIEW；两者仍红色。原始 item 修改自动记 before/after 并标待复核，关闭后发生的后续修改也留事件。新增可能接收项只标 possible_resolution_found，绝不自动关闭、配对或确认候选。

员工公告只发给 Issue 相关且已绑定的 Worker 登录账号。小区块显示红色异常和黄色待收，展开可查看说明、原始重量、当前流水及历史留言。留言记录 employee UUID、授权 Worker、创建时间和相关 item ID。其他账号不能读 Issue详情、冒名留言、Resolve/Reopen、删事件或改结论。绑定及等待期限变更另存 `configuration_events`。

SENT_NOT_RECEIVED 由**明确调用的维护扫描**识别，未设置 Cron/写入即扫描。默认 `transfer_receive_wait_hours=48`；新记录按 created_at，旧记录按业务日结束（保守，不假设当时录入小时）。没有任何同 Worker Pair、±2 天的未配对正数接收记录才建议迟收；存在接收项时交给组合/重量候选检查，避免把分批收货误报为缺失。扫描默认只预览，`p_create_issues=true` 才创建。前端黄色提示不创建 Issue，也不把普通 unmatched 全部标红。迟收 Issue 建立后，即使后来收到仍必须管理员审查。

Admin 可 KEEP OPEN（`transfer_review_issue`）、Resolve 无 Match、原子 Resolve+Match，或 Reopen。Resolve+Match 使用最新 item，失败整次回滚，Issue 仍红。Reopen 保存上一处理结论到事件，不自动撤销既有 Match；若错误配对，另用有审计的 Undo。已关闭的 Issue 可由相关员工/管理员通过 ID 查询历史。

```js
await supabase.rpc('transfer_create_issue', {
  p_issue_type:'WEIGHT_MISMATCH', p_outgoing_ids:['OUT_ID'], p_incoming_ids:['IN_ID'],
  p_reason:'同一批次疑似错重，请重新检查',
});
await supabase.rpc('transfer_resolve_issue', {
  p_issue_id:'ISSUE_UUID', p_resolution_type:'CORRECTED_AND_MATCHED',
  p_resolution_note:'复核员工说明和最新流水，确认同批',
  p_outgoing_ids:['OUT_ID'], p_incoming_ids:['IN_ID'],
});
```

## RPC 清单

所有参数均带 `p_` 前缀，以下省略前缀以便阅读。只有标“员工”接口允许普通员工。

| RPC | 参数与默认值 | 返回 |
|---|---|---|
| transfer_get_unmatched | start_date/end_date/worker/counterparty=null, lane='primary'（A/B/other/all） | 原始行：item_id,date,created_at,worker,counterparty,direction,amount,absolute_amount,description,matched,match_id,archived,lane |
| transfer_get_unmatched_by_lane | start_date/end_date=null | A/B/other 数组 |
| transfer_maintenance_summary | start_date/end_date=null | 数量、送出/收到、最老日期、>7天、Worker Pair、Lane、历史冲突数 |
| transfer_preview_match | outgoing_ids text[], incoming_ids text[], max_date_span=7（0..365） | valid,reason,精确重量、日期跨度、方向、action |
| transfer_apply_match | 同 Preview + note=null, source='maintenance' | match_id、重量等；source允许 manual_ui/maintenance/auto（仅元数据，不代表自动执行） |
| transfer_apply_matches_batch | groups jsonb（1..100）, note=null,max_date_span=7 | 逐组 results + succeeded/failed；数组为空/结构错误明确拒绝 |
| transfer_undo_match | match_id,reason（必填） | 释放 item_ids、仍被旧冲突占用的 ID；保留取消记录和审计 |
| transfer_get_match | match_id/status=null | 含 audit 的历史组 |
| transfer_find_candidates | start/end/worker/counterparty=null,max_difference=.05,max_date_span=2,limit=200,lane='primary',max_group_items=3,pool_limit=20 | 候选和两套搜索完整性信息；Worker 参数指**转出方 → 接收方**，与原始查询的记录所属 Worker 过滤不同 |
| transfer_create_issue | issue_type,outgoing_ids,incoming_ids,reason,severity='RED' | Issue+当前/原始流水+events；错方向调查也可建，不要求正常 Preview 通过 |
| transfer_get_open_issues（员工） | start/end/lane/issue_type/status/worker=null | 有权限的 Open Issue 完整数组；日期筛选为 Issue创建日期 |
| transfer_get_issue（员工） | issue_id uuid | 含已关闭历史的完整 Issue |
| transfer_get_worker_transfer_notices（员工） | worker | 权限过滤的 issues+waiting |
| transfer_add_issue_comment（员工） | issue_id,comment,item_ids=null | 追加留言；related IDs只能属于该Issue |
| transfer_mark_issue_reviewed（员工） | issue_id,comment（必填） | 追加留言及已检查事件，仍红 |
| transfer_review_issue | issue_id,note,status='WAITING_STAFF' | Admin Keep Open，追加复核事件 |
| transfer_resolve_issue | issue_id,resolution_type,resolution_note,outgoing_ids/incoming_ids=null,max_date_span=7 | 完整 Issue；Match使用当前记录，初始快照不变 |
| transfer_reopen_issue | issue_id,reason | 追加重开，保留原结论，仍保留 Match |
| transfer_scan_receive_exceptions | create_issues=false,lane='primary' | 等待期限、黄/红建议、创建结果；不自动配对 |
| transfer_get_issue_settings | 无 | 等待小时及调查搜索阈值 |
| transfer_set_issue_settings | transfer_receive_wait_hours（1..720）,investigation_difference=2（.21..20） | 设置；记录变更审计 |
| transfer_set_employee_workers | employee_id uuid,workers text[]（空数组撤销） | 授权 Worker；记录变更审计 |

Resolve类型：MATCH_AND_RESOLVE、CORRECTED_AND_MATCHED、RESOLVE_NO_MATCH、KEEP_SEPARATE、OTHER。Issue类型：WEIGHT_MISMATCH、SENT_NOT_RECEIVED、POSSIBLE_WRONG_WEIGHT、POSSIBLE_WRONG_DIRECTION、POSSIBLE_MISSING_ENTRY、POSSIBLE_DUPLICATE_ENTRY、OTHER。

## 回滚

先把前端回到旧版本，再执行 `supabase/rollback/20261005_transfer_maintenance.sql`。它恢复两份旧 RPC 定义、移除新公开 RPC/同步触发器，**将私有 schema 改名为 `transfer_maintenance_archive_20261005`，不删账目、Match、Issue、员工留言或 Audit**。保留迁移后产生的有效账目与旧 UI 兼容 JSON。旧版本不具备后台防重复和 Issue 校验；重新上线须规划归档审计的续接，不可盲目重跑。只回退前端时可保留新后台，旧配对入口仍安全调用最终函数。

## 验证

`npm install && npm test` 使用隔离的 PGlite PostgreSQL 引擎和检查过的生产函数结构；默认只有合成测试数据。管理员可在本地设置 `TRANSFER_PRODUCTION_FIXTURE` 指向受控数据副本，额外验证迁移不改旧数据及历史重复隔离。测试数据不得入仓库。测试覆盖 6/50/300 未配对不阻塞、日期/Pair/符号校验、组合候选、Preview无写入、重复拒绝、逐组回滚、Undo/Audit、权限、异常强制调查、员工授权、修改历史、Resolve原子性、迟收等待和保留历史回滚。

PGlite 单连接测试不能冒充真实双连接并发测试；真实并发须在隔离 PostgreSQL/Supabase 复刻环境使用两个连接同时对同 item Apply，检查只一组成功、另一组 `item_already_matched` 或唯一冲突，且无半写入。生产无需为测试建立或撤销真实业务 Match。
