# 🎯 duanlian.shenzjd.com

一个基于 Git 和 Cloudflare Workers 的极简短链接系统。

## 核心原理

利用 Git 空提交的 commit hash 作为短链标识：

1. **创建短链**：通过 GitHub API 创建空提交，目标 URL 作为 commit message
2. **访问短链**：读取 GitHub 的 `.patch` 文件，从 Subject 中提取目标 URL
3. **重定向**：302 跳转到目标地址

## 数据存储

**重要：请在使用前了解数据存储方式。**

- **平台所有者**（wu529778790）的短链存储在主仓库 `wu529778790/duanlian.shenzjd.com`
- **其他用户**登录后，系统会自动 **fork** 主仓库到用户自己的 GitHub 账号下（例如 `yourname/duanlian.shenzjd.com`），短链数据存储在该 fork 仓库中
- 每条短链对应一个 Git commit，commit message 为目标 URL
- 短链列表通过读取 Git 历史公开展示，任何人都可以查看
- **注意**：如果用户删除了 fork 仓库，对应的短链将失效

## 功能

- 🌐 Web 页面一键生成短链（无需终端）
- 🔑 GitHub OAuth 登录（任何 GitHub 用户均可使用）
- 📋 一键复制短链
- 📊 公开短链列表

## 部署

### 1. 创建 GitHub OAuth App

1. 打开 [GitHub Developer Settings](https://github.com/settings/developers) → **New OAuth App**
2. 填写：
   - **Homepage URL**: `https://duanlian.shenzjd.com`
   - **Authorization callback URL**: `https://duanlian.shenzjd.com/callback`
3. 记录 **Client ID** 和 **Client Secret**

### 2. 部署 Worker

```bash
# 安装 wrangler
npm install -g wrangler

# 登录 Cloudflare
npx wrangler login

# 设置密钥（只需一次）
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# 部署
npx wrangler deploy
```

### 3. 绑定域名

Cloudflare Dashboard → Workers → duanlian → Settings → Domains & Routes → 添加自定义域名。

### 本地开发

```bash
# 创建 .dev.vars 文件
echo 'GITHUB_CLIENT_ID=你的ClientID' > .dev.vars
echo 'GITHUB_CLIENT_SECRET=你的ClientSecret' >> .dev.vars

# 启动
npx wrangler dev
```

## 使用

1. 访问 `https://duanlian.shenzjd.com`
2. 点击 **GitHub 登录**
3. 首次登录时，系统会提示将 fork 主仓库，请确认授权
4. 登录后输入目标链接，点击 **生成**
5. 复制生成的短链

也支持命令行创建（仅平台所有者）：

```bash
git commit --allow-empty -m "https://example.com"
git push origin main
```

## 项目结构

```
.
├── README.md
├── worker.js          # Cloudflare Worker（前端 + OAuth + API + 重定向）
└── wrangler.toml      # 部署配置
```

## 许可证

MIT
