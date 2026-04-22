'use strict'
const { httpClient: axios } = require('./http')
const crypto = require('crypto')
const { CFG, isLiveMode, getBinanceEnv, isBinanceActive, getSpotBase, getFuturesBase, getSpotCreds, getUmCreds } = require('./config')
const { STATE, MEMORY, MACRO, readJ, writeJ, appendLog, broadcast, saveRuntime } = require('./state')
const { buildIndicators, classifyRegime, getMultiTF, getPrice, get24h } = require('./market')
const { runAllStrategies } = require('./strategy')
const { aiDecisionGate } = require('./ai')
const { getLedgerBucket, getBucketFree, reserveBucket, releaseBucket, getBtcPrice, checkAllowed, calcSize, calcAdaptiveTrailing } = require('./risk')

// ── Binance Signed HTTP ───────────────────────────────────────────────
function hmacSig(q, sec)  { return crypto.createHmac('sha256', sec).update(q).digest('hex') }
function buildQuery(p = {}) { return Object.entries({ ...p, timestamp: Date.now() }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') }

async function signedPost(base, path, params, key, sec, timeout = 15000) {
  const q = buildQuery(params), sig = hmacSig(q, sec)
  const r = await axios.post(`${base}${path}?${q}&signature=${sig}`, null, { headers: { 'X-MBX-APIKEY': key }, timeout })
  return r.data
}
async function signedGet(base, path, params, key, sec, timeout = 12000) {
  const q = buildQuery(params), sig = hmacSig(q, sec)
  const r = await axios.get(`${base}${path}?${q}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': key }, timeout })
  return r.data
}
async function publicGet(base, path, params = {}, timeout = 8000) {
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const r = await axios.get(`${base}${path}${q ? '?' + q : ''}`, { timeout })
  return r.data
}

function getRuntimeBinanceEnv() {
  return getBinanceEnv(STATE.mode)
}

function ensureCreds(creds, label) {
  if (!creds?.key || !creds?.sec) throw new Error(`Missing ${label} API credentials`)
}

function extractSpotFill(out, fallbackPrice = 0) {
  const fills = Array.isArray(out?.fills) ? out.fills : []
  if (fills.length) {
    let quote = 0
    let qty = 0
    for (const fill of fills) {
      const fp = parseFloat(fill?.price || 0)
      const fq = parseFloat(fill?.qty || 0)
      if (fp > 0 && fq > 0) {
        quote += fp * fq
        qty += fq
      }
    }
    if (quote > 0 && qty > 0) return quote / qty
  }
  const execQty = parseFloat(out?.executedQty || out?.origQty || 0)
  const quoteQty = parseFloat(out?.cummulativeQuoteQty || 0)
  if (execQty > 0 && quoteQty > 0) return quoteQty / execQty
  return parseFloat(out?.price || 0) || fallbackPrice
}

// ── Exchange Info Cache ───────────────────────────────────────────────
const EX_CACHE = { spot: { env: '', ts: 0, data: null }, um: { env: '', ts: 0, data: null } }
const floorStep = (v, step) => !step ? v : Math.floor(v / step) * step
const precFromStep = (step) => { if (!step) return 8; const s = step.toString(), d = s.indexOf('.'); return d < 0 ? 0 : s.length - d - 1 }
const fmtStep = (v, step) => Number(floorStep(v, step).toFixed(precFromStep(step)))
const nextCOID = (pfx = 'MIUX') => `${pfx}${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`

async function getSpotEx(env) {
  const c = EX_CACHE.spot
  if (c.env === env && Date.now() - c.ts < 300000 && c.data) return c.data
  const d = await publicGet(getSpotBase(env), '/api/v3/exchangeInfo', {}, 15000)
  Object.assign(c, { env, ts: Date.now(), data: d }); return d
}
async function getUmEx(env) {
  const c = EX_CACHE.um
  if (c.env === env && Date.now() - c.ts < 300000 && c.data) return c.data
  const d = await publicGet(getFuturesBase(env), '/fapi/v1/exchangeInfo', {}, 15000)
  Object.assign(c, { env, ts: Date.now(), data: d }); return d
}
const getSymInfo = (ex, sym) => ex?.symbols?.find(s => s.symbol === sym) || null
const getFilter  = (si, type) => si?.filters?.find(f => f.filterType === type) || null

// ── Live Order Execution ──────────────────────────────────────────────
async function placeLiveSpotOrder(sym, strat, price, usdt) {
  const env = getRuntimeBinanceEnv()
  if (env === 'off') throw new Error('Binance env is off')
  const creds = getSpotCreds(env)
  ensureCreds(creds, `${env} spot`)
  const ex = await getSpotEx(env)
  const si = getSymInfo(ex, sym)
  if (!si) throw new Error(`No symbol info: ${sym}`)
  const step = parseFloat(getFilter(si, 'LOT_SIZE')?.stepSize || '0.00001')
  const qty = fmtStep(usdt / price, step)
  const minNot = parseFloat(getFilter(si, 'NOTIONAL')?.minNotional || getFilter(si, 'MIN_NOTIONAL')?.minNotional || '5')
  if (qty <= 0) throw new Error(`Invalid quantity for ${sym}`)
  if (qty * price < minNot) throw new Error(`Below min notional ${minNot} USDT`)
  const out = await signedPost(getSpotBase(env), '/api/v3/order',
    {
      symbol: sym,
      side: 'BUY',
      type: 'MARKET',
      quantity: qty.toFixed(precFromStep(step)),
      newOrderRespType: 'FULL',
      newClientOrderId: nextCOID('SP'),
    },
    creds.key, creds.sec)
  const executedQty = parseFloat(out?.executedQty || qty || 0)
  return { orderId: out.orderId, fill: extractSpotFill(out, price), qty: executedQty, status: out.status }
}

async function closeLiveSpotOrder(pos) {
  const env = getRuntimeBinanceEnv()
  if (env === 'off') throw new Error('Binance env is off')
  const creds = getSpotCreds(env)
  ensureCreds(creds, `${env} spot`)
  const ex = await getSpotEx(env)
  const si = getSymInfo(ex, pos.sym)
  if (!si) throw new Error(`No symbol info: ${pos.sym}`)
  const step = parseFloat(getFilter(si, 'LOT_SIZE')?.stepSize || '0.00001')
  const rawQty = parseFloat(pos.qty || (pos.usdt && pos.fill ? pos.usdt / pos.fill : 0) || 0)
  const qty = fmtStep(rawQty, step)
  if (qty <= 0) throw new Error(`No close quantity for ${pos.sym}`)
  const out = await signedPost(getSpotBase(env), '/api/v3/order',
    {
      symbol: pos.sym,
      side: 'SELL',
      type: 'MARKET',
      quantity: qty.toFixed(precFromStep(step)),
      newOrderRespType: 'FULL',
      newClientOrderId: nextCOID('SC'),
    },
    creds.key, creds.sec)
  const executedQty = parseFloat(out?.executedQty || qty || 0)
  return { orderId: out.orderId, fill: extractSpotFill(out, pos.current || pos.fill), qty: executedQty, status: out.status }
}

async function placeLiveUmOrder(sym, strat, price, usdt) {
  const env = getRuntimeBinanceEnv()
  if (env === 'off') throw new Error('Binance env is off')
  const creds = getUmCreds(env)
  ensureCreds(creds, `${env} futures`)
  for (const setupCall of [
    () => signedPost(getFuturesBase(env), '/fapi/v1/positionSide/dual', { dualSidePosition: 'false' }, creds.key, creds.sec),
    () => signedPost(getFuturesBase(env), '/fapi/v1/marginType', { symbol: sym, marginType: 'CROSSED' }, creds.key, creds.sec),
    () => signedPost(getFuturesBase(env), '/fapi/v1/leverage', { symbol: sym, leverage: 3 }, creds.key, creds.sec),
  ]) {
    try { await setupCall() } catch {}
  }
  const ex = await getUmEx(env)
  const si = getSymInfo(ex, sym)
  if (!si) throw new Error(`No UM symbol: ${sym}`)
  const step = parseFloat(getFilter(si, 'LOT_SIZE')?.stepSize || '0.001')
  const qty = fmtStep(usdt * 3 / price, step)
  if (qty <= 0) throw new Error(`Invalid UM quantity for ${sym}`)
  const out = await signedPost(getFuturesBase(env), '/fapi/v1/order',
    {
      symbol: sym,
      side: strat.side === 'SHORT' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: qty.toFixed(precFromStep(step)),
      positionSide: 'BOTH',
      newOrderRespType: 'RESULT',
      newClientOrderId: nextCOID('UM'),
    },
    creds.key, creds.sec)
  const executedQty = parseFloat(out?.executedQty || out?.origQty || qty || 0)
  const fill = parseFloat(out?.avgPrice || out?.price || 0) || price
  return { orderId: out.orderId, fill, qty: executedQty, status: out.status }
}

async function closeLiveUmOrder(pos) {
  const env = getRuntimeBinanceEnv()
  if (env === 'off') throw new Error('Binance env is off')
  const creds = getUmCreds(env)
  ensureCreds(creds, `${env} futures`)
  const ex = await getUmEx(env)
  const si = getSymInfo(ex, pos.sym)
  if (!si) throw new Error(`No UM symbol: ${pos.sym}`)
  const step = parseFloat(getFilter(si, 'LOT_SIZE')?.stepSize || '0.001')
  const qty = fmtStep(parseFloat(pos.qty || 0), step)
  if (qty <= 0) throw new Error(`No close quantity for ${pos.sym}`)
  const out = await signedPost(getFuturesBase(env), '/fapi/v1/order',
    {
      symbol: pos.sym,
      side: pos.side === 'SHORT' ? 'BUY' : 'SELL',
      type: 'MARKET',
      quantity: qty.toFixed(precFromStep(step)),
      reduceOnly: 'true',
      positionSide: 'BOTH',
      newOrderRespType: 'RESULT',
      newClientOrderId: nextCOID('UC'),
    },
    creds.key, creds.sec)
  const executedQty = parseFloat(out?.executedQty || out?.origQty || qty || 0)
  const fill = parseFloat(out?.avgPrice || out?.price || 0) || pos.current || pos.fill
  return { orderId: out.orderId, fill, qty: executedQty, status: out.status }
}

async function executeLiveTreasury(sym, price, usdt) {
  const env = getRuntimeBinanceEnv()
  if (env === 'off') throw new Error('Binance env is off')
  const creds = getSpotCreds(env)
  ensureCreds(creds, `${env} spot`)
  const ex = await getSpotEx(env)
  const si = getSymInfo(ex, sym)
  if (!si) return null
  const step = parseFloat(getFilter(si, 'LOT_SIZE')?.stepSize || '0.00001')
  const qty = fmtStep(usdt / price, step)
  if (qty <= 0) return null
  const out = await signedPost(getSpotBase(env), '/api/v3/order',
    {
      symbol: sym,
      side: 'BUY',
      type: 'MARKET',
      quantity: qty.toFixed(precFromStep(step)),
      newOrderRespType: 'FULL',
      newClientOrderId: nextCOID('TB'),
    },
    creds.key, creds.sec)
  const executedQty = parseFloat(out?.executedQty || qty || 0)
  return { fill: extractSpotFill(out, price), qty: executedQty }
}

// ── Binance Bootstrap ─────────────────────────────────────────────────
async function runBinanceBootstrap() {
  if (!isBinanceActive(STATE.mode)) {
    STATE.binance = { status: 'off', env: 'off', ts: new Date().toISOString() }
    return
  }
  const env = getRuntimeBinanceEnv()
  const sc = getSpotCreds(env)
  const uc = getUmCreds(env)
  const b = { status: 'checking', env, spot: null, um: null, ts: new Date().toISOString() }
  STATE.binance = b
  try {
    ensureCreds(sc, `${env} spot`)
    const sa = await signedGet(getSpotBase(env), '/api/v3/account', {}, sc.key, sc.sec)
    const btcBal = parseFloat((sa.balances || []).find(x => x.asset === 'BTC')?.free || '0')
    const usdtBal = parseFloat((sa.balances || []).find(x => x.asset === 'USDT')?.free || '0')
    b.spot = { btc: btcBal, usdt: usdtBal, status: 'ok' }
  } catch (e) {
    b.spot = { status: 'error', msg: e.message }
  }
  try {
    ensureCreds(uc, `${env} futures`)
    const ua = await signedGet(getFuturesBase(env), '/fapi/v2/account', {}, uc.key, uc.sec)
    b.um = { walletBalance: parseFloat(ua.totalWalletBalance || '0'), availableBalance: parseFloat(ua.availableBalance || '0'), status: 'ok' }
  } catch (e) {
    b.um = { status: 'error', msg: e.message }
  }
  b.status = (b.spot?.status === 'ok' || b.um?.status === 'ok') ? 'ready' : 'error'
  b.ts = new Date().toISOString()
  STATE.binance = b
  appendLog(`[Binance] ${b.status} env=${env} | Spot USDT:${b.spot?.usdt?.toFixed(2) || 0} BTC:${b.spot?.btc?.toFixed(6) || 0} | UM:${b.um?.walletBalance?.toFixed(2) || 0}`)
}

// ── Paper Trade Execution ─────────────────────────────────────────────
function executePaper(sym, strat, price, ind, usdt, ai_decision = null, options = {}) {
  const atr_pct    = ind.atr_pct || 0.02
  const regime_str = STATE.market_regime || 'ranging'
  const trail      = calcAdaptiveTrailing(regime_str, atr_pct, ai_decision?.suggested_tp_r || 1.8, ai_decision?.suggested_sl_r || 1.0)
  const isLong     = strat.side === 'BUY' || strat.side === 'BUY_DCA'
  const applySlippage = options.applySlippage !== false
  const slip       = applySlippage ? price * 0.0004 : 0
  const fill       = isLong ? price + slip : price - slip
  const bucket     = getLedgerBucket(strat.type)
  return {
    id:            `T${STATE.trade_seq++}`,
    sym, side:     strat.side, usdt, fill,
    sl:            fill * (isLong ? 1 - atr_pct * trail.sl_r       : 1 + atr_pct * trail.sl_r),
    tp:            fill * (isLong ? 1 + atr_pct * trail.runner_r   : 1 - atr_pct * trail.runner_r),
    tp1:           fill * (isLong ? 1 + atr_pct * trail.tp1_r      : 1 - atr_pct * trail.tp1_r),
    tp1_hit: false, runner_active: false, runner_usdt: usdt * trail.runner_pct,
    trail_pct: trail.trail_pct, trail_price: null, highest: fill, lowest: fill,
    ledger_bucket: bucket,
    strat_id: strat.id, strat_name: strat.name, strat_type: strat.type, strat_color: strat.color || '#6b7280',
    score: strat.score, factors: strat.factors,
    ai_verdict: ai_decision?.verdict || null, ai_reasoning: ai_decision?.reasoning || null, ai_provider: ai_decision?.provider || null,
    regime: STATE.market_regime, regime_str,
    atr_pct, trail_config: trail,
    opened_at: new Date().toISOString(), status: 'open', current: fill,
    pnl_usdt: 0, pnl_pct: 0, qty: usdt / fill, fee: usdt * 0.001, tf: strat.tf,
    execution_mode: 'paper', exchange_market: strat.type === 'futures_short' ? 'um' : 'spot',
  }
}

// ── PnL Update + Exit Logic ───────────────────────────────────────────
function updatePnL(pos, price) {
  if (!price || pos.status !== 'open') return null
  const isLong = pos.side === 'BUY' || pos.side === 'BUY_DCA'
  const pnlP   = isLong ? (price - pos.fill) / pos.fill : (pos.fill - price) / pos.fill
  pos.pnl_usdt = pnlP * pos.usdt - pos.fee
  pos.pnl_pct  = pnlP * 100
  pos.current  = price
  if (isLong) pos.highest = Math.max(pos.highest || pos.fill, price)
  else        pos.lowest  = Math.min(pos.lowest  || pos.fill, price)
  // TP1 partial close mark
  if (!pos.tp1_hit && pos.tp1) {
    const hitTp1 = isLong ? price >= pos.tp1 : price <= pos.tp1
    if (hitTp1) pos.tp1_hit = true
  }
  // Trailing stop after TP1
  if (pos.tp1_hit && pos.trail_pct) {
    if (isLong) {
      const t = pos.highest * (1 - pos.trail_pct)
      if (!pos.trail_price || t > pos.trail_price) { pos.trail_price = t; pos.runner_active = true }
    } else {
      const t = pos.lowest * (1 + pos.trail_pct)
      if (!pos.trail_price || t < pos.trail_price) { pos.trail_price = t; pos.runner_active = true }
    }
  }
  // Exit checks
  if (isLong) {
    if (pos.sl && price <= pos.sl) return 'stop_loss'
    if (pos.tp && price >= pos.tp) return 'take_profit'
    if (pos.trail_price && pos.tp1_hit && price <= pos.trail_price) return 'trailing_stop'
  } else {
    if (pos.sl && price >= pos.sl) return 'stop_loss'
    if (pos.tp && price <= pos.tp) return 'take_profit'
    if (pos.trail_price && pos.tp1_hit && price >= pos.trail_price) return 'trailing_stop'
  }
  return null
}

// ── Close Trade ───────────────────────────────────────────────────────
function closeTrade(id, reason, price) {
  const pos = STATE.positions[id]
  if (!pos || pos.status !== 'open') return null
  const p     = price || pos.current
  const isLong = pos.side === 'BUY' || pos.side === 'BUY_DCA'
  const pnlP  = isLong ? (p - pos.fill) / pos.fill : (pos.fill - p) / pos.fill
  const pnlU  = pnlP * pos.usdt - pos.fee * 2
  const bucket = pos.ledger_bucket || getLedgerBucket(pos.strat_type)
  const isDca  = pos.strat_type === 'btc_dca' || pos.strat_type === 'btc_scalp'
  const netProceeds = Math.max(0, pos.usdt + pnlU)

  if (isDca) {
    const btcAdded = netProceeds / Math.max(p, 1)
    STATE.portfolio.btc_stack       = (STATE.portfolio.btc_stack || 0) + btcAdded
    STATE.portfolio.btc_cost_basis  = (STATE.portfolio.btc_cost_basis || 0) + netProceeds
    STATE.portfolio.btc_avg         = STATE.portfolio.btc_stack > 0 ? STATE.portfolio.btc_cost_basis / STATE.portfolio.btc_stack : 0
  } else {
    if (pnlU > 5) {
      const convertAmt = pnlU * 0.70
      const btcPrice   = getBtcPrice()
      STATE.portfolio.btc_stack      = (STATE.portfolio.btc_stack || 0) + convertAmt / btcPrice
      STATE.portfolio.btc_cost_basis = (STATE.portfolio.btc_cost_basis || 0) + convertAmt
      STATE.portfolio.btc_avg        = STATE.portfolio.btc_stack > 0 ? STATE.portfolio.btc_cost_basis / STATE.portfolio.btc_stack : 0
    }
    releaseBucket(bucket, pos.usdt)
  }

  STATE.portfolio.equity    = Math.max(0, STATE.portfolio.equity + pnlU)
  STATE.portfolio.peak      = Math.max(STATE.portfolio.peak, STATE.portfolio.equity)
  STATE.portfolio.pnl_today = (STATE.portfolio.pnl_today || 0) + pnlU
  STATE.portfolio.pnl_total = (STATE.portfolio.pnl_total || 0) + pnlU
  STATE.portfolio.drawdown  = (STATE.portfolio.peak - STATE.portfolio.equity) / Math.max(STATE.portfolio.peak, 1)

  if (pnlU < 0) {
    STATE.portfolio.loss_streak = (STATE.portfolio.loss_streak || 0) + 1
    STATE.portfolio.daily_loss  = (STATE.portfolio.daily_loss  || 0) + Math.abs(pnlU)
    if (STATE.portfolio.loss_streak >= 3) {
      STATE.portfolio.cooldown_until = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      STATE.portfolio.cooldown = true
    }
  } else { STATE.portfolio.loss_streak = 0; STATE.portfolio.cooldown = false }

  if (STATE.portfolio.drawdown > 0.10) STATE.portfolio.risk_off = true
  if (STATE.portfolio.drawdown > 0.15) STATE.portfolio.capital_preservation = true

  const closed = { ...pos, status: 'closed', close_price: p, close_reason: reason, pnl_usdt: pnlU, pnl_pct: pnlP * 100, closed_at: new Date().toISOString(), result: pnlU > 0 ? 'win' : 'loss' }
  delete STATE.positions[id]
  STATE.portfolio.open_positions = Object.keys(STATE.positions).length

  const mo   = new Date().toISOString().slice(0, 7).replace('-', '_')
  const hist = readJ(`history/trades_${mo}.json`, [])
  hist.push(closed); writeJ(`history/trades_${mo}.json`, hist)

  const emoji = pnlU > 0 ? '✅' : '❌'
  appendLog(`${emoji} ${closed.result.toUpperCase()} ${closed.sym} ${closed.strat_name} PnL:$${pnlU.toFixed(2)} ${reason} [AI:${closed.ai_verdict || 'none'}]`)
  logDecision(closed.sym, 'EXIT_' + reason.toUpperCase(), { reason: `PnL:$${pnlU.toFixed(2)}`, strat: closed.strat_name, conf: closed.score, ai: closed.ai_verdict })
  broadcast({ type: 'trade_closed', trade: closed, portfolio: STATE.portfolio })
  return closed
}

async function manageClosePosition(id, reason, price) {
  const pos = STATE.positions[id]
  if (!pos || pos.status !== 'open') return null

  let finalPrice = price || pos.current || 0

  if (isLiveMode(STATE.mode)) {
    try {
      const closeResult = pos.exchange_market === 'um'
        ? await closeLiveUmOrder(pos)
        : await closeLiveSpotOrder(pos)
      if (closeResult?.fill) finalPrice = closeResult.fill
      if (!finalPrice) finalPrice = await getPrice(pos.sym)
    } catch (e) {
      appendLog(`[Live Close] ${id} error: ${e.message}`)
      return null
    }
  } else if (!finalPrice) {
    finalPrice = await getPrice(pos.sym)
  }

  return closeTrade(id, reason, finalPrice || pos.current || pos.fill)
}

// ── Decision Log ──────────────────────────────────────────────────────
function logDecision(sym, action, meta = {}) {
  const d   = { sym, action, ...meta, ts: new Date().toISOString() }
  const dec = readJ('decisions.json', [])
  dec.unshift(d); if (dec.length > 500) dec.length = 500
  writeJ('decisions.json', dec)
  broadcast({ type: 'decision', decision: d })
}

// ── Paper Execution Loop ──────────────────────────────────────────────
async function runExecutionPaper(results) {
  let entered = 0
  for (const [sym, scan] of Object.entries(results)) {
    if (STATE.kill_switch || STATE.portfolio.capital_preservation) break
    if (entered >= 2) break
    const strat   = scan.actionable?.[0]; if (!strat) continue
    const allowed = checkAllowed(sym, strat.side, strat.score, strat.type)
    if (!allowed.ok) { if (strat.score > 0.65) logDecision(sym, 'BLOCKED', { reason: allowed.reason, strat: strat.name, conf: strat.score }); continue }

    const aiDecision = await aiDecisionGate(sym, scan, scan.strategies, scan.ind_1h || {}, STATE, MACRO, MEMORY)
    if (aiDecision.verdict === 'SKIP' || aiDecision.verdict === 'WAIT') {
      logDecision(sym, `AI_${aiDecision.verdict}`, { reason: aiDecision.reasoning, strat: strat.name, conf: strat.score, ai_provider: aiDecision.provider }); continue
    }

    const aiConf     = (aiDecision.verdict === 'BUY' || aiDecision.verdict === 'SELL') ? Math.min(strat.score * 1.1, 1) : strat.score * 0.8
    const finalScore = strat.score * 0.55 + aiConf * 0.45
    if (finalScore < 0.60) continue

    const bucket = getLedgerBucket(strat.type)
    const free   = getBucketFree(bucket)
    const usdt   = calcSize(STATE.portfolio.equity, free, scan.ind_1h?.atr_pct || 0.02, finalScore, strat.type)
    if (usdt < 11 || free < usdt) continue

    const trade = executePaper(sym, strat, scan.price, scan.ind_1h || {}, usdt, aiDecision)
    STATE.positions[trade.id] = trade
    reserveBucket(bucket, usdt)
    STATE.portfolio.open_positions = Object.keys(STATE.positions).length
    appendLog(`📈 PAPER ${sym} ${strat.name} @${scan.price?.toFixed(4)} $${usdt.toFixed(0)} conf:${(finalScore * 100).toFixed(0)}% AI:${aiDecision.verdict}`)
    logDecision(sym, 'ENTRY', { reason: (strat.factors || []).slice(0, 2).join(', '), strat: strat.name, conf: finalScore, price: scan.price, side: strat.side, ai: aiDecision.verdict, ai_reasoning: aiDecision.reasoning })
    broadcast({ type: 'trade_opened', trade, portfolio: STATE.portfolio })
    entered++
  }
}

// ── Live Execution Loop ───────────────────────────────────────────────
async function runExecutionLive(results) {
  let entered = 0
  for (const [sym, scan] of Object.entries(results)) {
    if (STATE.kill_switch || STATE.portfolio.capital_preservation) break
    if (entered >= 1) break
    const strat   = scan.actionable?.[0]; if (!strat) continue
    const allowed = checkAllowed(sym, strat.side, strat.score, strat.type)
    if (!allowed.ok) continue

    const aiDecision = await aiDecisionGate(sym, scan, scan.strategies, scan.ind_1h || {}, STATE, MACRO, MEMORY)
    if (aiDecision.verdict === 'SKIP' || aiDecision.verdict === 'WAIT') continue

    const aiConf     = (aiDecision.verdict === 'BUY' || aiDecision.verdict === 'SELL') ? Math.min(strat.score * 1.1, 1) : strat.score * 0.8
    const finalScore = strat.score * 0.55 + aiConf * 0.45
    if (finalScore < 0.65) continue

    const bucket = getLedgerBucket(strat.type)
    const free   = getBucketFree(bucket)
    const usdt   = calcSize(STATE.portfolio.equity, free, scan.ind_1h?.atr_pct || 0.02, finalScore, strat.type)
    if (usdt < 11 || free < usdt) continue

    try {
      if (strat.type === 'btc_dca' && sym === 'BTCUSDT') {
        logDecision(sym, 'LIVE_SKIP', { reason: 'BTC DCA handled by scheduler', strat: strat.name, conf: finalScore, ai: aiDecision.verdict })
        continue
      }
      const liveResult = strat.type === 'futures_short'
        ? await placeLiveUmOrder(sym, strat, scan.price, usdt)
        : await placeLiveSpotOrder(sym, strat, scan.price, usdt)
      if (!liveResult) continue
      const trade = { ...executePaper(sym, strat, liveResult.fill || scan.price, scan.ind_1h || {}, usdt, aiDecision, { applySlippage: false }), execution_mode: 'live', exchange_order_id: liveResult.orderId, qty: liveResult.qty }
      STATE.positions[trade.id] = trade
      reserveBucket(bucket, usdt)
      STATE.portfolio.open_positions = Object.keys(STATE.positions).length
      appendLog(`📈 LIVE ${sym} ${strat.name} @${liveResult.fill?.toFixed(4)} $${usdt.toFixed(0)} orderId:${liveResult.orderId}`)
      logDecision(sym, 'LIVE_ENTRY', { strat: strat.name, conf: finalScore, price: liveResult.fill, ai: aiDecision.verdict })
      broadcast({ type: 'trade_opened', trade, portfolio: STATE.portfolio })
      entered++
    } catch (e) { appendLog(`[Live] Entry error ${sym}: ${e.message}`) }
  }
}

// ── Market Scan ───────────────────────────────────────────────────────
let scanning = false

async function runScan() {
  if (scanning) return
  scanning = true; STATE.status = 'scanning'
  broadcast({ type: 'scan_started' })
  const results = {}

  for (const sym of CFG.SCAN_SYMBOLS) {
    try {
      const tfCandles = await getMultiTF(sym)
      if (!tfCandles['1h'] || !tfCandles['4h']) continue
      const indByTf = {}
      for (const [tf, candles] of Object.entries(tfCandles)) { const ind = buildIndicators(candles); if (ind) indByTf[tf] = ind }
      const regime = classifyRegime(indByTf['1d'] || {}, indByTf['4h'] || {}, indByTf['1h'] || {})
      const strats = runAllStrategies(sym, indByTf, regime, MEMORY, MACRO)
      const ticker = await get24h(sym)
      const ind1h  = indByTf['1h'] || {}
      results[sym] = {
        sym, price: ind1h.price || 0,
        change_24h:  ticker ? parseFloat(ticker.priceChangePercent) : 0,
        volume_24h:  ticker ? parseFloat(ticker.quoteVolume) : 0,
        regime, ind_1h: ind1h, ind_4h: indByTf['4h'] || {},
        strategies: strats, best: strats.best, top3: strats.top3,
        actionable: strats.actionable, conflict: strats.conflict,
        has_signal: strats.actionable.length > 0,
        timestamp: new Date().toISOString(),
      }
      // Update open positions for this symbol
      for (const [pid, pos] of Object.entries(STATE.positions)) {
        if (pos.sym !== sym || pos.status !== 'open') continue
        const reason = updatePnL(pos, results[sym].price)
        if (reason && STATE.mode !== 'analysis' && !STATE.kill_switch) await manageClosePosition(pid, reason, results[sym].price)
      }
    } catch (e) { console.error(`[Scan] ${sym}:`, e.message) }
  }

  STATE.scan_results = results
  const regCounts = {}
  Object.values(results).forEach(r => { const n = r.regime?.regime || 'unknown'; regCounts[n] = (regCounts[n] || 0) + 1 })
  STATE.market_regime = Object.entries(regCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown'
  STATE.last_scan_at  = new Date().toISOString()
  STATE.status = 'ready'; scanning = false

  if (!STATE.kill_switch && STATE.auto_trading) {
    if (STATE.mode === 'paper') await runExecutionPaper(results)
    else if (isLiveMode(STATE.mode)) await runExecutionLive(results)
  }
  saveRuntime()
  broadcast({ type: 'scan_complete', ...require('./state').getClientState(), scan_total: CFG.SCAN_SYMBOLS.length, signals: Object.values(results).filter(r => r.has_signal).length })
}

// ── BTC DCA Engine ────────────────────────────────────────────────────
async function runBtcDcaWeekly() {
  const eq = STATE.portfolio.equity || CFG.CAPITAL
  const fg = MACRO.fear_greed || 50
  let mult = fg < 25 ? 2.0 : fg < 35 ? 1.8 : fg < 50 ? 1.3 : fg > 85 ? 0 : fg > 75 ? 0.5 : 1.0
  if (mult === 0) { appendLog('[BTC DCA] Extreme greed - skip'); return }
  const regime = STATE.market_regime || 'ranging'
  if (regime === 'trending_down' || regime === 'panic') mult *= 1.5
  else if (regime === 'trending_up' || regime === 'euphoria') mult *= 0.6

  const amount = eq * 0.02 * mult
  if (amount <= 0) return

  const btcPrice = getBtcPrice()
  let btcAdded = 0
  let actualCost = amount
  let effectivePrice = btcPrice

  if (isLiveMode(STATE.mode)) {
    const result = await executeLiveTreasury('BTCUSDT', btcPrice, amount)
    if (!result?.qty || !result?.fill) throw new Error('Live treasury order returned no fill')
    btcAdded = result.qty
    effectivePrice = result.fill
    actualCost = result.fill * result.qty
  } else {
    btcAdded = amount / Math.max(btcPrice, 1)
  }

  if (btcAdded <= 0 || actualCost <= 0) throw new Error('Invalid BTC DCA result')

  STATE.portfolio.btc_stack = (STATE.portfolio.btc_stack || 0) + btcAdded
  STATE.portfolio.btc_cost_basis = (STATE.portfolio.btc_cost_basis || 0) + actualCost
  STATE.portfolio.btc_avg = STATE.portfolio.btc_stack > 0 ? STATE.portfolio.btc_cost_basis / STATE.portfolio.btc_stack : 0
  STATE.portfolio.equity = Math.max(0, STATE.portfolio.equity - actualCost)

  MACRO.last_btc_dca = Date.now()
  writeJ('macro_cache.json', MACRO)

  appendLog(`₿ DCA +${btcAdded.toFixed(8)} BTC @$${effectivePrice.toFixed(2)} $${actualCost.toFixed(2)} mult:${mult}x FG:${fg}`)
  saveRuntime()
  broadcast({ type: 'btc_dca', btc_stack: STATE.portfolio.btc_stack, btc_avg: STATE.portfolio.btc_avg, portfolio: STATE.portfolio })
}

// ── Memory Engine ─────────────────────────────────────────────────────
function updateMemory() {
  const trades = []
  for (let m = 0; m < 3; m++) {
    const d = new Date(); d.setMonth(d.getMonth() - m)
    trades.push(...readJ(`history/trades_${d.toISOString().slice(0, 7).replace('-', '_')}.json`, []))
  }
  if (trades.length < 3) { appendLog('[Memory] Insufficient trades'); return }
  const wins   = trades.filter(t => t.result === 'win')
  const wr     = wins.length / trades.length
  const avg_rr = trades.length > 0 ? trades.reduce((s, t) => s + Math.abs(t.pnl_pct || 0), 0) / trades.length / 100 * 1.5 : 1.5

  const ss = {}
  trades.forEach(t => {
    const id = t.strat_id || 'unknown'
    if (!ss[id]) ss[id] = { wins: 0, losses: 0, count: 0, total_pnl: 0, win_rate: 0, avg_pnl: 0 }
    ss[id].count++; ss[id].total_pnl += t.pnl_usdt || 0
    t.result === 'win' ? ss[id].wins++ : ss[id].losses++
    ss[id].win_rate = ss[id].wins / (ss[id].wins + ss[id].losses || 1)
    ss[id].avg_pnl  = ss[id].total_pnl / ss[id].count
  })

  const lossPatterns = {}
  trades.filter(t => t.result === 'loss').slice(-10).forEach(t => {
    const k = `${t.strat_type || 'unknown'}_in_${t.regime || 'unknown'}`
    lossPatterns[k] = (lossPatterns[k] || 0) + 1
  })
  const topPat = Object.entries(lossPatterns).sort((a, b) => b[1] - a[1])[0]

  Object.assign(MEMORY, {
    total_trades: trades.length, win_rate: wr, avg_rr, strategy_stats: ss,
    recent_loss_pattern: topPat && topPat[1] >= 2 ? `${topPat[0]} (${topPat[1]}x)` : 'none',
    lessons:     trades.filter(t => t.result === 'loss').slice(-5).map(t => ({ sym: t.sym, strat: t.strat_id, regime: t.regime, pnl: t.pnl_usdt, ai: t.ai_verdict })),
    updated_at:  new Date().toISOString(),
  })
  writeJ('memory.json', MEMORY)
  broadcast({ type: 'memory_update', memory: MEMORY })
  appendLog(`[Memory] wr=${(wr * 100).toFixed(1)}% avg_rr=${avg_rr.toFixed(2)} pattern:${MEMORY.recent_loss_pattern}`)
}

module.exports = { runScan, runBtcDcaWeekly, updateMemory, runBinanceBootstrap, manageClosePosition, logDecision, updatePnL, scanning: () => scanning }
