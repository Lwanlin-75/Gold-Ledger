# 金重对账

## 当前数据库维护

不要执行旧的 supabase_setup.sql。生产数据库使用 Auth、profiles、RPC 与私有维护表，现有项目升级请阅读 [TRANSFER_MAINTENANCE.md](TRANSFER_MAINTENANCE.md) 和 [LEDGER_SAFETY.md](LEDGER_SAFETY.md)，按 supabase/migrations 顺序执行。迁移不是空数据库初始化器。

真正的应用入口是 src/App.jsx；根目录 App.jsx 已弃用。普通员工录入范围由数据库校验，配对由管理员 / AI 每周处理。

## 第二步：部署到 Vercel

### 路线A：有 GitHub 账号

1. 在 GitHub 上新建一个仓库（空的就行）
2. 把这个文件夹里的所有文件上传上去（网页上可以直接拖文件上传，或者用 `git push`）
   - 注意：`.env` 文件不会被上传（已经在 .gitignore 里排除了），这是故意的，密钥不应该进代码仓库
3. 去 Vercel，点 **Add New -> Project**，选你刚建的仓库，点 Import
4. 在 "Environment Variables" 那一步，加两个变量：
   - `VITE_SUPABASE_URL` = 你的 Supabase Project URL
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = 你的 Supabase Publishable key
5. 点 Deploy，等一两分钟，就会给你一个固定网址

### 路线B：没有 GitHub，用命令行

需要电脑上装好 Node.js（https://nodejs.org 下载 LTS 版本安装）。

在这个项目文件夹里，打开终端，依次执行：

```
npm install
npm install -g vercel
vercel login
vercel --prod
```

第一次跑 `vercel --prod` 时它会问几个问题（项目名字之类的，直接回车用默认值就行），然后会提示你去网页上把两个环境变量加上（跟路线A第4步一样），加完再跑一次 `vercel --prod` 就会正式上线，给你一个网址。

## 本地先试试看（可选）

如果你想先在自己电脑上跑起来看看效果，再决定要不要上线：

```
npm install
npm run dev
```

会给你一个本地网址（通常是 http://localhost:5173），打开就能用，这时候数据已经是真的存进 Supabase 数据库了。

