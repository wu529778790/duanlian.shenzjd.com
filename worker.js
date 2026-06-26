// Cloudflare Worker — duanlian.shenzjd.com 短链系统
// 包含：前端页面、GitHub OAuth、创建短链 API、短链重定向

const GITHUB_API = 'https://api.github.com'
const GITHUB_OAUTH = 'https://github.com/login/oauth'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    try {
      // 路由分发
      if (pathname === '/health') return Response.json({ ok: true, version: '2.0', time: new Date().toISOString() })
      if (pathname === '/') return handleHome(request, env)
      if (pathname === '/login') return handleLogin(request, env)
      if (pathname === '/callback') return handleCallback(request, env)
      if (pathname === '/logout') return handleLogout()
      if (pathname === '/api/links' && request.method === 'POST') return handleCreateLink(request, env)
      if (pathname === '/api/links' && request.method === 'GET') return handleListLinks(request, env)
      if (pathname === '/api/links' && request.method === 'DELETE') return handleDeleteLink(request, env)
      if (pathname === '/api/user/links' && request.method === 'GET') return handleListUserLinks(request, env)
      if (pathname === '/api/user') return handleGetUser(request, env)

      // 短链重定向：/xxxxxx 或 /owner/xxxxxx
      if (/^\/[a-f0-9]{6}$/.test(pathname)) return handleRedirect(pathname, env)
      if (/^\/[a-zA-Z0-9-]+\/[a-f0-9]{6}$/.test(pathname)) return handleRedirect(pathname, env)

      return new Response('Not Found', { status: 404 })
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 })
    }
  },
}

// ========== Cookie 工具 ==========

function parseCookies(cookieHeader) {
  const cookies = {}
  if (!cookieHeader) return cookies
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.trim().split('=')
    if (key) cookies[key.trim()] = decodeURIComponent(rest.join('='))
  }
  return cookies
}

function setCookie(name, value, maxAge = 86400 * 7) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
}

function getUser(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'))
  const token = cookies['gh_token']
  const username = cookies['gh_user']
  if (!token || !username) return null
  return { username, token }
}

// ========== GitHub OAuth ==========

async function handleLogin(request, env) {
  const state = crypto.randomUUID()
  const redirectUri = `${new URL(request.url).origin}/callback`
  const githubUrl = `${GITHUB_OAUTH}/authorize?client_id=${env.GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=public_repo&state=${state}`

  return Response.redirect(githubUrl, 302)
}

async function handleCallback(request, env) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  if (!code) return new Response('Missing code', { status: 400 })

  // 用 code 换 token
  const tokenRes = await fetch(`${GITHUB_OAUTH}/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  })
  const tokenData = await tokenRes.json()
  if (!tokenData.access_token) {
    return new Response('OAuth failed: ' + JSON.stringify(tokenData), { status: 400 })
  }

  // 获取用户名
  const userRes = await fetch(`${GITHUB_API}/user`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'duanlian-worker' },
  })
  const userData = await userRes.json()
  const username = userData.login

  // 设置 cookie 并跳转回首页
  const headers = new Headers({
    Location: new URL(request.url).origin + '/',
  })
  headers.append('Set-Cookie', setCookie('gh_token', tokenData.access_token))
  headers.append('Set-Cookie', setCookie('gh_user', username))
  return new Response(null, { status: 302, headers })
}

function handleLogout() {
  const headers = new Headers({ Location: '/' })
  headers.append('Set-Cookie', setCookie('gh_token', '', 0))
  headers.append('Set-Cookie', setCookie('gh_user', '', 0))
  return new Response(null, { status: 302, headers })
}

async function handleGetUser(request, env) {
  const user = getUser(request, env)
  if (!user) return Response.json({ logged_in: false })
  return Response.json({ logged_in: true, username: user.username, is_owner: user.username === env.GITHUB_OWNER })
}

// ========== 创建短链 API ==========

async function handleCreateLink(request, env) {
  const user = getUser(request, env)
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  const body = await request.json()
  const { url: targetUrl } = body

  // 校验 URL
  if (!targetUrl || !/^https?:\/\/.+/.test(targetUrl)) {
    return Response.json({ error: '请输入有效的 URL（以 http/https 开头）' }, { status: 400 })
  }

  const headers = {
    Authorization: `Bearer ${user.token}`,
    'User-Agent': 'duanlian-worker',
    Accept: 'application/vnd.github.v3+json',
  }

  const isOwner = user.username === env.GITHUB_OWNER
  let repoOwner = env.GITHUB_OWNER
  let repoName = env.GITHUB_REPO

  // 非 owner 用户需要先 fork
  if (!isOwner) {
    const forkRes = await fetch(`${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/forks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_branch_only: true }),
    })
    if (!forkRes.ok && forkRes.status !== 422) {
      const err = await forkRes.text()
      return Response.json({ error: `Fork 失败: ${err}` }, { status: 502 })
    }
    // 422 表示已 fork 过，忽略
    repoOwner = user.username
  }

  // 1. 获取当前 HEAD
  const refRes = await fetch(`${GITHUB_API}/repos/${repoOwner}/${repoName}/git/ref/heads/main`, { headers })
  if (!refRes.ok) {
    const err = await refRes.text()
    return Response.json({ error: `获取 ref 失败: ${err}` }, { status: 502 })
  }
  const refData = await refRes.json()
  const headSha = refData.object.sha

  // 2. 获取当前 commit 的 tree SHA
  const headCommitRes = await fetch(`${GITHUB_API}/repos/${repoOwner}/${repoName}/git/commits/${headSha}`, { headers })
  if (!headCommitRes.ok) {
    const err = await headCommitRes.text()
    return Response.json({ error: `获取 commit 失败: ${err}` }, { status: 502 })
  }
  const headCommitData = await headCommitRes.json()
  const treeSha = headCommitData.tree.sha

  // 3. 创建 commit（tree 不变 = 空提交，仅记录短链信息在 commit message 中）
  const commitRes = await fetch(`${GITHUB_API}/repos/${repoOwner}/${repoName}/git/commits`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: targetUrl,
      tree: treeSha,
      parents: [headSha],
    }),
  })
  if (!commitRes.ok) {
    const err = await commitRes.text()
    return Response.json({ error: `创建 commit 失败: ${err}` }, { status: 502 })
  }
  const commitData = await commitRes.json()

  // 4. 更新 ref
  const updateRes = await fetch(`${GITHUB_API}/repos/${repoOwner}/${repoName}/git/refs/heads/main`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commitData.sha }),
  })
  if (!updateRes.ok) {
    const err = await updateRes.text()
    return Response.json({ error: `更新 ref 失败: ${err}` }, { status: 502 })
  }

  const shortCode = commitData.sha.slice(0, 6)
  const domain = env.DOMAIN || 'duanlian.shenzjd.com'
  // 非 owner 用户的短链包含用户名
  const shortLink = isOwner
    ? `https://${domain}/${shortCode}`
    : `https://${domain}/${repoOwner}/${shortCode}`

  return Response.json({ shortCode, shortLink, targetUrl })
}

// ========== 获取短链列表 ==========

async function handleListLinks(request, env) {
  const headers = {
    'User-Agent': 'duanlian-worker',
    Accept: 'application/vnd.github.v3+json',
  }

  const res = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/commits?per_page=100`,
    { headers }
  )
  if (!res.ok) {
    return Response.json({ error: '获取失败' }, { status: 502 })
  }

  const commits = await res.json()
  const domain = env.DOMAIN || 'duanlian.shenzjd.com'

  const links = commits
    .map(c => {
      const msg = c.commit.message.trim()
      if (!/^https?:\/\/.+/.test(msg)) return null
      const shortCode = c.sha.slice(0, 6)
      const date = c.commit.author?.date?.slice(0, 10) || ''
      return {
        shortCode,
        shortLink: `https://${domain}/${shortCode}`,
        targetUrl: msg,
        createdAt: date,
      }
    })
    .filter(Boolean)

  return Response.json({ links })
}

// ========== 获取用户自己的短链列表 ==========

async function handleListUserLinks(request, env) {
  const user = getUser(request, env)
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  const headers = {
    Authorization: `Bearer ${user.token}`,
    'User-Agent': 'duanlian-worker',
    Accept: 'application/vnd.github.v3+json',
  }

  // 读取用户 fork 仓库的 commit 历史
  const res = await fetch(
    `${GITHUB_API}/repos/${user.username}/${env.GITHUB_REPO}/commits?per_page=100`,
    { headers }
  )
  if (!res.ok) {
    // 如果 fork 不存在，返回空列表
    return Response.json({ links: [] })
  }

  const commits = await res.json()
  const domain = env.DOMAIN || 'duanlian.shenzjd.com'

  const links = commits
    .map(c => {
      const msg = c.commit.message.trim()
      if (!/^https?:\/\/.+/.test(msg)) return null
      const shortCode = c.sha.slice(0, 6)
      const date = c.commit.author?.date?.slice(0, 10) || ''
      return {
        shortCode,
        shortLink: `https://${domain}/${user.username}/${shortCode}`,
        targetUrl: msg,
        createdAt: date,
      }
    })
    .filter(Boolean)

  return Response.json({ links })
}

// ========== 删除短链 ==========

async function handleDeleteLink(request, env) {
  const user = getUser(request, env)
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  const body = await request.json()
  const { shortCode } = body
  if (!shortCode) return Response.json({ error: '缺少 shortCode' }, { status: 400 })

  const headers = {
    Authorization: `Bearer ${user.token}`,
    'User-Agent': 'duanlian-worker',
    Accept: 'application/vnd.github.v3+json',
  }

  // 获取用户 fork 仓库的 HEAD
  const refRes = await fetch(
    `${GITHUB_API}/repos/${user.username}/${env.GITHUB_REPO}/git/ref/heads/main`,
    { headers }
  )
  if (!refRes.ok) return Response.json({ error: '获取 ref 失败' }, { status: 502 })

  const refData = await refRes.json()
  const headSha = refData.object.sha

  // 查找目标 commit 及其父 commit
  const commitRes = await fetch(
    `${GITHUB_API}/repos/${user.username}/${env.GITHUB_REPO}/git/commits/${headSha}`,
    { headers }
  )
  if (!commitRes.ok) return Response.json({ error: '获取 commit 失败' }, { status: 502 })

  const commitData = await commitRes.json()

  // 检查是否是目标 commit（匹配前6位）
  if (!commitData.sha.startsWith(shortCode)) {
    return Response.json({ error: '只能删除最近一条短链' }, { status: 400 })
  }

  // 获取父 commit
  if (!commitData.parents || commitData.parents.length === 0) {
    return Response.json({ error: '已是初始 commit，无法删除' }, { status: 400 })
  }

  const parentSha = commitData.parents[0].sha

  // 更新 ref 指向父 commit（相当于删除最近一条）
  const updateRes = await fetch(
    `${GITHUB_API}/repos/${user.username}/${env.GITHUB_REPO}/git/refs/heads/main`,
    {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: parentSha, force: true }),
    }
  )
  if (!updateRes.ok) {
    const err = await updateRes.text()
    return Response.json({ error: `删除失败: ${err}` }, { status: 502 })
  }

  return Response.json({ ok: true })
}

// ========== 短链重定向 ==========

async function handleRedirect(pathname, env) {
  const parts = pathname.slice(1).split('/')
  let repoOwner, shortCode

  if (parts.length === 2) {
    // /owner/code 格式
    repoOwner = parts[0]
    shortCode = parts[1]
  } else {
    // /code 格式（owner 的短链）
    repoOwner = env.GITHUB_OWNER
    shortCode = parts[0]
  }

  const gitPatchUrl = `https://github.com/${repoOwner}/${env.GITHUB_REPO}/commit/${shortCode}.patch`

  const patchRes = await fetch(gitPatchUrl, {
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 86400 } },
  })

  if (!patchRes.ok) {
    return render404(shortCode)
  }

  const patch = await patchRes.text()
  const match = patch.match(/^Subject:\s*\[PATCH\](.*)$/m)
  const targetUrl = match?.[1]?.trim()

  if (!targetUrl || !/^https?:\/\/.+/.test(targetUrl)) {
    return render404(shortCode)
  }

  return Response.redirect(targetUrl, 302)
}

function render404(shortCode) {
  return new Response(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>短链不存在</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"SF Mono","Segoe UI",monospace;background:#0F172A;color:#F8FAFC;display:flex;justify-content:center;align-items:center;height:100vh}.box{text-align:center}.box h1{font-size:4rem;margin:0;color:#EF4444}.box p{color:#64748B;margin:1rem 0;font-size:0.9rem}.box code{color:#F8FAFC;background:#1E293B;padding:0.2rem 0.5rem;border-radius:4px;font-size:0.85rem}.box a{color:#22C55E;text-decoration:none;font-weight:500}.box a:hover{text-decoration:underline}</style>
</head><body><div class="box"><h1>404</h1><p>短链 <code>/${shortCode}</code> 不存在</p><a href="/">返回首页</a></div></body></html>`, {
    status: 404,
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  })
}

// ========== 前端页面 ==========

function getCSS() {
  return `
    :root, :root[data-theme="light"] {
      --bg: #FFFFFF;
      --bg-card: #F4F4F5;
      --bg-input: #FFFFFF;
      --border: #E4E4E7;
      --text: #18181B;
      --text-secondary: #71717A;
      --text-muted: #A1A1AA;
      --accent: #22C55E;
      --accent-dark: #16A34A;
      --accent-bg: rgba(34, 197, 94, 0.1);
      --accent-border: rgba(34, 197, 94, 0.3);
      --btn-bg: #F4F4F5;
      --btn-hover: #E4E4E7;
      --error-bg: rgba(239, 68, 68, 0.1);
      --error-border: rgba(239, 68, 68, 0.2);
      --error-text: #DC2626;
      --icon-btn-hover: #E4E4E7;
      --nav-bg: rgba(255, 255, 255, 0.8);
      --nav-border: #E4E4E7;
    }
    :root[data-theme="dark"] {
      --bg: #09090B;
      --bg-card: #18181B;
      --bg-input: #09090B;
      --border: #27272A;
      --text: #FAFAFA;
      --text-secondary: #71717A;
      --text-muted: #A1A1AA;
      --accent: #22C55E;
      --accent-dark: #16A34A;
      --accent-bg: rgba(34, 197, 94, 0.08);
      --accent-border: rgba(34, 197, 94, 0.2);
      --btn-bg: #18181B;
      --btn-hover: #27272A;
      --error-bg: rgba(239, 68, 68, 0.1);
      --error-border: rgba(239, 68, 68, 0.2);
      --error-text: #FCA5A5;
      --icon-btn-hover: #27272A;
      --nav-bg: rgba(9, 9, 11, 0.8);
      --nav-border: #27272A;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #09090B;
        --bg-card: #18181B;
        --bg-input: #09090B;
        --border: #27272A;
        --text: #FAFAFA;
        --text-secondary: #71717A;
        --text-muted: #A1A1AA;
        --accent: #22C55E;
        --accent-dark: #16A34A;
        --accent-bg: rgba(34, 197, 94, 0.08);
        --accent-border: rgba(34, 197, 94, 0.2);
        --btn-bg: #18181B;
        --btn-hover: #27272A;
        --error-bg: rgba(239, 68, 68, 0.1);
        --error-border: rgba(239, 68, 68, 0.2);
        --error-text: #FCA5A5;
        --icon-btn-hover: #27272A;
        --nav-bg: rgba(9, 9, 11, 0.8);
        --nav-border: #27272A;
      }
    }

    /* Navbar */
    .navbar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 56px;
      background: var(--nav-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--nav-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 1.5rem;
      z-index: 50;
    }
    .nav-logo {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 700;
      font-size: 1.1rem;
      color: var(--accent);
      text-decoration: none;
    }
    .nav-logo svg { width: 20px; height: 20px; }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
    .nav-link {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.5rem 0.75rem;
      border-radius: 8px;
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      transition: all 150ms ease;
      white-space: nowrap;
    }
    .nav-link:hover { background: var(--btn-hover); color: var(--text); }
    .nav-link.active { color: var(--accent); background: var(--accent-bg); }
    .nav-social {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
    .nav-social a {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 8px;
      color: var(--text-muted);
      text-decoration: none;
      transition: all 150ms ease;
    }
    .nav-social a:hover { background: var(--btn-hover); color: var(--text); }
    .nav-social svg { width: 18px; height: 18px; }
    .theme-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 8px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 150ms ease;
    }
    .theme-toggle:hover { background: var(--btn-hover); color: var(--text); }
    .theme-toggle svg { width: 18px; height: 18px; }
    .theme-toggle .icon-moon { display: none; }
    .theme-toggle .icon-sun { display: block; }
    :root[data-theme="dark"] .theme-toggle .icon-moon { display: block; }
    :root[data-theme="dark"] .theme-toggle .icon-sun { display: none; }
    :root[data-theme="light"] .theme-toggle .icon-moon { display: none; }
    :root[data-theme="light"] .theme-toggle .icon-sun { display: block; }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) .theme-toggle .icon-moon { display: block; }
      :root:not([data-theme="light"]) .theme-toggle .icon-sun { display: none; }
    }
    @media (max-width: 768px) {
      .nav-links { display: none; }
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 5rem 1.5rem 4rem;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      transition: background 300ms ease, color 300ms ease;
    }
    .container {
      width: 100%;
      max-width: 720px;
    }

    /* Header */
    .header {
      text-align: center;
      margin-bottom: 3rem;
    }
    .logo {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      background: linear-gradient(135deg, #22C55E 0%, #16A34A 100%);
      border-radius: 16px;
      margin-bottom: 1.25rem;
      box-shadow: 0 8px 32px rgba(34, 197, 94, 0.3);
    }
    .logo svg { width: 28px; height: 28px; color: #09090B; }
    .header h1 {
      font-size: 2.25rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 0.5rem;
      letter-spacing: -0.03em;
    }
    .header p {
      font-size: 1rem;
      color: var(--text-secondary);
      max-width: 420px;
      margin: 0 auto;
      line-height: 1.6;
    }

    /* User Info */
    .user-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 0.9rem;
      color: var(--text-muted);
      justify-content: center;
      margin-top: 1.25rem;
    }
    .user-info .avatar {
      width: 36px; height: 36px;
      border-radius: 10px;
      background: linear-gradient(135deg, #22C55E 0%, #16A34A 100%);
      color: #09090B;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.9rem;
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.625rem;
      padding: 0.875rem 1.75rem;
      border-radius: 12px;
      border: none;
      cursor: pointer;
      font-size: 1rem;
      font-weight: 500;
      font-family: inherit;
      transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
      text-decoration: none;
    }
    .btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .btn-primary {
      background: linear-gradient(135deg, #22C55E 0%, #16A34A 100%);
      color: #09090B;
      font-weight: 600;
      box-shadow: 0 4px 14px rgba(34, 197, 94, 0.3);
    }
    .btn-primary:hover {
      box-shadow: 0 8px 24px rgba(34, 197, 94, 0.4);
      transform: translateY(-2px);
    }
    .btn-primary:active { transform: translateY(0); }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }
    .btn-github {
      background: var(--btn-bg);
      color: var(--text);
      border: 1px solid var(--border);
    }
    .btn-github:hover { background: var(--btn-hover); }
    .btn-ghost {
      background: transparent;
      color: var(--text-muted);
      padding: 0.5rem 0.875rem;
      font-size: 0.875rem;
    }
    .btn-ghost:hover { background: var(--btn-hover); color: var(--text); }

    /* Input Card */
    .input-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .input-group {
      display: flex;
      gap: 0.75rem;
    }
    .input-group input {
      flex: 1;
      padding: 1rem 1.25rem;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 10px;
      font-size: 1rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      color: var(--text);
      outline: none;
      transition: border-color 200ms ease, box-shadow 200ms ease;
    }
    .input-group input::placeholder { color: var(--text-muted); }
    .input-group input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.15);
    }
    .input-group input:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Result */
    .result {
      display: none;
      background: var(--accent-bg);
      border: 1px solid var(--accent-border);
      border-radius: 12px;
      padding: 1.25rem 1.5rem;
      margin-top: 1.25rem;
      animation: slideUp 250ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    .result.show { display: block; }
    .result-label {
      font-size: 0.75rem;
      color: var(--accent);
      margin-bottom: 0.75rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .result-label svg { width: 14px; height: 14px; }
    .result-url {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .result-url a {
      color: #16A34A;
      font-size: 1.125rem;
      font-weight: 600;
      font-family: 'SF Mono', 'Fira Code', monospace;
      text-decoration: none;
      word-break: break-all;
    }
    @media (prefers-color-scheme: dark) {
      .result-url a { color: #4ADE80; }
    }
    .result-url a:hover { text-decoration: underline; }

    /* Links Section */
    .links-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.5rem;
    }
    .links-section h3 {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
    }
    .links-section h3 svg { width: 14px; height: 14px; }
    .link-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.875rem 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.9rem;
      transition: all 150ms ease;
    }
    .link-item:last-child { border-bottom: none; }
    .link-item:hover {
      background: var(--accent-bg);
      margin: 0 -0.75rem;
      padding-left: 0.75rem;
      padding-right: 0.75rem;
      border-radius: 8px;
    }
    .link-code {
      color: var(--accent);
      font-weight: 600;
      font-family: 'SF Mono', 'Fira Code', monospace;
      min-width: 80px;
    }
    .link-code:hover { text-decoration: underline; }
    .link-target {
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 360px;
      text-align: right;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.85rem;
    }
    .link-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .btn-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      border: none;
      background: transparent;
      color: #71717A;
      cursor: pointer;
      transition: all 150ms ease;
      flex-shrink: 0;
    }
    .btn-icon:hover { background: var(--icon-btn-hover); color: var(--text); }
    .btn-delete:hover { background: rgba(239, 68, 68, 0.15); color: #DC2626; }
    @media (prefers-color-scheme: dark) {
      .btn-delete:hover { color: #FCA5A5; }
    }
    .btn-copy.copied { background: var(--accent-bg); color: var(--accent); }

    /* Error */
    .error-msg {
      display: none;
      background: var(--error-bg);
      border: 1px solid var(--error-border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
      color: var(--error-text);
      font-size: 0.9rem;
    }
    .error-msg.show { display: block; }

    /* Loading */
    .loading {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2px solid var(--text);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 600ms linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

    /* Login Hint */
    .login-hint {
      text-align: center;
      padding: 2rem 0;
    }
    .login-hint p {
      color: var(--text-muted);
      font-size: 1rem;
      margin-bottom: 1.25rem;
    }

    /* Modal */
    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.5);
      display: none; justify-content: center; align-items: center;
      z-index: 100;
      backdrop-filter: blur(8px);
    }
    @media (prefers-color-scheme: dark) {
      .modal-overlay { background: rgba(0,0,0,0.8); }
    }
    .modal-overlay.show { display: flex; }
    .modal-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 2rem;
      max-width: 480px;
      width: 90%;
      animation: modalIn 250ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    @keyframes modalIn { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
  `
}

function getBody() {
  return `
  <nav class="navbar">
  <!-- Navigation -->
  <nav class="navbar">
    <a href="/" class="nav-logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      快链
    </a>
    <div class="nav-links">
      <a href="https://shenzjd.com/" class="nav-link" target="_blank" rel="noopener">🏠 首页</a>
      <a href="https://alist.shenzjd.com/" class="nav-link" target="_blank" rel="noopener">📁 在线网盘</a>
      <a href="https://panhub.shenzjd.com/" class="nav-link" target="_blank" rel="noopener">🔍 网盘搜索</a>
      <a href="https://duanlian.shenzjd.com/" class="nav-link active">🔗 快链</a>
      <a href="https://parse.shenzjd.com/" class="nav-link" target="_blank" rel="noopener">🎬 视频解析</a>
      <a href="https://newshub.shenzjd.com/" class="nav-link" target="_blank" rel="noopener">📰 热点聚合</a>
      <a href="https://navhub.shenzjd.com/" class="nav-link" target="_blank" rel="noopener">🧭 个人导航</a>
      <a href="https://bing.shenzjd.com/" class="nav-link" target="_blank" rel="noopener">🖼️ 必应壁纸</a>
    </div>
    <div class="nav-social">
      <button class="theme-toggle" id="themeToggle" aria-label="切换主题">
        <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
      <a href="https://t.me/shenzjd_com" target="_blank" rel="noopener" aria-label="Telegram">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>
      </a>
      <a href="https://github.com/wu529778790" target="_blank" rel="noopener" aria-label="GitHub">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
      </a>
      <a href="https://x.com/shenzujiudi" target="_blank" rel="noopener" aria-label="X (Twitter)">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      </a>
    </div>
  </nav>

  <div class="container">
    <div class="header">
      <div class="logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      </div>
      <h1>短链系统</h1>
      <p>基于 Git 的极简短链接服务<br>任何 GitHub 用户均可创建</p>
      <div id="authArea"></div>
    </div>

    <div id="loginHint" class="login-hint" style="display:none;">
      <p>使用 GitHub 账号登录，即可一键生成短链</p>
      <button class="btn btn-github" id="loginBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
        GitHub 登录
      </button>
    </div>

    <!-- Fork 提示弹窗 -->
    <div id="forkModal" class="modal-overlay">
      <div class="modal-card">
        <h3 style="font-size:1rem;color:var(--text);margin-bottom:0.75rem;display:flex;align-items:center;gap:0.5rem;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          首次登录须知
        </h3>
        <div style="font-size:0.85rem;color:var(--text-secondary);line-height:1.6;margin-bottom:1rem;">
          <p style="margin-bottom:0.5rem;">登录后，系统将 <strong style="color:var(--text);">fork</strong> 主仓库到你的 GitHub 账号下：</p>
          <p style="background:var(--bg-input);padding:0.5rem;border-radius:4px;font-family:monospace;font-size:0.8rem;color:var(--accent);margin-bottom:0.5rem;">yourname/duanlian.shenzjd.com</p>
          <p style="margin-bottom:0.5rem;">你创建的所有短链数据将存储在 <strong style="color:var(--text);">你自己的仓库</strong> 中。</p>
          <p style="color:var(--text-muted);font-size:0.8rem;">如果删除该 fork 仓库，对应的短链将失效。</p>
        </div>
        <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
          <button class="btn btn-ghost" id="cancelLogin">取消</button>
          <a href="/login" class="btn btn-primary" style="text-decoration:none;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            确认登录
          </a>
        </div>
      </div>
    </div>

    <div id="mainForm" style="display:none;">
      <div class="input-card">
        <div class="input-group">
          <input type="url" id="urlInput" placeholder="https://shenzjd.com/your/long/url" aria-label="输入长链接" />
          <button class="btn btn-ghost" id="pasteBtn" type="button" aria-label="粘贴链接">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            粘贴
          </button>
          <button class="btn btn-primary" id="submitBtn" aria-label="生成短链">生成短链</button>
        </div>

      <div id="errorMsg" class="error-msg" role="alert"></div>
      <div id="result" class="result">
        <div class="result-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          短链已生成
        </div>
        <div class="result-url">
          <a id="shortLink" href="#" target="_blank"></a>
          <button class="btn btn-ghost" id="copyBtn" aria-label="复制短链">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            复制
          </button>
        </div>
      </div>
    </div></div>

    <div class="links-section">
      <h3>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        最近生成
      </h3>
      <div id="linksList"><p style="color:#475569;font-size:0.8rem;font-family:monospace;">暂无记录</p></div>
    </div>
  </div>
  `
}

function getScript() {
  return `
    // Theme toggle
    const themeToggle = document.getElementById('themeToggle')
    const root = document.documentElement

    function getPreferredTheme() {
      const saved = localStorage.getItem('theme')
      if (saved) return saved
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }

    function applyTheme(theme) {
      root.setAttribute('data-theme', theme)
      localStorage.setItem('theme', theme)
    }

    applyTheme(getPreferredTheme())

    themeToggle.addEventListener('click', () => {
      const current = root.getAttribute('data-theme')
      const next = current === 'dark' ? 'light' : 'dark'
      applyTheme(next)
    })

    // Listen for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('theme')) {
        applyTheme(e.matches ? 'dark' : 'light')
      }
    })

    const $ = (sel) => document.querySelector(sel)
    let links = []

    async function checkAuth() {
      try {
        const res = await fetch('/api/user')
        const data = await res.json()
        if (data.logged_in) {
          $('#authArea').innerHTML =
            '<div class="user-info"><div class="avatar">' + data.username[0].toUpperCase() + '</div>' +
            '<span>' + data.username + '</span>' +
            '<a href="/logout" class="btn btn-ghost">退出</a></div>'
          $('#loginHint').style.display = 'none'
          $('#mainForm').style.display = 'block'
          window._loggedIn = true
        } else {
          $('#authArea').innerHTML = ''
          $('#loginHint').style.display = 'block'
          $('#mainForm').style.display = 'none'
          window._loggedIn = false
        }
        // 登录状态变化后重新获取链接列表
        fetchLinks()
      } catch (e) {
        $('#loginHint').style.display = 'block'
        $('#mainForm').style.display = 'none'
      }
    }

    async function fetchLinks() {
      try {
        // 登录用户看自己的短链，未登录看公开列表
        const url = window._loggedIn ? '/api/user/links' : '/api/links'
        const res = await fetch(url)
        const data = await res.json()
        if (data.links) {
          links = data.links
          renderLinks()
        }
      } catch (e) {
        // 接口失败时用本地缓存
        links = JSON.parse(localStorage.getItem('short_links') || '[]')
        renderLinks()
      }
    }

    function renderLinks() {
      const container = $('#linksList')
      if (!links.length) {
        container.innerHTML = '<p style="color:#52525B;font-size:0.85rem;font-family:monospace;">暂无记录</p>'
        return
      }
      container.innerHTML = links.slice().reverse().map((link, idx) => {
        const isLatest = idx === 0 && window._loggedIn
        const deleteBtn = isLatest
          ? '<button class="btn-icon btn-delete" data-code="' + link.shortCode + '" title="删除此短链" aria-label="删除短链">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
            '</button>'
          : ''
        const copyBtn = !window._loggedIn
          ? '<button class="btn-icon btn-copy" data-link="' + link.shortLink + '" title="复制短链" aria-label="复制短链">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
            '</button>'
          : ''
        return '<div class="link-item">' +
          '<a class="link-code" href="' + link.shortLink + '" target="_blank">/' + link.shortCode + '</a>' +
          '<div class="link-actions">' +
            '<span class="link-target" title="' + escapeHtml(link.targetUrl) + '">' + escapeHtml(link.targetUrl) + '</span>' +
            copyBtn + deleteBtn +
          '</div>' +
        '</div>'
      }).join('')

      // 绑定删除事件
      container.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          const code = btn.dataset.code
          if (!confirm('确定要删除此短链吗？')) return
          btn.disabled = true
          try {
            const res = await fetch('/api/links', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ shortCode: code }),
            })
            const data = await res.json()
            if (res.ok) {
              fetchLinks()
            } else {
              alert(data.error || '删除失败')
              btn.disabled = false
            }
          } catch (e) {
            alert('网络错误')
            btn.disabled = false
          }
        })
      })

      // 绑定复制事件
      container.querySelectorAll('.btn-copy').forEach(btn => {
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(btn.dataset.link).then(() => {
            btn.classList.add('copied')
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
            setTimeout(() => {
              btn.classList.remove('copied')
              btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
            }, 1500)
          })
        })
      })
    }

    function escapeHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }

    $('#submitBtn').addEventListener('click', async () => {
      const urlInput = $('#urlInput')
      const targetUrl = urlInput.value.trim()
      const errorEl = $('#errorMsg')
      const resultEl = $('#result')

      errorEl.classList.remove('show')
      resultEl.classList.remove('show')

      if (!targetUrl) {
        errorEl.textContent = '请输入链接'
        errorEl.classList.add('show')
        return
      }
      if (!new RegExp('^https?://.+').test(targetUrl)) {
        errorEl.textContent = '链接格式不正确，需要以 http:// 或 https:// 开头'
        errorEl.classList.add('show')
        return
      }

      const btn = $('#submitBtn')
      btn.disabled = true
      btn.innerHTML = '<span class="loading"></span>'

      try {
        const res = await fetch('/api/links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: targetUrl }),
        })
        const data = await res.json()

        if (!res.ok) {
          errorEl.textContent = data.error || '创建失败'
          errorEl.classList.add('show')
          return
        }

        $('#shortLink').href = data.shortLink
        $('#shortLink').textContent = data.shortLink
        resultEl.classList.add('show')
        urlInput.value = ''

        // 本地缓存
        links.push({ shortCode: data.shortCode, shortLink: data.shortLink, targetUrl: data.targetUrl })
        localStorage.setItem('short_links', JSON.stringify(links))
        renderLinks()
      } catch (e) {
        errorEl.textContent = '网络错误，请重试'
        errorEl.classList.add('show')
      } finally {
        btn.disabled = false
        btn.textContent = '生成'
      }
    })

    $('#urlInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#submitBtn').click()
    })

    $('#copyBtn').addEventListener('click', () => {
      const text = $('#shortLink').textContent
      navigator.clipboard.writeText(text).then(() => {
        const btn = $('#copyBtn')
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> 已复制'
        setTimeout(() => {
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制'
        }, 1500)
      })
    })

    // 粘贴按钮
    $('#pasteBtn').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText()
        if (text && new RegExp('^https?://.+').test(text.trim())) {
          $('#urlInput').value = text.trim()
          // 自动提交
          $('#submitBtn').click()
        } else if (text) {
          // 非 URL 内容，填入输入框让用户修改
          $('#urlInput').value = text.trim()
          $('#urlInput').focus()
        }
      } catch (e) {
        $('#urlInput').focus()
      }
    })

    // 自动检测粘贴（当输入框获得焦点时监听粘贴事件）
    $('#urlInput').addEventListener('paste', (e) => {
      // 粘贴后自动聚焦到输入框
      setTimeout(() => {
        $('#urlInput').focus()
      }, 0)
    })

    checkAuth()
    fetchLinks()

    // Fork 提示弹窗
    const forkModal = $('#forkModal')
    const loginBtn = $('#loginBtn')
    const cancelLogin = $('#cancelLogin')

    loginBtn.addEventListener('click', () => {
      forkModal.classList.add('show')
    })

    cancelLogin.addEventListener('click', () => {
      forkModal.classList.remove('show')
    })

    forkModal.addEventListener('click', (e) => {
      if (e.target === forkModal) {
        forkModal.classList.remove('show')
      }
    })
  `
}

function handleHome(request, env) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>快链 — duanlian.shenzjd.com</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>${getCSS()}</style>
</head>
<body>${getBody()}
  <script>${getScript()}</script>
</body>
</html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  })
}
