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

### 访问短链

```
https://duanlian.shenzjd.com/4975af
```

## 🔗 短链列表

<!-- SHORT_LINKS_START -->
| 短链 | 完整短链 | 目标链接 | 创建时间 |
|------|----------|----------|----------|
| /4975af | https://duanlian.shenzjd.com/4975af | https://github.com/wu529778790/duanlian.shenzjd.com | 2025-12-25 |
| /d5becb | https://duanlian.shenzjd.com/d5becb | https://shenzjd.com | 2025-12-25 |
| /980fdc | https://duanlian.shenzjd.com/980fdc | https://blog.shenzjd.com | 2025-12-25 |
| /398667 | https://duanlian.shenzjd.com/398667 | https://alist.shenzjd.com/ | 2025-12-25 |
| /2b3e90 | https://duanlian.shenzjd.com/2b3e90 | https://news.shenzjd.com/ | 2025-12-25 |
| /9cd1f4 | https://duanlian.shenzjd.com/9cd1f4 | https://panhub.shenzjd.com/ | 2025-12-25 |
| /54ef62 | https://duanlian.shenzjd.com/54ef62 | https://parse.shenzjd.com/ | 2025-12-25 |
<!-- SHORT_LINKS_END -->

## 🛠️ 部署方式

### Cloudflare Workers

```javascript
const GIT_REPO = "https://github.com/wu529778790/duanlian.shenzjd.com"

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url)
    const shortCode = pathname.slice(1) // 移除开头的 /

    if (!shortCode || shortCode === '') {
      return Response.redirect(GIT_REPO)
    }

    const gitPatch = `${GIT_REPO}/commit/${shortCode}.patch`

    try {
      const patch = await fetch(gitPatch, {
        cf: {
          cacheEverything: true,
          cacheTtlByStatus: { '200-299': 86400 }
        }
      }).then(res => res.text())

      const url = patch.match(/^Subject:\s*\[PATCH\](.*)$/m)?.[1]?.trim()

      return Response.redirect(url || GIT_REPO, 302)
    } catch (error) {
      return new Response('Short link not found', { status: 404 })
    }
  }
}
```

### 腾讯云 EdgeOne / 阿里云 ESA

类似配置，使用边缘计算功能部署上述代码。

## 🤖 自动更新 README

本项目配置了 GitHub Action，自动从 Git 提取历史记录并更新 README 中的短链表格。

**工作流文件**：`.github/workflows/update-readme.yml`

触发条件：

- 每次 push 后自动更新
- 每天定时更新
- 手动触发

## 📝 使用示例

```bash
# 1. 添加一个短链
git commit --allow-empty -m "https://www.google.com/search?q=hink"

# 2. 推送
git push

# 3. 查看生成的短码（假设是 a1b2c3d）
# 访问：https://shenzjd.com/a1b2c3d
```

## 🔍 访问统计

通过 Serverless 平台的 WAF/分析面板查看访问统计：

- **Cloudflare**: Security → WAF → Analytics
- **腾讯云 EdgeOne**: 域名管理 → 统计分析
- **阿里云 ESA**: 安全防护 → 访问统计

## 📚 项目结构

```
.
├── README.md                    # 项目说明 & 短链列表
├── .github/
│   └── workflows/
│       └── update-readme.yml   # 自动更新工作流
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
