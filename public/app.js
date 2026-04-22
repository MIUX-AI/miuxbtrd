/**
 * MIUX AI TRADER v4 — Frontend App
 * Fetches data from backend API. No template strings from server.
 */

// ── State ──────────────────────────────────────────────────────────────
let S         = {}
let MACRO     = {}
let MEMORY    = {}
let AI_STATE  = {}
let DECISIONS = []
let authReady = false
let wsShouldReconnect = false

// ── DOM Helpers ────────────────────────────────────────────────────────
const $    = id => document.getElementById(id)
const setH = (id, html) => { const el = $(id); if (el) el.innerHTML = html }
const setT = (id, text) => { const el = $(id); if (el) el.textContent = text == null ? '' : String(text) }
const fd   = (n, d = 2) => Number.isFinite(+n) ? (+n).toFixed(d) : '0.00'
const pct  = n => { const v = +n; return `<span class="${v >= 0 ? 'bull' : 'bear'}">${v >= 0 ? '+' : ''}${fd(v)}%</span>` }

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escText = v => String(v ?? '').replace(/[&<>"']/g, ch => ESC_MAP[ch])
function sanitizeDeep(value) {
  if (Array.isArray(value)) return value.map(sanitizeDeep)
  if (value && typeof value === 'object') {
    const out = {}
    Object.entries(value).forEach(([k, v]) => { out[k] = sanitizeDeep(v) })
    return out
  }
  return typeof value === 'string' ? escText(value) : value
}

function badge(text, cls = 'b-muted') { return `<span class="badge ${cls}">${text}</span>` }

function regimeBadge(r) {
  const map = { trending_up: 'b-lime', trending_down: 'b-red', ranging: 'b-muted', expansion: 'b-cyan', compression: 'b-warn', panic: 'b-red', euphoria: 'b-warn' }
  return badge(r || '?', map[r] || 'b-muted')
}

function aiBadge(v) {
  const map = { BUY: 'b-lime', SELL: 'b-red', WAIT: 'b-warn', SKIP: 'b-red' }
  return badge(v || '-', map[v] || 'b-muted')
}

function confBar(v) {
  const color = v > 0.7 ? 'var(--lime)' : v > 0.55 ? 'var(--warn)' : 'var(--t3)'
  return `<div class="conf-bar">
    <div class="pbar" style="width:60px"><div class="pbar-fill" style="width:${(v || 0) * 100}%;background:${color}"></div></div>
    <span style="font-size:10px">${((v || 0) * 100).toFixed(0)}%</span>
  </div>`
}

function fmtPrice(p) { return p > 100 ? fd(p, 2) : p > 1 ? fd(p, 4) : fd(p, 6) }

// ── Navigation ─────────────────────────────────────────────────────────
function nav(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
  const pg  = $('page-' + id); if (pg) pg.classList.add('active')
  const btn = document.querySelector(`.nav-btn[onclick*="${id}"]`); if (btn) btn.classList.add('active')
  if (id === 'ai')       loadDecisions()
  if (id === 'scanner')  renderScanner()
  if (id === 'memory')   renderMemory()
  if (id === 'settings') renderSettings()
}

// ── API Calls ───────────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) }
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, headers })
  if (r.status === 401) {
    handleUnauthorized(true)
    throw new Error('401 Unauthorized')
  }
  if (!r.ok) {
    let message = `${r.status} ${r.statusText}`
    try {
      const data = await r.json()
      if (data?.error) message = data.error
    } catch {}
    throw new Error(message)
  }
  const contentType = r.headers.get('content-type') || ''
  return contentType.includes('application/json') ? r.json() : r.text()
}

function updateAuthMessage(msg, warn = false) {
  const el = $('auth-message')
  if (!el) return
  el.textContent = msg || 'Enter dashboard password to unlock the dashboard.'
  el.style.color = warn ? 'var(--warn)' : 'var(--t3)'
}

function showAuthOverlay(show, msg = '') {
  const el = $('auth-overlay')
  if (el) el.style.display = show ? 'block' : 'none'
  if (msg) updateAuthMessage(msg)
  if (show) {
    setT('auth-session-status', 'Locked')
    $('login-password')?.focus()
  } else {
    setT('auth-session-status', 'Authenticated')
  }
}

function stopLive() {
  wsShouldReconnect = false
  wsConnected = false
  if (ws) {
    try { ws.close() } catch {}
    ws = null
  }
  updateWsBadge('off')
}

function startLive() {
  if (!authReady) return
  wsShouldReconnect = true
  if (!ws || ws.readyState === WebSocket.CLOSED) connectWS()
  fetchStatus()
  loadDecisions()
  renderSettings()
}

function handleUnauthorized(showToast = false) {
  authReady = false
  stopLive()
  showAuthOverlay(true, 'Session expired. Sign in again.')
  renderSettings()
  if (showToast) toast('Session expired', 'warn')
}

async function checkAuth() {
  try {
    const d = await apiFetch('/api/auth/status')
    authReady = !!d.authenticated
    if (authReady) {
      showAuthOverlay(false)
      startLive()
    } else {
      showAuthOverlay(true, 'Enter dashboard password to unlock the dashboard.')
      renderSettings()
    }
  } catch {
    authReady = false
    showAuthOverlay(true, 'Unable to verify session. Sign in again.')
    renderSettings()
  }
}

async function login() {
  const input = $('login-password')
  const password = input?.value || ''
  if (!password) {
    updateAuthMessage('Password wajib diisi.', true)
    return
  }
  try {
    await apiFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    authReady = true
    if (input) input.value = ''
    showAuthOverlay(false)
    updateAuthMessage('')
    startLive()
    toast('Login berhasil')
  } catch (e) {
    updateAuthMessage('Login gagal: ' + e.message, true)
  }
}

async function logout() {
  try { await apiFetch('/api/logout', { method: 'POST' }) } catch {}
  authReady = false
  stopLive()
  showAuthOverlay(true, 'Anda sudah logout.')
  renderSettings()
  toast('Logged out')
}

async function ctrl(action, extra = {}) {
  try {
    const data = await apiFetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    })
    if (data.state) syncState(data.state)
    renderAll()
  } catch (e) { toast('Error: ' + e.message, 'warn') }
}

function toggleAuto()  { ctrl('toggle_auto') }
function triggerScan() { apiFetch('/api/scan/trigger', { method: 'POST' }).catch(() => {}) }
function setMode(m)    { ctrl('set_mode', { mode: m }) }

async function fetchStatus() {
  if (!authReady) return
  try {
    const d = await apiFetch('/api/status')
    syncState(d)
    renderAll()
  } catch {}
}

async function loadDecisions() {
  if (!authReady) return
  try { DECISIONS = sanitizeDeep(await apiFetch('/api/decisions')) } catch { return }
  renderDecisions()
}

// ── State Sync ──────────────────────────────────────────────────────────
function syncState(d = {}) {
  const safe = sanitizeDeep(d)
  if (safe.portfolio)                      S.portfolio     = safe.portfolio
  if (safe.positions)                      S.positions     = safe.positions
  if (safe.mode)                           S.mode          = safe.mode
  if (safe.status)                         S.status        = safe.status
  if (safe.auto_trading !== undefined)     S.auto_trading  = safe.auto_trading
  if (safe.kill_switch  !== undefined)     S.kill_switch   = safe.kill_switch
  if (safe.market_regime)                  S.market_regime = safe.market_regime
  if (safe.macro)                          MACRO           = safe.macro
  if (safe.ai_state)                       AI_STATE        = safe.ai_state
  if (safe.memory)                         MEMORY          = safe.memory
  if (safe.scan_results)                   S.scan_results  = safe.scan_results
  if (safe.binance)                        S.binance       = safe.binance
  if (safe.last_prices)                    S.last_prices   = safe.last_prices
  if (safe.last_scan_at)                   S.last_scan_at  = safe.last_scan_at
}

// ── WebSocket (with reconnect) ──────────────────────────────────────────
let ws = null
let wsConnected = false
let wsRetries   = 0

function connectWS() {
  if (!authReady) return
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}`)

    ws.onopen = () => {
      wsConnected = true
      wsRetries = 0
      updateWsBadge('on')
      ws.send(JSON.stringify({ type: 'ping' }))
    }

    ws.onmessage = (e) => {
      try {
        const d = sanitizeDeep(JSON.parse(e.data))
        switch (d.type) {
          case 'connected':
          case 'state_update':
          case 'scan_complete':
            syncState(d)
            renderAll()
            break
          case 'prices':
            updatePrices(d.prices)
            break
          case 'trade_opened':
          case 'trade_closed':
            syncState(d)
            renderAll()
            toast((d.type === 'trade_opened' ? '📈 ' : '✅ ') + (d.trade?.sym || '') + ' ' + (d.trade?.strat_name || ''))
            break
          case 'positions_update':
            if (d.portfolio) S.portfolio = d.portfolio
            if (d.positions) S.positions = d.positions
            renderPositionsPage()
            break
          case 'memory_update':
            MEMORY = d.memory || {}
            break
          case 'btc_dca':
            if (d.portfolio) S.portfolio = d.portfolio
            renderBtcPanels()
            break
          case 'scan_started':
            if ($('status-badge')) $('status-badge').textContent = 'SCANNING'
            break
          case 'pong':
            break
        }
      } catch {}
    }

    ws.onclose = (event) => {
      wsConnected = false
      ws = null
      if (event?.code === 4401 || event?.code === 1008) {
        handleUnauthorized(false)
        return
      }
      if (!authReady || !wsShouldReconnect) {
        updateWsBadge('off')
        return
      }
      wsRetries++
      const delay = Math.min(3000 * wsRetries, 30000)
      updateWsBadge('retry')
      setTimeout(connectWS, delay)
    }

    ws.onerror = () => {
      wsConnected = false
      if (!authReady) updateWsBadge('off')
    }
  } catch {
    if (authReady && wsShouldReconnect) setTimeout(connectWS, 5000)
  }
}

function updateWsBadge(s) {
  const el = $('ws-badge'); if (!el) return
  el.className = 'badge ' + (s === 'on' ? 'ws-on' : 'ws-off')
  el.textContent = s === 'on' ? 'WS ON' : s === 'retry' ? 'WS RETRY' : 'WS OFF'
}

function updatePrices(prices = {}) {
  if (S.positions) S.positions.forEach(p => { if (p.status === 'open' && prices[p.sym]) p.current = prices[p.sym] })
  renderTicker(prices)
}

function renderTicker(prices = {}) {
  const items = Object.entries(prices).slice(0, 12)
  if (!items.length) return
  setH('ticker-bar', items.map(([s, p]) =>
    `<div class="ticker-item"><span style="color:var(--t3)">${s.replace('USDT', '')}</span><span style="color:var(--t1)">$${fmtPrice(p)}</span></div>`
  ).join(''))
}

// ── Render All ─────────────────────────────────────────────────────────
function renderAll() {
  renderBadges()
  renderDashboard()
  renderPortfolio()
  renderBtcPanels()
  if ($('page-positions')?.classList.contains('active'))  renderPositionsPage()
  if ($('page-scanner')?.classList.contains('active'))    renderScanner()
  if ($('page-settings')?.classList.contains('active'))   renderSettings()
}

// ── Badges ──────────────────────────────────────────────────────────────
function renderBadges() {
  const m = S.mode || 'paper', st = S.status || 'idle'
  const modeLabels = { paper: 'PAPER', analysis: 'ANALYSIS', safe: 'SAFE', live_testnet: 'LIVE DEMO', live_mainnet: 'LIVE MAINNET' }
  const mb = $('mode-badge')
  if (mb) { mb.textContent = modeLabels[m] || m.toUpperCase(); mb.className = 'badge ' + (m.startsWith('live') ? 'b-red' : 'b-lime') }
  const sb = $('status-badge')
  if (sb) { sb.textContent = st.toUpperCase(); sb.className = 'badge ' + (st === 'scanning' ? 'b-warn' : st === 'ready' ? 'b-lime' : 'b-muted') }
  const ab = $('auto-btn')
  if (ab) { ab.textContent = S.auto_trading ? '⏸ AUTO' : '▶ AUTO'; ab.className = 'btn btn-sm ' + (S.auto_trading ? 'btn-r' : 'btn-g') }
  const kb = $('kill-btn')
  if (kb) kb.className = 'btn btn-sm ' + (S.kill_switch ? 'btn-warn' : 'btn-r')
}

// ── Dashboard ───────────────────────────────────────────────────────────
function renderDashboard() {
  const p  = S.portfolio || {}
  const dd = (p.drawdown || 0) * 100
  const openPos = (S.positions || []).filter(p => p.status === 'open')

  setH('dash-stats', [
    { l: 'EQUITY',    v: `$${fd(p.equity)}`,              s: `Peak $${fd(p.peak)}`,          cls: '' },
    { l: 'TODAY P&L', v: `${(p.pnl_today || 0) >= 0 ? '+' : ''}$${fd(p.pnl_today)}`, s: `Total $${fd(p.pnl_total)}`, cls: (p.pnl_today || 0) >= 0 ? 'bull' : 'bear' },
    { l: 'DRAWDOWN',  v: `${fd(dd)}%`,                    s: `Streak:${p.loss_streak || 0}`, cls: dd > 10 ? 'bear' : dd > 5 ? 'warn' : '' },
    { l: 'BTC STACK', v: `${(p.btc_stack || 0).toFixed(6)}`, s: `Avg $${fd(p.btc_avg)}`,    cls: 'gold' },
    { l: 'POSITIONS', v: openPos.length,                  s: 'Max 8',                        cls: '' },
    { l: 'WIN RATE',  v: `${((MEMORY.win_rate || 0.5) * 100).toFixed(0)}%`, s: `${MEMORY.total_trades || 0} trades`, cls: (MEMORY.win_rate || 0.5) > 0.55 ? 'bull' : 'warn' },
  ].map(({ l, v, s, cls }) =>
    `<div class="stat"><div class="sl">${l}</div><div class="sv ${cls}">${v}</div><div class="ss">${s}</div></div>`
  ).join(''))

  // Signals
  const scans = Object.entries(S.scan_results || {})
    .filter(([, s]) => s.has_signal)
    .sort((a, b) => (b[1].best?.score || 0) - (a[1].best?.score || 0))
    .slice(0, 8)

  if (scans.length) {
    setH('signals-list', scans.map(([sym, s]) => `
      <div class="signal-row">
        <div style="width:80px;font-family:var(--disp);font-weight:700">${sym.replace('USDT', '')}</div>
        ${regimeBadge(s.regime?.regime)}
        <div style="flex:1">
          <div style="font-size:11px">${s.best?.name || '-'}</div>
          <div style="color:var(--t3);font-size:9px">${(s.best?.factors || []).slice(0, 2).join(' · ')}</div>
        </div>
        ${confBar(s.best?.score || 0)}
        <span style="color:var(--t3);font-size:10px">$${fmtPrice(s.price)}</span>
      </div>`).join(''))
  } else {
    setH('signals-list', '<div style="text-align:center;padding:24px;color:var(--t3)">No signals — click ⚡ SCAN</div>')
  }

  if (S.last_scan_at) setH('scan-time', new Date(S.last_scan_at).toLocaleTimeString())

  // AI Status
  setH('ai-status-panel', [
    ['Status',       `<span class="${AI_STATE.status === 'ok' ? 'lime' : 'warn'}">${AI_STATE.status || 'idle'}</span>`],
    ['Last Provider', `<span class="cyan">${AI_STATE.last_provider || '-'}</span>`],
    ['Latency',      `${AI_STATE.last_latency_ms || 0}ms`],
    ['Calls',        `${AI_STATE.calls_success || 0}✓ ${AI_STATE.calls_failed || 0}✗`],
    ['Available',    (AI_STATE.provider_list || []).join(', ') || 'none'],
  ].map(([k, v]) => `<div class="metric-row"><span>${k}</span><span>${v}</span></div>`).join(''))
  setH('ai-provider-badge', AI_STATE.last_provider || 'AI')

  // Macro
  const fg = MACRO.fear_greed || 50
  const fgColor = fg < 25 ? 'var(--bear)' : fg < 40 ? 'var(--warn)' : fg > 85 ? 'var(--bear)' : fg > 75 ? 'var(--warn)' : 'var(--bull)'
  setH('macro-panel', [
    ['Fear & Greed', `<span style="color:${fgColor};font-weight:700">${fg} — ${MACRO.fear_greed_label || '?'}</span>`],
    ['BTC Dominance', `${fd(MACRO.dominance, 1)}%`],
    ['BTC Funding',   `<span class="${(MACRO.btc_funding || 0) > 0.001 ? 'warn' : ''}">${((MACRO.btc_funding || 0) * 100).toFixed(4)}%</span>`],
    ['Trending',      `<span style="color:var(--t3);font-size:10px">${(MACRO.trending_coins || []).slice(0, 5).join(', ') || '-'}</span>`],
    ['Updated',       `<span style="color:var(--t3);font-size:10px">${MACRO.updated_at ? new Date(MACRO.updated_at).toLocaleTimeString() : '-'}</span>`],
  ].map(([k, v]) => `<div class="metric-row"><span>${k}</span><span>${v}</span></div>`).join(''))

  // Regime
  const regCounts = {}
  Object.values(S.scan_results || {}).forEach(r => { const n = r.regime?.regime || '?'; regCounts[n] = (regCounts[n] || 0) + 1 })
  setH('regime-panel', `
    <div class="mb3">${regimeBadge(S.market_regime || 'unknown')} <span style="color:var(--t2);font-size:11px"> Dominant regime</span></div>
    ${Object.entries(regCounts).map(([r, c]) => `<div class="metric-row"><span>${r}</span><span>${c} pairs</span></div>`).join('')}`)

  // Open positions (dashboard)
  setH('pos-count', openPos.length + ' open')
  setH('dash-positions', openPos.length
    ? openPos.map(p => renderPosCard(p, false)).join('')
    : '<div style="color:var(--t3);text-align:center;padding:16px">No open positions</div>')
}

// ── Positions Page ──────────────────────────────────────────────────────
function renderPositionsPage() {
  const openPos = (S.positions || []).filter(p => p.status === 'open')
  setH('positions-list', openPos.length
    ? openPos.map(p => renderPosCard(p, true)).join('')
    : '<div class="card" style="text-align:center;padding:32px;color:var(--t3)">No open positions</div>')
}

function renderPosCard(p, detailed = false) {
  const pnl  = p.pnl_usdt || 0
  const pnlC = pnl >= 0 ? 'bull' : 'bear'
  if (!detailed) return `
    <div class="pos-card">
      <div class="flex jb ac">
        <div><span style="font-family:var(--disp);font-weight:700">${p.sym.replace('USDT', '')}</span>
          <span style="color:var(--t3);font-size:10px"> ${p.strat_name}</span>
          ${p.ai_verdict ? aiBadge(p.ai_verdict) : ''}
        </div>
        <span class="${pnlC}">${pnl >= 0 ? '+' : ''}$${fd(pnl)}</span>
      </div>
      <div class="flex ac gap8" style="margin-top:6px;font-size:10px;color:var(--t3)">
        <span>Entry $${fmtPrice(p.fill)}</span><span>Mark $${fmtPrice(p.current)}</span>
        <span>SL $${fmtPrice(p.sl)}</span><span>TP1 $${fmtPrice(p.tp1)}</span>
        ${p.tp1_hit ? badge('TP1✓', 'b-lime') : ''}${p.runner_active ? badge('TRAIL', 'b-cyan') : ''}
      </div>
    </div>`
  return `
    <div class="card mb4">
      <div class="flex jb ac mb3">
        <div class="flex ac gap8">
          <span style="font-family:var(--disp);font-weight:800;font-size:16px">${p.sym.replace('USDT', '')}</span>
          <span style="color:var(--t3);font-size:11px">${p.strat_name}</span>
          ${regimeBadge(p.regime)}
          ${p.ai_verdict ? aiBadge(p.ai_verdict) : ''}
        </div>
        <div class="flex ac gap8">
          <span class="${pnlC}" style="font-size:14px;font-weight:700">${pnl >= 0 ? '+' : ''}$${fd(pnl)} (${fd(p.pnl_pct)}%)</span>
          <button class="btn btn-r btn-sm" onclick="closePos('${p.id}')">✕ Close</button>
        </div>
      </div>
      <div class="grid4" style="font-size:10px;color:var(--t3)">
        <div><div>Entry</div><div style="color:var(--t1)">$${fmtPrice(p.fill)}</div></div>
        <div><div>Mark</div><div style="color:var(--t1)">$${fmtPrice(p.current)}</div></div>
        <div><div>Stop Loss</div><div style="color:var(--red)">$${fmtPrice(p.sl)}</div></div>
        <div><div>TP Runner</div><div style="color:var(--lime)">$${fmtPrice(p.tp)}</div></div>
      </div>
      <div class="flex ac gap8" style="margin-top:8px">
        ${p.tp1_hit ? badge('TP1 HIT', 'b-lime') : ''}
        ${p.runner_active ? badge('TRAILING', 'b-cyan') : ''}
        ${p.trail_price ? `<span style="font-size:10px;color:var(--t3)">Trail $${fmtPrice(p.trail_price)}</span>` : ''}
        <span style="font-size:10px;color:var(--t3)">${p.execution_mode === 'live' ? '🔴 LIVE' : '📄 PAPER'}</span>
        ${p.ai_reasoning ? `<span style="font-size:9px;color:var(--t3);font-style:italic">"${p.ai_reasoning}"</span>` : ''}
      </div>
    </div>`
}

function closePos(id) {
  if (confirm('Close position?')) ctrl('close_position', { id })
}

// ── Scanner ─────────────────────────────────────────────────────────────
function renderScanner() {
  const scans = Object.entries(S.scan_results || {}).sort((a, b) => (b[1].best?.score || 0) - (a[1].best?.score || 0))
  if (!scans.length) { setH('scanner-grid', '<div style="color:var(--t3);text-align:center;padding:32px">Run a scan first</div>'); return }
  setH('scanner-grid', `<div class="grid3">${scans.map(([sym, s]) => {
    const best = s.best || {}, conf = best.score || 0
    return `<div class="card ${conf > 0.70 ? 'card-lime' : conf > 0.60 ? 'card-cyan' : ''}">
      <div class="flex jb ac mb3">
        <div><span style="font-family:var(--disp);font-weight:800;font-size:14px">${sym.replace('USDT', '')}</span></div>
        ${regimeBadge(s.regime?.regime)}
      </div>
      <div class="flex jb" style="font-size:11px;margin-bottom:8px">
        <span>$${fmtPrice(s.price)}</span> ${pct(s.change_24h)}
      </div>
      ${best.name
        ? `<div style="font-size:11px;margin-bottom:4px">${best.name} ${confBar(conf)}</div>`
        : '<div style="color:var(--t3);font-size:10px">No signal</div>'}
      ${s.conflict?.has_conflict ? badge('⚠ CONFLICT', 'b-warn') : ''}
      <div style="color:var(--t3);font-size:9px;margin-top:6px">${(best.factors || []).slice(0, 2).join(' · ')}</div>
    </div>`
  }).join('')}</div>`)
}

// ── Portfolio ────────────────────────────────────────────────────────────
function renderPortfolio() {
  const p = S.portfolio || {}
  setH('portfolio-overview', [
    ['Equity',        `<span style="font-family:var(--disp);font-weight:700">$${fd(p.equity)}</span>`],
    ['Peak',          `$${fd(p.peak)}`],
    ['PnL Today',     `<span class="${(p.pnl_today || 0) >= 0 ? 'bull' : 'bear'}">${(p.pnl_today || 0) >= 0 ? '+' : ''}$${fd(p.pnl_today)}</span>`],
    ['PnL Total',     `$${fd(p.pnl_total)}`],
    ['Drawdown',      `<span class="${(p.drawdown || 0) > 0.1 ? 'bear' : ''}">${((p.drawdown || 0) * 100).toFixed(2)}%</span>`],
    ['Loss Streak',   p.loss_streak || 0],
    ['Cooldown',      p.cooldown ? badge('ACTIVE', 'b-warn') : badge('OK', 'b-lime')],
    ['Risk Off',      p.risk_off ? badge('YES', 'b-red') : badge('NO', 'b-lime')],
  ].map(([k, v]) => `<div class="metric-row"><span>${k}</span><span>${v}</span></div>`).join(''))

  setH('alloc-detail', [
    ['BTC Bucket',  `$${fd(p.btc_bucket_used)} / $${fd(p.btc_bucket_total)}`],
    ['Alt Bucket',  `$${fd(p.alt_bucket_used)} / $${fd(p.alt_bucket_total)}`],
    ['UM Bucket',   `$${fd(p.um_bucket_used)} / $${fd(p.um_bucket_total)}`],
  ].map(([k, v]) => `<div class="metric-row"><span>${k}</span><span>${v}</span></div>`).join(''))
}

// ── BTC Panels ───────────────────────────────────────────────────────────
function renderBtcPanels() {
  const p        = S.portfolio || {}
  const btcPrice = S.last_prices?.BTCUSDT || 67000
  const vaultVal = (p.btc_stack || 0) * btcPrice
  const unrealized = vaultVal - (p.btc_cost_basis || 0)

  setH('btc-mini-panel', [
    ['BTC Stack',      `<span class="gold">${(p.btc_stack || 0).toFixed(8)} BTC</span>`],
    ['Vault Value',    `$${fd(vaultVal)}`],
    ['Avg Cost',       `$${fd(p.btc_avg)}`],
    ['Total Invested', `$${fd(p.btc_cost_basis)}`],
  ].map(([k, v]) => `<div class="metric-row"><span>${k}</span><span>${v}</span></div>`).join(''))

  setH('btc-vault-panel', `
    <div class="stats-row">
      <div class="stat"><div class="sl">STACK</div><div class="sv gold">${(p.btc_stack || 0).toFixed(6)} BTC</div></div>
      <div class="stat"><div class="sl">VAULT VALUE</div><div class="sv">$${fd(vaultVal)}</div></div>
      <div class="stat"><div class="sl">AVG COST</div><div class="sv">$${fd(p.btc_avg)}</div></div>
      <div class="stat"><div class="sl">UNREALIZED</div><div class="sv ${unrealized >= 0 ? 'bull' : 'bear'}">${unrealized >= 0 ? '+' : ''}$${fd(unrealized)}</div></div>
    </div>`)

  const fg     = MACRO.fear_greed || 50
  const fgMult = fg < 25 ? '2.0x' : fg < 35 ? '1.8x' : fg < 50 ? '1.3x' : fg > 85 ? 'SKIP' : fg > 75 ? '0.5x' : '1.0x'
  setH('dca-panel', [
    ['Fear & Greed', `${fg} — ${MACRO.fear_greed_label || '?'}`],
    ['DCA Multiplier', `<span class="cyan">${fgMult}</span>`],
    ['DCA Base', `2% equity = $${fd((p.equity || 0) * 0.02)}`],
    ['BTC Dominance', `${fd(MACRO.dominance, 1)}%`],
    ['Regime', regimeBadge(S.market_regime)],
  ].map(([k, v]) => `<div class="metric-row"><span>${k}</span><span>${v}</span></div>`).join(''))
}

// ── Memory ───────────────────────────────────────────────────────────────
function renderMemory() {
  setH('memory-stats', [
    ['Win Rate',    `<span class="${(MEMORY.win_rate || 0.5) > 0.55 ? 'bull' : 'warn'}">${((MEMORY.win_rate || 0.5) * 100).toFixed(1)}%</span>`],
    ['Avg R:R',     fd(MEMORY.avg_rr, 2)],
    ['Total Trades', MEMORY.total_trades || 0],
    ['Updated',     `<span style="color:var(--t3);font-size:10px">${MEMORY.updated_at ? new Date(MEMORY.updated_at).toLocaleTimeString() : '-'}</span>`],
  ].map(([k, v]) => `<div class="metric-row"><span>${k}</span><span>${v}</span></div>`).join(''))

  setH('memory-patterns', `
    <div class="metric-row"><span>Loss Pattern</span><span style="color:var(--warn);font-size:10px">${MEMORY.recent_loss_pattern || 'none'}</span></div>
    ${(MEMORY.lessons || []).map(l =>
      `<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:10px;color:var(--t3)">${l.sym} ${l.strat} ${l.regime} $${fd(l.pnl)} AI:${l.ai || '-'}</div>`
    ).join('')}`)

  const stats = Object.entries(MEMORY.strategy_stats || {}).sort((a, b) => (b[1].win_rate || 0) - (a[1].win_rate || 0)).slice(0, 12)
  setH('strategy-perf', `
    <table class="tbl">
      <thead><tr><th>Strategy</th><th>Win Rate</th><th>Trades</th><th>Avg PnL</th></tr></thead>
      <tbody>${stats.map(([id, s]) =>
        `<tr>
          <td>${id}</td>
          <td class="${(s.win_rate || 0) > 0.55 ? 'bull' : 'warn'}">${((s.win_rate || 0) * 100).toFixed(0)}%</td>
          <td>${s.count || 0}</td>
          <td class="${(s.avg_pnl || 0) >= 0 ? 'bull' : 'bear'}">${(s.avg_pnl || 0) >= 0 ? '+' : ''}$${fd(s.avg_pnl)}</td>
        </tr>`
      ).join('')}</tbody>
    </table>`)
}

// ── AI Decisions ──────────────────────────────────────────────────────────
function renderDecisions() {
  setH('ai-log-list', DECISIONS.slice(0, 100).map(d => `
    <div class="pos-card" style="margin-bottom:6px">
      <div class="flex jb ac">
        <div class="flex ac gap8">
          <span style="font-weight:700">${d.sym}</span>
          <span style="color:var(--t3);font-size:10px">${d.action}</span>
          ${d.ai || d.verdict ? aiBadge(d.ai || d.verdict) : ''}
        </div>
        <span style="color:var(--t3);font-size:9px">${d.ts ? new Date(d.ts).toLocaleTimeString() : ''}</span>
      </div>
      ${d.reason ? `<div style="color:var(--t3);font-size:10px;margin-top:4px">${d.reason}</div>` : ''}
      ${d.ai_reasoning ? `<div style="color:var(--lime);font-size:9px;margin-top:2px;font-style:italic">"${d.ai_reasoning}"</div>` : ''}
    </div>`).join(''))
}

// ── Settings ───────────────────────────────────────────────────────────────
function renderSettings() {
  const b = S.binance || {}
  setH('binance-settings-card', [
    ['Status', `<span class="${b.status === 'ready' ? 'lime' : 'warn'}">${b.status || 'off'}</span>`],
    ...(b.spot ? [['Spot USDT', `$${fd(b.spot.usdt)}`], ['Spot BTC', (b.spot.btc || 0).toFixed(6)]] : []),
    ...(b.um   ? [['UM Balance', `$${fd(b.um.walletBalance)}`]] : []),
  ].map(([k, v]) => `<div class="metric-row"><span>${k}</span><span>${v}</span></div>`).join(''))

  const available = (AI_STATE.provider_list || [])
  const allLabels = ['Qwen Local', 'Groq', 'OpenRouter', 'Gemini', 'OpenAI']
  setH('ai-providers-panel', allLabels.map(p =>
    available.includes(p)
      ? `<div class="metric-row"><span>${p}</span><span class="lime">✓ Available</span></div>`
      : `<div class="metric-row"><span>${p}</span><span style="color:var(--t3)">No key</span></div>`
  ).join(''))

  document.querySelectorAll('.mode-btns .btn').forEach(btn => btn.classList.remove('btn-g'))
  const activeMode = document.querySelector(`#mode-btn-${S.mode}`)
  if (activeMode) activeMode.classList.add('btn-g')
  setT('auth-session-status', authReady ? 'Authenticated' : 'Locked')
}

// ── Toast ────────────────────────────────────────────────────────────────
function toast(msg, kind = 'info', ms = 3000) {
  const el = document.createElement('div')
  el.className = `toast toast-${kind}`
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), ms)
}

// ── Boot ──────────────────────────────────────────────────────────────────
$('login-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') login() })
checkAuth()
setInterval(() => { if (authReady) fetchStatus() }, 30000)
document.addEventListener('visibilitychange', () => { if (!document.hidden && authReady) fetchStatus() })
renderSettings()
