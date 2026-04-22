'use strict'
const fs = require('fs')
const path = require('path')
const { CFG } = require('./config')

const DATA = path.join(__dirname, '../data')
;['history', 'logs'].forEach(d => fs.mkdirSync(path.join(DATA, d), { recursive: true }))

function readJ(file, def = {}) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')) || def } catch { return def }
}

function writeJ(file, data) {
  try {
    fs.mkdirSync(path.dirname(path.join(DATA, file)), { recursive: true })
    fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 2))
  } catch {}
}

function appendLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { fs.appendFileSync(path.join(DATA, 'logs/app.log'), line + '\n') } catch {}
}

function buildInitialPortfolio(cap = CFG.CAPITAL) {
  const spot_total = cap * CFG.SPOT_TARGET_PCT
  const um_total   = cap * CFG.UM_TARGET_PCT
  return {
    equity: cap, peak: cap, cash_total: cap,
    pnl_today: 0, pnl_total: 0, daily_loss: 0,
    drawdown: 0, loss_streak: 0, cooldown: false, cooldown_until: null,
    risk_off: false, capital_preservation: false,
    btc_bucket_total: spot_total * CFG.BTC_WITHIN_SPOT, btc_bucket_used: 0,
    alt_bucket_total: spot_total * CFG.ALT_WITHIN_SPOT, alt_bucket_used: 0,
    um_bucket_total:  um_total, um_bucket_used: 0,
    btc_stack: 0, btc_cost_basis: 0, btc_invested: 0, btc_avg: 0,
    open_positions: 0,
    targets: { spot_total, um_total, btc_core: spot_total * CFG.BTC_WITHIN_SPOT, alt_spot: spot_total * CFG.ALT_WITHIN_SPOT },
  }
}

const DEFAULT_MEMORY = {
  weights: { trend: 0.18, momentum: 0.16, structure: 0.14, volume: 0.12, htf: 0.14, regime: 0.10, volatility: 0.08, pattern: 0.04, sentiment: 0.04 },
  strategy_stats: {}, coin_profiles: {}, win_rate: 0.5, avg_rr: 1.5,
  recent_loss_pattern: 'none', lessons: [], total_trades: 0, updated_at: null,
}

const DEFAULT_MACRO = {
  fear_greed: 50,
  fear_greed_label: 'Neutral',
  dominance: 54,
  btc_funding: 0,
  trending_coins: [],
  polymarket: [],
  last_btc_dca: 0,
  updated_at: null,
}

const _saved = readJ('runtime_state.json', {})

const STATE = {
  status: 'idle', mode: CFG.MODE, kill_switch: false, safe_mode: false,
  auto_trading: false, scan_results: {}, last_prices: {}, last_scan_at: null,
  trade_seq:  _saved.trade_seq  || 1000,
  positions:  _saved.positions  || {},
  portfolio:  _saved.portfolio  || buildInitialPortfolio(),
  binance: { status: 'off' },
  market_regime: 'unknown',
}

if (!STATE.portfolio.btc_bucket_total)
  Object.assign(STATE.portfolio, buildInitialPortfolio(STATE.portfolio.equity || CFG.CAPITAL))

let MEMORY = { ...DEFAULT_MEMORY, ...(readJ('memory.json', {}) || {}) }
let MACRO  = { ...DEFAULT_MACRO, ...(readJ('macro_cache.json', {}) || {}) }

let _wss = null
function setWss(wss) { _wss = wss }
function broadcast(data) {
  if (!_wss) return
  _wss.clients.forEach(c => { if (c.readyState === 1) try { c.send(JSON.stringify(data)) } catch {} })
}

function getClientState() {
  const { AI_STATE, AI_PROVIDERS } = require('./ai')
  return {
    status: STATE.status, mode: STATE.mode,
    kill_switch: !!STATE.kill_switch, auto_trading: !!STATE.auto_trading,
    binance: STATE.binance || { status: 'off' },
    portfolio: STATE.portfolio, last_scan_at: STATE.last_scan_at,
    positions: Object.values(STATE.positions).filter(p => p.status === 'open'),
    market_regime: STATE.market_regime,
    scan_results: STATE.scan_results,
    last_prices: STATE.last_prices,
    ai_state: {
      ...AI_STATE,
      provider_list: AI_PROVIDERS.filter(p => p.isAvailable()).map(p => p.label),
    },
    macro: MACRO,
    memory: {
      win_rate: MEMORY.win_rate, avg_rr: MEMORY.avg_rr,
      total_trades: MEMORY.total_trades, recent_loss_pattern: MEMORY.recent_loss_pattern,
      updated_at: MEMORY.updated_at,
      strategy_stats: MEMORY.strategy_stats,
      lessons: MEMORY.lessons,
    },
  }
}

function saveRuntime() {
  writeJ('runtime_state.json', { ...STATE, positions: STATE.positions, portfolio: STATE.portfolio, trade_seq: STATE.trade_seq })
}

function saveMacro() {
  writeJ('macro_cache.json', MACRO)
}

function saveMemory() {
  writeJ('memory.json', MEMORY)
}

module.exports = {
  STATE, MEMORY, MACRO,
  readJ, writeJ, appendLog,
  buildInitialPortfolio,
  broadcast, setWss, getClientState,
  saveRuntime, saveMacro, saveMemory,
}
