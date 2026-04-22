#!/usr/bin/env node
/**
 * MIUX AI TRADING BOT v4.0 — Refactored Edition
 * server.js — secured API + UI server
 */
'use strict'

const crypto  = require('crypto')
const express = require('express')
const cors    = require('cors')
const http    = require('http')
const WS      = require('ws')
const path    = require('path')

const { CFG, normalizeMode, isLiveMode, getModeLabel } = require('./core/config')
const { STATE, MEMORY, MACRO, readJ, appendLog, setWss, getClientState, saveRuntime, broadcast } = require('./core/state')
const { AI_STATE, AI_PROVIDERS } = require('./core/ai')
const { closeHttpClients, getHttpStats, settleMapLimit } = require('./core/http')
const { STRATEGIES } = require('./core/strategy')
const { getRisk } = require('./core/risk')
const { runScan, runBtcDcaWeekly, updateMemory, runBinanceBootstrap, manageClosePosition, scanning, updatePnL } = require('./core/execution')
const { updateMacro, getPrice } = require('./core/market')

const SESSION_COOKIE = 'miux_sid'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

function normalizeOriginValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}`.toLowerCase()
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase()
  }
}

function getRequestOrigin(req) {
  const host = String(req.headers.host || '').trim()
  if (!host) return ''
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  const proto = forwardedProto || (req.socket && req.socket.encrypted ? 'https' : 'http')
  return normalizeOriginValue(`${proto}://${host}`)
}

function secureCompare(a, b) {
  const aa = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  if (aa.length !== bb.length) return false
  try { return crypto.timingSafeEqual(aa, bb) } catch { return false }
}

function parseCookies(header = '') {
  const out = {}
  String(header || '').split(';').forEach(part => {
    const idx = part.indexOf('=')
    if (idx <= 0) return
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (!key) return
    try { out[key] = decodeURIComponent(val) } catch { out[key] = val }
  })
  return out
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', CFG.SESSION_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verifySessionToken(token) {
  try {
    const [body, sig] = String(token || '').split('.')
    if (!body || !sig) return null
    const expected = crypto.createHmac('sha256', CFG.SESSION_SECRET).update(body).digest('base64url')
    if (!secureCompare(sig, expected)) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload?.exp || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

function getSessionFromReq(req) {
  const cookies = parseCookies(req.headers.cookie || '')
  const authHeader = String(req.headers.authorization || '')
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : ''
  return verifySessionToken(cookies[SESSION_COOKIE] || bearer)
}

function setSessionCookie(req, res, payload) {
  const token = signSession(payload)
  const cookie = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase()
  if (req.secure || proto === 'https') cookie.push('Secure')
  res.setHeader('Set-Cookie', cookie.join('; '))
  return token
}

function clearSessionCookie(req, res) {
  const cookie = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ]
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase()
  if (req.secure || proto === 'https') cookie.push('Secure')
  res.setHeader('Set-Cookie', cookie.join('; '))
}

function requireAuth(req, res, next) {
  const session = getSessionFromReq(req)
  if (session) {
    req.session = session
    return next()
  }
  res.status(401).json({ error: 'Unauthorized' })
}

const app = express()

const allowedOrigins = new Set(
  String(CFG.DASHBOARD_ORIGIN || '')
    .split(',')
    .map(s => normalizeOriginValue(s))
    .filter(Boolean)
)
if (allowedOrigins.size) {
  app.use(cors((req, cb) => {
    const origin = normalizeOriginValue(req.headers.origin || '')
    const requestOrigin = getRequestOrigin(req)
    if (!origin || origin === requestOrigin || allowedOrigins.has(origin)) {
      return cb(null, { origin: origin || true, credentials: true })
    }
    const err = new Error(`Origin not allowed: ${origin}`)
    err.status = 403
    return cb(err)
  }))
}

app.use(express.json({ limit: '2mb' }))
app.use((err, req, res, next) => {
  if (!err) return next()
  if (/^Origin not allowed:/i.test(String(err.message || ''))) {
    return res.status(err.status || 403).json({ ok: false, error: err.message })
  }
  return next(err)
})
app.use((_, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'")
  next()
})
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: STATE.mode, status: STATE.status, uptime: process.uptime(), auth_required: true })
})

app.get('/api/auth/status', (req, res) => {
  const session = getSessionFromReq(req)
  res.json({ authenticated: !!session, expires_at: session?.exp || null })
})

app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '')
  if (!secureCompare(password, CFG.PASSWORD)) {
    clearSessionCookie(req, res)
    return res.status(401).json({ ok: false, error: 'Invalid credentials' })
  }
  const payload = {
    sub: 'dashboard',
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomBytes(8).toString('hex'),
  }
  setSessionCookie(req, res, payload)
  appendLog(`[Auth] Login success from ${req.ip || 'unknown-ip'}`)
  res.json({ ok: true, expires_at: payload.exp })
})

app.post('/api/logout', (req, res) => {
  clearSessionCookie(req, res)
  res.json({ ok: true })
})

app.use('/api', requireAuth)

app.get('/api/status', (req, res) => res.json({ ...getClientState(), http_stats: getHttpStats() }))

app.get('/api/portfolio', (req, res) => res.json({
  portfolio: STATE.portfolio,
  positions: Object.values(STATE.positions),
  risk: getRisk(),
}))

app.get('/api/positions', (req, res) =>
  res.json(Object.values(STATE.positions).filter(p => p.status === 'open')))

app.get('/api/signals', (req, res) => {
  const signals = Object.entries(STATE.scan_results || {})
    .filter(([, s]) => s.has_signal)
    .sort((a, b) => (b[1].best?.score || 0) - (a[1].best?.score || 0))
    .map(([sym, s]) => ({
      sym, price: s.price, change_24h: s.change_24h,
      regime: s.regime, best: s.best, top3: s.top3,
      conflict: s.conflict, actionable: s.actionable,
    }))
  res.json({ signals, total: Object.keys(STATE.scan_results || {}).length, last_scan_at: STATE.last_scan_at })
})

app.get('/api/memory', (req, res) => res.json(MEMORY))

app.get('/api/ai-status', (req, res) => res.json({
  ...AI_STATE,
  providers: AI_PROVIDERS.map(p => ({ id: p.id, label: p.label, available: p.isAvailable() })),
}))

app.get('/api/macro', (req, res) => res.json(MACRO))
app.get('/api/scan', (req, res) => res.json(STATE.scan_results))
app.get('/api/decisions', (req, res) => res.json(readJ('decisions.json', []).slice(0, 200)))

app.get('/api/debug/http', (req, res) => res.json(getHttpStats()))

app.get('/api/history', (req, res) => {
  const { months = 1, symbol, strategy } = req.query
  const trades = []
  for (let m = 0; m < Math.min(parseInt(months, 10) || 1, 12); m++) {
    const d = new Date()
    d.setMonth(d.getMonth() - m)
    trades.push(...readJ(`history/trades_${d.toISOString().slice(0, 7).replace('-', '_')}.json`, []))
  }
  let result = trades.sort((a, b) => (b.closed_at || '').localeCompare(a.closed_at || ''))
  if (symbol) result = result.filter(t => t.sym === symbol)
  if (strategy) result = result.filter(t => t.strat_id === strategy)
  res.json(result.slice(0, 300))
})

app.get('/api/strategies', (req, res) => res.json(
  Object.entries(STRATEGIES).map(([id, s]) => ({
    id, name: s.name, type: s.type, tf: s.tf, min_conf: s.min_conf, color: s.color,
    stats: MEMORY.strategy_stats?.[id] || {},
  }))
))

app.get('/api/binance/health', (req, res) => res.json(STATE.binance || { status: 'off' }))

app.post('/api/scan/trigger', async (req, res) => {
  if (scanning()) return res.json({ ok: false, reason: 'Already scanning' })
  runScan().catch(e => appendLog('[Scan Error] ' + e.message))
  res.json({ ok: true, started_at: new Date().toISOString() })
})

app.post('/api/control', async (req, res) => {
  const { action, ...extra } = req.body || {}

  if (action === 'set_mode') {
    const m = normalizeMode(extra.mode || 'paper')
    STATE.mode = m
    appendLog(`[Mode] → ${m}`)
    await runBinanceBootstrap().catch(e => appendLog('[Bootstrap] ' + e.message))

  } else if (action === 'toggle_kill') {
    STATE.kill_switch = !STATE.kill_switch
    appendLog(`[Kill Switch] → ${STATE.kill_switch}`)

  } else if (action === 'toggle_auto') {
    STATE.auto_trading = !STATE.auto_trading
    appendLog(`[Auto Trading] → ${STATE.auto_trading}`)

  } else if (action === 'reset_cooldown') {
    Object.assign(STATE.portfolio, { cooldown: false, cooldown_until: null, loss_streak: 0, risk_off: false })
    appendLog('[Risk] Cooldown reset')

  } else if (action === 'trigger_learning') {
    updateMemory()

  } else if (action === 'trigger_dca') {
    await runBtcDcaWeekly().catch(e => appendLog('[DCA] ' + e.message))

  } else if (action === 'update_macro') {
    await updateMacro().catch(e => appendLog('[Macro] ' + e.message))

  } else if (action === 'binance_sync') {
    await runBinanceBootstrap().catch(e => appendLog('[Bootstrap] ' + e.message))

  } else if (action === 'close_position') {
    await manageClosePosition(extra.id, 'manual_close')

  } else if (action === 'save_config' && Array.isArray(extra.symbols)) {
    CFG.SCAN_SYMBOLS.length = 0
    CFG.SCAN_SYMBOLS.push(...extra.symbols.map(s => String(s || '').toUpperCase()).filter(Boolean))
    appendLog('[Config] Symbols updated')

  } else {
    return res.status(400).json({ ok: false, error: 'Unknown action' })
  }

  saveRuntime()
  broadcast({ type: 'state_update', ...getClientState() })
  res.json({ ok: true, state: getClientState() })
})

const server = http.createServer(app)
const wss = new WS.Server({ server })
setWss(wss)

wss.on('connection', (ws, req) => {
  const session = getSessionFromReq(req)
  if (!session) {
    try { ws.close(4401, 'Unauthorized') } catch {}
    return
  }

  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  ws.send(JSON.stringify({ type: 'connected', ...getClientState() }))
  ws.on('message', (msg) => {
    try {
      const d = JSON.parse(msg)
      if (d.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
    } catch {}
  })
  ws.on('error', () => {})
})

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return }
    ws.isAlive = false
    try { ws.ping() } catch {}
  })
}, 30000)

function startScheduler() {
  setInterval(async () => {
    if (STATE.auto_trading || STATE.mode === 'analysis') {
      await runScan().catch(e => appendLog('[Scan] ' + e.message))
    }
  }, 90 * 1000)

  setInterval(updateMemory, 30 * 60 * 1000)
  setInterval(() => updateMacro().catch(e => appendLog('[Macro] ' + e.message)), 15 * 60 * 1000)

  setInterval(async () => {
    if (scanning()) return
    const prices = {}
    await settleMapLimit(CFG.SCAN_SYMBOLS.slice(0, 10), 4, async sym => {
      const p = await getPrice(sym)
      if (p) prices[sym] = p
    })
    if (Object.keys(prices).length) {
      Object.assign(STATE.last_prices, prices)
      broadcast({ type: 'prices', prices })
    }
    let changed = false
    for (const [id, pos] of Object.entries(STATE.positions)) {
      if (pos.status !== 'open') continue
      const p = prices[pos.sym]
      if (!p) continue
      const reason = updatePnL(pos, p)
      if (reason && STATE.mode !== 'analysis' && !STATE.kill_switch) {
        const closed = await manageClosePosition(id, reason, p)
        if (closed) changed = true
      }
    }
    if (changed) {
      broadcast({
        type: 'positions_update',
        positions: Object.values(STATE.positions).filter(p => p.status === 'open'),
        portfolio: STATE.portfolio,
      })
    }
  }, 5000)

  setInterval(() => { if (isLiveMode(STATE.mode)) runBinanceBootstrap().catch(() => {}) }, 5 * 60 * 1000)

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const lastDca = readJ('macro_cache.json', {}).last_btc_dca || 0
  const dueMs = Math.max(0, WEEK_MS - (Date.now() - lastDca))
  setTimeout(function runWeeklyDca() {
    runBtcDcaWeekly().catch(e => appendLog('[BTC DCA] ' + e.message))
    setInterval(() => runBtcDcaWeekly().catch(e => appendLog('[BTC DCA] ' + e.message)), WEEK_MS)
  }, dueMs)

  const now = new Date()
  const nextMidnightLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const msToMid = nextMidnightLocal - now
  setTimeout(() => {
    STATE.portfolio.pnl_today = 0
    STATE.portfolio.daily_loss = 0
    saveRuntime()
    broadcast({ type: 'daily_reset', portfolio: STATE.portfolio })
    setInterval(() => {
      STATE.portfolio.pnl_today = 0
      STATE.portfolio.daily_loss = 0
      saveRuntime()
    }, 24 * 60 * 60 * 1000)
  }, msToMid)

  appendLog('[Scheduler] Started — scan:90s macro:15m memory:30m prices:5s')
}

server.listen(CFG.PORT, CFG.HOST, async () => {
  console.log(`\n╔═══════════════════════════════════════════════╗`)
  console.log(`║  MIUX AI TRADING BOT v4.0 — Refactored       ║`)
  console.log(`║  Mode: ${getModeLabel(STATE.mode).padEnd(10)} | Port: ${CFG.PORT}             ║`)
  console.log(`║  UI:   http://localhost:${CFG.PORT}                ║`)
  console.log(`╚═══════════════════════════════════════════════╝\n`)
  if (CFG.PASSWORD_SOURCE === 'generated') {
    console.log(`[Auth] DASHBOARD_PASSWORD not set. Temporary password: ${CFG.PASSWORD}`)
  }
  appendLog(`[Start] mode=${STATE.mode} port=${CFG.PORT}`)
  updateMemory()
  await updateMacro()
  await runBinanceBootstrap().catch(e => appendLog('[Bootstrap] ' + e.message))
  startScheduler()
  setTimeout(() => runScan().catch(e => appendLog('[Initial Scan] ' + e.message)), 5000)
})

const warningCounts = new Map()
process.on('warning', warning => {
  if (!warning || warning.name !== 'MaxListenersExceededWarning') return
  const key = `${warning.name}|${warning.type || ''}|${warning.message || ''}`
  const seen = (warningCounts.get(key) || 0) + 1
  warningCounts.set(key, seen)
  if (seen > 3) return
  appendLog(`[Warning] ${warning.name} event=${warning.type || 'unknown'} count=${warning.count || '?'} ${warning.message}`)
})
process.on('SIGTERM', () => { closeHttpClients(); saveRuntime(); process.exit(0) })
process.on('SIGINT', () => { closeHttpClients(); saveRuntime(); process.exit(0) })
process.on('uncaughtException', e => appendLog('[UNCAUGHT] ' + e.message))
process.on('unhandledRejection', e => appendLog('[UNHANDLED] ' + (e?.message || e)))
