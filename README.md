# 🎯 duanlian.shenzjd.com - 短链系统

一个基于 Git 和 Serverless 的极简短链接系统，灵感来自 [miantiao.me/posts/hink/](https://miantiao.me/posts/hink/)。

在他的基础上加入了 github action 自动更新 README.md 中的短链表格。

## ✨ 核心原理

利用 Git 提交哈希值作为短链接的唯一标识符，将原始长链接存储在提交信息中：

1. **生成短链**：创建空提交，消息为目标 URL
2. **访问短链**：通过 GitHub 的 `.patch` 文件接口读取提交信息
3. **重定向**：提取长链接并进行 302 重定向

## 🚀 快速开始

### 生成短链

```bash
# 创建空提交，消息为目标 URL
git commit --allow-empty -m "https://shenzjd.com"

# 推送到 GitHub
git push origin main
```

**短链规则**：使用 commit hash 的前 6 位作为短码，例如 `4975af`。

## 🔗 短链列表

<!-- SHORT_LINKS_START -->
| 完整短链 | 目标链接 | 创建时间 |
|----------|----------|----------|
| https://duanlian.shenzjd.com/4975af | https://github.com/wu529778790/duanlian.shenzjd.com | 2025-12-25 |
| https://duanlian.shenzjd.com/d5becb | https://shenzjd.com | 2025-12-25 |
| https://duanlian.shenzjd.com/980fdc | https://blog.shenzjd.com | 2025-12-25 |
| https://duanlian.shenzjd.com/398667 | https://alist.shenzjd.com/ | 2025-12-25 |
| https://duanlian.shenzjd.com/2b3e90 | https://news.shenzjd.com/ | 2025-12-25 |
| https://duanlian.shenzjd.com/9cd1f4 | https://panhub.shenzjd.com/ | 2025-12-25 |
| https://duanlian.shenzjd.com/54ef62 | https://parse.shenzjd.com/ | 2025-12-25 |
| https://duanlian.shenzjd.com/d5f981 | https://bing.shenzjd.com/ | 2025-12-25 |
<!-- SHORT_LINKS_END -->

## 🛠️ 部署方式

### Cloudflare Workers（推荐）

本项目提供完整的 Cloudflare Worker 部署方案，包含前端页面、GitHub OAuth 登录和短链创建 API。

#### 1. 创建 GitHub OAuth App

1. 访问 [GitHub Developer Settings](https://github.com/settings/developers)
2. 点击 **New OAuth App**
3. 填写信息：
   - **Application name**: `duanlian`
   - **Homepage URL**: `https://duanlian.shenzjd.com`
   - **Authorization callback URL**: `https://duanlian.shenzjd.com/callback`
4. 创建后记录 **Client ID** 和 **Client Secret**

#### 2. 安装 Wrangler CLI

```bash
npm install -g wrangler
# 或
npx wrangler
```

#### 3. 配置项目

项目根目录已有 `wrangler.toml`，修改其中的域名和仓库信息即可。

#### 4. 设置密钥（Secret）

```bash
npx wrangler secret put GITHUB_CLIENT_ID
# 输入你的 Client ID

npx wrangler secret put GITHUB_CLIENT_SECRET
# 输入你的 Client Secret
```

#### 5. 部署

**手动部署：**

```bash
npx wrangler deploy
```

**自动部署（推荐）：**

项目已配置 GitHub Actions 自动部署（`.github/workflows/deploy.yml`）。每次 push 到 main 分支且修改了 `worker.js` 或 `wrangler.toml` 时自动部署。

需要在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置：

| Secret 名称 | 说明 |
|-------------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需要 Workers 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

> 获取方式：Cloudflare Dashboard → My Profile → API Tokens → Create Token → 选择 "Edit Cloudflare Workers" 模板

#### 6. 绑定自定义域名

在 Cloudflare Dashboard → Workers → 你的 Worker → Settings → Domains & Routes 中添加自定义域名。

#### 本地开发

```bash
npx wrangler dev
# 访问 http://localhost:8787
```

> **注意**：本地开发时需要在 `.dev.vars` 文件中配置密钥：
> ```
> GITHUB_CLIENT_ID=your_client_id
> GITHUB_CLIENT_SECRET=your_client_secret
> ```

### 腾讯云 EdgeOne / 阿里云 ESA

类似配置，使用边缘计算功能部署上述代码。

## 🤖 自动更新 README

本项目配置了 GitHub Action，自动从 Git 提取历史记录并更新 README 中的短链表格。

**工作流文件**：`.github/workflows/update-readme.yml`

触发条件：

- 每次 push 后自动更新
- 每天定时更新
- 手动触发

## 🔍 访问统计

通过 Serverless 平台的 WAF/分析面板查看访问统计：

- **Cloudflare**: Security → WAF → Analytics
- **腾讯云 EdgeOne**: 域名管理 → 统计分析
- **阿里云 ESA**: 安全防护 → 访问统计

## 📚 项目结构

```
.
├── README.md                    # 项目说明 & 短链列表
├── worker.js                    # Cloudflare Worker 主文件（前端 + OAuth + API + 重定向）
├── wrangler.toml                # Wrangler 部署配置
├── .github/
│   └── workflows/
│       ├── deploy.yml           # 自动部署 Worker
│       └── update-readme.yml   # 自动更新短链表格
└── (空提交历史，存储短链信息)
```

## 💡 为什么这样设计？

1. **零存储成本**：无需数据库，Git 就是存储
2. **版本控制**：所有短链都有完整历史记录
3. **简单可靠**：核心代码不到 10 行
4. **全球加速**：利用 GitHub 和 CDN 的全球节点

## 📄 许可证

MIT License

---

*自动生成的短链列表见上方表格*
