# 账目安全补充与员工范围

本次基于已经上线的转手维护系统追加，未重新实现候选、配对或异常流程。

## 员工范围

- `jj@jjstore.local`：只能录入、删除暂存和修改 JJ、倒模 最近三天记录。
- `pdlv2@jjstore.local`：只能录入、删除暂存和修改 PD Lv1 / PD Lv2 / Lv1倒模 / Lv1车花 最近三天记录。
- 范围由 `supabase/ops/20261007_employee_scope.sql` 绑定（可重复运行）。
- Admin 保留全部部门权限。其他普通账号未分配范围时不能写入。
- 范围存放于私有 `employee_workers` 表，由 `transfer_set_employee_workers` 管理；前端通过 `ledger_get_worker_scope` 获取。邮箱不作为客户端权限依据。
- 总览保持现有只读展示；部门切换与出货来源仅显示有录入权限的部门。
- Worker 不提供配对入口。转手核对由管理员 / AI 每周处理，所有未解决红色公告在该页面顶部展开；Worker 页面仍有相关部门的小型公告区。

## 本次采纳的建议

| 建议 | 实现 |
| --- | --- |
| 读取失败不能从空白继续录入 | 首次失败仅显示重试；后台刷新/写入结果不确定时禁止写，保留现有显示，完整重读成功才恢复 |
| 同步未完成就结算的竞态 | Ref 同步门锁与按钮状态共同保护；服务器写入及完整刷新完成之前不能发起第二笔操作或结算 |
| 马来西亚时区 | 默认日期、日期窗口、权限边界统一 Asia/Kuala_Lumpur；ISO 时间戳仍保留真实时间 |
| 出货半成功 | `shipment_create_with_flow` 在一次事务中计算出货重量、建立出货和关联负流水；删除支持已进入 history 的关联流水并重算，已归档流水要求复核 |
| 归档部分成功/证据丢失 | `ledger_archive_batch` 全批锁定并对照导出时快照；任一记录变动整批回滚；未配对、未关闭 Issue 和关联出货的整天流水保留并明确返回原因 |
| 整包 JSON 覆盖竞态 | 页面阈值和盒重使用数据库原子字段更新；撤销一天使用快照检查的 `ledger_undo_last_day`，原始流水回到 drafts；归档使用批量 RPC |
| 重要修改留档 | 私有 `ledger_events` 在同一事务保存修改前后 JSON、操作、操作者和时间；失败不会留半笔审计 |
| ID 碰撞 | 新前端记录使用 UUID；draft 和 shipment 重试使用同一 ID 幂等，冲突拒绝 |
| 旧 setup / 旧 App 容易误用 | 旧 setup 改成明确拒绝执行的弃用文件；根 App 标记弃用；真实入口为 src/App.jsx |

已完成的转手 numeric 运算、事务、候选分 Lane、配对 / Undo / Issue 审计及测试继续沿用。全面迁移旧账 JSON、全前端重量改用整数、SheetJS 依赖升级与大规模性能重构本次不做，避免改动已经验证的业务计算。现有发布由 Vercel 构建检查；没有声称本地受限环境已跑通完整 Vite build。

## 新 RPC

- `ledger_get_worker_scope()` → 当前登录者的 Worker 名称数组。
- `shipment_create_with_flow(p_record jsonb,p_flow_description text)` → 创建记录，后台重算 sentTotal；不允许跨部门、未来日期或普通账号超过三天补录。
- `shipment_delete_with_flow(p_record_id text,p_reason text)` → Admin 原子撤销出货和对应流水；前后快照保留于 ledger_events。
- `ledger_undo_last_day(p_worker text,p_expected_record jsonb,p_reason text)` → Admin 比对完整末日快照，将该日流水返还 drafts。
- `ledger_archive_batch(p_records jsonb)`：输入 `[{worker,date,record}]`，record 必须是下载 Excel 时的完整日记录快照；返回 archived_days、retained 数组。
- `ledger_get_audit(p_worker text default null,p_before_id bigint default null,p_limit integer default 50)` → Admin 分页审计，最大 100 条。

转手红色状态只能通过管理员 `transfer_resolve_issue` 解除，AI 每周先读最新原始记录、员工留言、Preview，再决定配对或创建 Issue。记录异常不是员工违规认定，公告使用中性措辞。不做数据库 Cron，也不在写入后自动配对。

## 部署与回退

1. 安装已完成的两份 20261005 迁移。
2. 备份当前账目与函数，执行 `20261006_ledger_safety.sql`，原始账目不变。
3. 由现有 Admin 使用 transfer_set_employee_workers 绑定上面的范围；不修改 profiles 的 admin/user 角色。
4. 通过 Vercel 构建检查后发布前端，分别核实 JJ 单部门、PD 双部门和读取失败重试。
5. 新增 ledger-safety.mjs 独立合成数据测试：权限、日期、幂等、出货事务、历史删除重算、归档回滚、私有表和回退；原有 21 项转手测试保留。`npm test` 执行两套。

紧急回退必须先部署上一版前端，再运行 `supabase/rollback/20261006_ledger_safety.sql`。该回退会恢复旧 RPC 的较宽权限，仅在管理员明确要求回退时执行；账目、员工绑定和审计记录保留。若还要回退转手迁移，必须先执行这一回退，旧回退脚本有顺序保护。
