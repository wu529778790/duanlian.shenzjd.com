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

function handleHome(request, env) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>短链系统 — duanlian.shenzjd.com</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Mono", "Segoe UI", Roboto, monospace;
      background: #0F172A;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 2rem 1rem;
      color: #F8FAFC;
    }
    .container {
      background: #1E293B;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 520px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
    }
    .header h1 {
      font-size: 1.1rem;
      font-weight: 600;
      color: #F8FAFC;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .header h1 svg { width: 20px; height: 20px; color: #22C55E; }
    .user-info {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.8rem;
      color: #94A3B8;
    }
    .user-info .avatar {
      width: 24px; height: 24px;
      border-radius: 4px;
      background: #334155;
      color: #22C55E;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 0.7rem;
      font-family: monospace;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 500;
      font-family: inherit;
      transition: all 150ms ease;
      text-decoration: none;
    }
    .btn:focus-visible {
      outline: 2px solid #22C55E;
      outline-offset: 2px;
    }
    .btn-primary {
      background: #22C55E;
      color: #0F172A;
      padding: 0.6rem 1.2rem;
      font-weight: 600;
    }
    .btn-primary:hover { background: #16A34A; }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-github {
      background: #334155;
      color: #F8FAFC;
      border-color: #475569;
    }
    .btn-github:hover { background: #475569; }
    .btn-ghost {
      background: transparent;
      color: #94A3B8;
      padding: 0.35rem 0.5rem;
      font-size: 0.8rem;
    }
    .btn-ghost:hover { background: #334155; color: #F8FAFC; }
    .input-group {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }
    .input-group input {
      flex: 1;
      padding: 0.65rem 0.85rem;
      background: #0F172A;
      border: 1px solid #334155;
      border-radius: 6px;
      font-size: 0.9rem;
      font-family: monospace;
      color: #F8FAFC;
      outline: none;
      transition: border-color 150ms ease;
    }
    .input-group input::placeholder { color: #475569; }
    .input-group input:focus { border-color: #22C55E; }
    .input-group input:disabled { opacity: 0.5; cursor: not-allowed; }

    .result {
      display: none;
      background: #052E16;
      border: 1px solid #166534;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      animation: fadeIn 200ms ease;
    }
    .result.show { display: block; }
    .result-label {
      font-size: 0.75rem;
      color: #22C55E;
      margin-bottom: 0.4rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .result-label svg { width: 14px; height: 14px; }
    .result-url {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .result-url a {
      color: #4ADE80;
      font-size: 0.9rem;
      font-weight: 600;
      font-family: monospace;
      text-decoration: none;
      word-break: break-all;
    }
    .result-url a:hover { text-decoration: underline; }

    .links-section { margin-top: 1.25rem; }
    .links-section h3 {
      font-size: 0.8rem;
      color: #64748B;
      margin-bottom: 0.6rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .links-section h3 svg { width: 14px; height: 14px; }
    .link-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 0;
      border-bottom: 1px solid #1E293B;
      font-size: 0.8rem;
    }
    .link-item:last-child { border-bottom: none; }
    .link-code {
      color: #22C55E;
      font-weight: 600;
      font-family: monospace;
      min-width: 60px;
    }
    .link-code:hover { text-decoration: underline; }
    .link-target {
      color: #64748B;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 280px;
      text-align: right;
      font-family: monospace;
    }

    .error-msg {
      display: none;
      background: #450A0A;
      border: 1px solid #991B1B;
      border-radius: 6px;
      padding: 0.65rem 0.85rem;
      margin-bottom: 0.75rem;
      color: #FCA5A5;
      font-size: 0.85rem;
      font-family: monospace;
    }
    .error-msg.show { display: block; }

    .loading {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #0F172A;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 600ms linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

    .login-hint {
      text-align: center;
      color: #64748B;
      font-size: 0.85rem;
      margin-top: 0.5rem;
    }
    .login-hint .btn { margin-top: 1rem; }

    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.6);
      display: none; justify-content: center; align-items: center;
      z-index: 100;
    }
    .modal-overlay.show { display: flex; }
    .modal-card {
      background: #1E293B;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 1.5rem;
      max-width: 400px;
      width: 90%;
      animation: modalIn 200ms ease;
    }
    @keyframes modalIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        短链系统
      </h1>
      <div id="authArea"></div>
    </div>

    <div id="loginHint" class="login-hint" style="display:none;">
      <p>使用 GitHub 账号登录即可创建短链</p>
      <button class="btn btn-github" id="loginBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
        GitHub 登录
      </button>
    </div>

    <!-- Fork 提示弹窗 -->
    <div id="forkModal" class="modal-overlay">
      <div class="modal-card">
        <h3 style="font-size:1rem;color:#F8FAFC;margin-bottom:0.75rem;display:flex;align-items:center;gap:0.5rem;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          首次登录须知
        </h3>
        <div style="font-size:0.85rem;color:#94A3B8;line-height:1.6;margin-bottom:1rem;">
          <p style="margin-bottom:0.5rem;">登录后，系统将 <strong style="color:#F8FAFC;">fork</strong> 主仓库到你的 GitHub 账号下：</p>
          <p style="background:#0F172A;padding:0.5rem;border-radius:4px;font-family:monospace;font-size:0.8rem;color:#22C55E;margin-bottom:0.5rem;">yourname/duanlian.shenzjd.com</p>
          <p style="margin-bottom:0.5rem;">你创建的所有短链数据将存储在 <strong style="color:#F8FAFC;">你自己的仓库</strong> 中。</p>
          <p style="color:#64748B;font-size:0.8rem;">如果删除该 fork 仓库，对应的短链将失效。</p>
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
      <div class="input-group">
        <input type="url" id="urlInput" placeholder="https://example.com/very/long/path" aria-label="输入长链接" />
        <button class="btn btn-primary" id="submitBtn" aria-label="生成短链">生成</button>
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
    </div>

    <div class="links-section">
      <h3>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        最近生成
      </h3>
      <div id="linksList"><p style="color:#475569;font-size:0.8rem;font-family:monospace;">暂无记录</p></div>
    </div>
  </div>

  <script>
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
      } catch (e) {
        $('#loginHint').style.display = 'block'
        $('#mainForm').style.display = 'none'
      }
    }

    async function fetchLinks() {
      try {
        const res = await fetch('/api/links')
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
        container.innerHTML = '<p style="color:#475569;font-size:0.8rem;font-family:monospace;">暂无记录</p>'
        return
      }
      container.innerHTML = links.slice().reverse().map(link =>
        '<div class="link-item">' +
          '<a class="link-code" href="' + link.shortLink + '" target="_blank">/' + link.shortCode + '</a>' +
          '<span class="link-target" title="' + escapeHtml(link.targetUrl) + '">' + escapeHtml(link.targetUrl) + '</span>' +
        '</div>'
      ).join('')
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
  </script>
</body>
</html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  })
}
