'use strict'
const { CFG } = require('./config')
const { STATE, appendLog } = require('./state')

// ── Bucket Helpers ────────────────────────────────────────────────────
function getLedgerBucket(type = '') {
  if (type === 'btc_dca' || type === 'btc_scalp') return 'btc'
  if (type === 'futures_short') return 'um'
  return 'alt'
}

function getBucketFree(bucket) {
  const p = STATE.portfolio
  if (bucket === 'btc') return Math.max(0, (p.btc_bucket_total || 0) - (p.btc_bucket_used || 0))
  if (bucket === 'um')  return Math.max(0, (p.um_bucket_total  || 0) - (p.um_bucket_used  || 0))
  return Math.max(0, (p.alt_bucket_total || 0) - (p.alt_bucket_used || 0))
}

function reserveBucket(bucket, amt) {
  const p = STATE.portfolio
  if (bucket === 'btc')      p.btc_bucket_used = (p.btc_bucket_used || 0) + amt
  else if (bucket === 'um')  p.um_bucket_used  = (p.um_bucket_used  || 0) + amt
  else                       p.alt_bucket_used = (p.alt_bucket_used || 0) + amt
}

function releaseBucket(bucket, amt) {
  const p = STATE.portfolio
  if (bucket === 'btc')      p.btc_bucket_used = Math.max(0, (p.btc_bucket_used || 0) - amt)
  else if (bucket === 'um')  p.um_bucket_used  = Math.max(0, (p.um_bucket_used  || 0) - amt)
  else                       p.alt_bucket_used = Math.max(0, (p.alt_bucket_used || 0) - amt)
}

function getBtcPrice() {
  return STATE.last_prices?.BTCUSDT || STATE.binance?.spot?.btc_price || 67000
}

// ── Entry Guard ───────────────────────────────────────────────────────
function checkAllowed(sym, side, score, type) {
  if (STATE.kill_switch)                    return { ok: false, reason: 'Kill switch active' }
  if (STATE.portfolio.capital_preservation) return { ok: false, reason: 'Capital preservation mode' }
  if (STATE.portfolio.cooldown) {
    if (new Date(STATE.portfolio.cooldown_until || 0) > new Date() && type !== 'btc_dca')
      return { ok: false, reason: 'Cooldown active' }
    else STATE.portfolio.cooldown = false
  }
  const dailyLossLimit = (STATE.portfolio.equity || CFG.CAPITAL) * 0.05
  if ((STATE.portfolio.daily_loss || 0) > dailyLossLimit) return { ok: false, reason: 'Daily loss limit 5%' }
  if ((STATE.portfolio.drawdown || 0) > 0.15)             return { ok: false, reason: 'Drawdown >15%' }
  const openCount = Object.keys(STATE.positions).length
  if (openCount >= 8) return { ok: false, reason: 'Max 8 positions' }
  const symOpen = Object.values(STATE.positions).filter(p => p.sym === sym && p.status === 'open')
  if (symOpen.length > 0 && type !== 'btc_dca') return { ok: false, reason: `Position already open for ${sym}` }
  const futuresOpen = Object.values(STATE.positions).filter(p => p.strat_type === 'futures_short' && p.status === 'open')
  if (type === 'futures_short' && futuresOpen.length >= 3) return { ok: false, reason: 'Max 3 futures positions' }
  return { ok: true }
}

// ── Position Sizing ───────────────────────────────────────────────────
function calcSize(equity, bucketFree, atr_pct, score, type) {
  const riskPct   = 0.015
  const sl_mult   = type === 'futures_short' ? 1.5 : 1.2
  const risk_usdt = equity * riskPct * Math.min(score * 1.2, 1)
  const sizeByRisk   = risk_usdt / Math.max(atr_pct * sl_mult, 0.005)
  const sizeByBucket = bucketFree * 0.35
  return Math.max(Math.min(sizeByRisk, sizeByBucket, equity * 0.20), 11)
}

// ── Adaptive Trailing Config ──────────────────────────────────────────
function calcAdaptiveTrailing(regime_str, atr_pct, tp_r = 1.5, sl_r = 1.0) {
  const trail_pct_map = {
    trending_up: 0.025, trending_down: 0.015, ranging: 0.012,
    compression: 0.010, expansion: 0.030, euphoria: 0.035, panic: 0.008,
  }
  return {
    tp1_r:      1.0,
    runner_r:   Math.max(tp_r, 1.2),
    trail_pct:  trail_pct_map[regime_str] || 0.020,
    sl_r:       Math.max(sl_r, 0.8),
    tp1_pct:    0.40,
    runner_pct: 0.60,
  }
}

// ── Risk Summary ──────────────────────────────────────────────────────
function getRisk() {
  const p = STATE.portfolio
  return {
    daily_loss_pct:       (p.daily_loss || 0) / Math.max(p.equity, 1),
    loss_streak:          p.loss_streak || 0,
    cooldown:             p.cooldown || false,
    risk_off:             p.risk_off || false,
    capital_preservation: p.capital_preservation || false,
    drawdown:             p.drawdown || 0,
    kill_switch:          STATE.kill_switch,
  }
}

module.exports = { getLedgerBucket, getBucketFree, reserveBucket, releaseBucket, getBtcPrice, checkAllowed, calcSize, calcAdaptiveTrailing, getRisk }
