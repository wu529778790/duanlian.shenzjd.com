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
<html><head><meta charset="utf-8"><title>短链不存在</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
.box{text-align:center}.box h1{font-size:4rem;margin:0;color:#e74c3c}.box p{color:#666;margin:1rem 0}a{color:#3498db;text-decoration:none}</style>
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
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 2rem 1rem;
    }
    .container {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.15);
      padding: 2.5rem;
      width: 100%;
      max-width: 560px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
    }
    .header h1 { font-size: 1.5rem; color: #333; }
    .header h1 span { font-size: 1.8rem; margin-right: 0.3rem; }
    .user-info {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.9rem;
      color: #666;
    }
    .user-info .avatar {
      width: 28px; height: 28px;
      border-radius: 50%;
      background: #667eea;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 0.8rem;
    }
    .btn {
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 500;
      transition: all 0.2s;
      text-decoration: none;
    }
    .btn-primary {
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: #fff;
      width: 100%;
      padding: 0.85rem;
      font-size: 1rem;
    }
    .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-github {
      background: #24292e;
      color: #fff;
      padding: 0.5rem 1rem;
    }
    .btn-github:hover { background: #2f363d; }
    .btn-ghost {
      background: transparent;
      color: #667eea;
      padding: 0.4rem 0.6rem;
      font-size: 0.85rem;
    }
    .btn-ghost:hover { background: #f0f0f0; }
    .input-group {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .input-group input {
      flex: 1;
      padding: 0.85rem 1rem;
      border: 2px solid #e8e8e8;
      border-radius: 10px;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s;
    }
    .input-group input:focus { border-color: #667eea; }
    .input-group input:disabled { background: #f9f9f9; cursor: not-allowed; }

    .result {
      display: none;
      background: #f0fdf4;
      border: 1px solid #86efac;
      border-radius: 10px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      animation: fadeIn 0.3s;
    }
    .result.show { display: block; }
    .result-label { font-size: 0.8rem; color: #16a34a; margin-bottom: 0.3rem; font-weight: 600; }
    .result-url {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .result-url a {
      color: #16a34a;
      font-size: 1.1rem;
      font-weight: 600;
      text-decoration: none;
      word-break: break-all;
    }
    .result-url a:hover { text-decoration: underline; }

    .links-section { margin-top: 1.5rem; }
    .links-section h3 {
      font-size: 0.95rem;
      color: #666;
      margin-bottom: 0.8rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #eee;
    }
    .link-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.6rem 0;
      border-bottom: 1px solid #f5f5f5;
      font-size: 0.85rem;
    }
    .link-item:last-child { border-bottom: none; }
    .link-code {
      color: #667eea;
      font-weight: 600;
      font-family: monospace;
      min-width: 60px;
    }
    .link-target {
      color: #888;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 320px;
      text-align: right;
    }

    .error-msg {
      display: none;
      background: #fef2f2;
      border: 1px solid #fca5a5;
      border-radius: 10px;
      padding: 0.8rem 1rem;
      margin-bottom: 1rem;
      color: #dc2626;
      font-size: 0.9rem;
    }
    .error-msg.show { display: block; }

    .loading { display: inline-block; width: 16px; height: 16px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }

    .login-hint {
      text-align: center;
      color: #999;
      font-size: 0.9rem;
      margin-top: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><span>🎯</span>短链系统</h1>
      <div id="authArea"></div>
    </div>

    <div id="loginHint" class="login-hint" style="display:none;">
      <p>请先登录 GitHub 账号才能创建短链</p>
      <a href="/login" class="btn btn-github" style="margin-top:0.8rem;">🔑 使用 GitHub 登录</a>
    </div>

    <div id="mainForm" style="display:none;">
      <div class="input-group">
        <input type="url" id="urlInput" placeholder="输入长链接，如 https://example.com/very/long/path" />
        <button class="btn btn-primary" id="submitBtn" style="width:auto;padding:0.85rem 1.5rem;">生成</button>
      </div>

      <div id="errorMsg" class="error-msg"></div>
      <div id="result" class="result">
        <div class="result-label">✅ 短链已生成</div>
        <div class="result-url">
          <a id="shortLink" href="#" target="_blank"></a>
          <button class="btn btn-ghost" id="copyBtn">📋 复制</button>
        </div>
      </div>
    </div>

    <div class="links-section">
      <h3>📌 最近生成的短链</h3>
      <div id="linksList"><p style="color:#ccc;font-size:0.85rem;">暂无记录</p></div>
    </div>
  </div>

  <script>
    const $ = (sel) => document.querySelector(sel)
    const links = JSON.parse(localStorage.getItem('short_links') || '[]')

    // 检查登录状态
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

    // 渲染链接列表
    function renderLinks() {
      const container = $('#linksList')
      if (!links.length) {
        container.innerHTML = '<p style="color:#ccc;font-size:0.85rem;">暂无记录</p>'
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

    // 提交创建短链
    $('#submitBtn').addEventListener('click', async () => {
      const urlInput = $('#urlInput')
      const targetUrl = urlInput.value.trim()
      const errorEl = $('#errorMsg')
      const resultEl = $('#result')

      // 清除之前的状态
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

        // 显示结果
        $('#shortLink').href = data.shortLink
        $('#shortLink').textContent = data.shortLink
        resultEl.classList.add('show')
        urlInput.value = ''

        // 保存到本地
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

    // Enter 键提交
    $('#urlInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#submitBtn').click()
    })

    // 复制短链
    $('#copyBtn').addEventListener('click', () => {
      const text = $('#shortLink').textContent
      navigator.clipboard.writeText(text).then(() => {
        const btn = $('#copyBtn')
        btn.textContent = '✅ 已复制'
        setTimeout(() => { btn.textContent = '📋 复制' }, 1500)
      })
    })

    // 初始化
    checkAuth()
    renderLinks()
  </script>
</body>
</html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  })
}
