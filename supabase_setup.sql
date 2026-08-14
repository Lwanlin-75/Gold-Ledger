-- 在 Supabase 项目里，左边栏点 "SQL Editor" -> "New query"，
-- 把下面全部内容贴进去，点 Run 执行一次即可。

create table if not exists gold_ledger (
  worker text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table gold_ledger enable row level security;

-- 这个工具用的是"公开可读写"的 publishable key，
-- 所以这里给所有人开读写权限。这适合内部小团队工具
-- （网址不公开分享的前提下），不适合面向公众的产品。
create policy "public read" on gold_ledger
  for select using (true);

create policy "public insert" on gold_ledger
  for insert with check (true);

create policy "public update" on gold_ledger
  for update using (true);
