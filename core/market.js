'use strict'
const { httpClient: axios, settleMapLimit } = require('./http')
const { CFG } = require('./config')
const { MACRO, writeJ, appendLog, broadcast } = require('./state')

// ── Indicator Math ────────────────────────────────────────────────────
const ema = (src, p) => { if (!src?.length) return []; let e = src[0], k = 2 / (p + 1), r = [e]; for (let i = 1; i < src.length; i++) { e = src[i] * k + e * (1 - k); r.push(e) } return r }
const sma = (src, p) => src.map((_, i) => { const sl = src.slice(Math.max(0, i - p + 1), i + 1); return sl.reduce((a, b) => a + b, 0) / sl.length })
const rsiCalc = (src, p = 14) => {
  if (src.length <= p) return 50
  let gains = [], losses = []
  for (let i = 1; i < src.length; i++) { const d = src[i] - src[i - 1]; gains.push(Math.max(d, 0)); losses.push(Math.abs(Math.min(d, 0))) }
  const ag = gains.slice(-p).reduce((a, b) => a + b, 0) / p || 0.0001
  const al = losses.slice(-p).reduce((a, b) => a + b, 0) / p || 0.0001
  return 100 - (100 / (1 + ag / al))
}
const macdCalc = (src, f = 12, s = 26, sig = 9) => {
  const ef = ema(src, f), es = ema(src, s), macd = ef.map((v, i) => v - es[i]), signal = ema(macd, sig), hist = macd.map((v, i) => v - signal[i])
  return { last: macd.at(-1), lastSig: signal.at(-1), lastHist: hist.at(-1), prevHist: hist.at(-2) || 0 }
}
const atrCalc  = (candles, p = 14) => { const trs = candles.map(c => c.high - c.low); return trs.slice(-p).reduce((a, b) => a + b, 0) / p }
const adxCalc  = (candles, p = 14) => {
  if (candles.length < p + 1) return { adx: 20, pdi: 20, mdi: 20 }
  let pdms = [], mdms = [], trs = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p2 = candles[i - 1]
    const upm = c.high - p2.high, dnm = p2.low - c.low
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p2.close), Math.abs(c.low - p2.close))
    pdms.push(upm > 0 && upm > dnm ? upm : 0)
    mdms.push(dnm > 0 && dnm > upm ? dnm : 0)
    trs.push(tr)
  }
  const atr = trs.slice(-p).reduce((a, b) => a + b, 0) / p || 1
  const pdi = (pdms.slice(-p).reduce((a, b) => a + b, 0) / p) / atr * 100
  const mdi = (mdms.slice(-p).reduce((a, b) => a + b, 0) / p) / atr * 100
  return { adx: Math.abs(pdi - mdi) / ((pdi + mdi) || 1) * 100, pdi, mdi }
}
const bbCalc   = (closes, p = 20, mult = 2) => { const m = sma(closes, p), last = m.at(-1) || 0, std = Math.sqrt(closes.slice(-p).reduce((s, v) => s + (v - last) ** 2, 0) / p); return { upper: last + mult * std, mid: last, lower: last - mult * std, width: (2 * mult * std) / (last || 1) } }
const stochCalc = (highs, lows, closes, kp = 14) => { const h = highs.slice(-kp), l = lows.slice(-kp), c = closes.at(-1) || 0, hi = Math.max(...h), lo = Math.min(...l); return hi === lo ? 50 : (c - lo) / (hi - lo) * 100 }
const cciCalc  = (candles, p = 20) => { const tp = candles.map(c => (c.high + c.low + c.close) / 3), mean = tp.slice(-p).reduce((a, b) => a + b, 0) / p, md = tp.slice(-p).reduce((s, v) => s + Math.abs(v - mean), 0) / p; return md === 0 ? 0 : (tp.at(-1) - mean) / (0.015 * md) }
const williamsR = (highs, lows, closes, p = 14) => { const h = Math.max(...highs.slice(-p)), l = Math.min(...lows.slice(-p)), c = closes.at(-1) || 0; return h === l ? -50 : (h - c) / (h - l) * -100 }
const mfiCalc  = (candles, p = 14) => {
  let pmf = 0, nmf = 0
  for (let i = Math.max(1, candles.length - p); i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3
    const pt = (candles[i - 1].high + candles[i - 1].low + candles[i - 1].close) / 3
    const rmf = tp * candles[i].volume
    tp > pt ? pmf += rmf : nmf += rmf
  }
  return nmf === 0 ? 100 : 100 - (100 / (1 + pmf / nmf))
}
const srCalc   = (candles, lb = 50) => { const r = candles.slice(-lb), highs = r.map(c => c.high), lows = r.map(c => c.low), res = Math.max(...highs), sup = Math.min(...lows), price = candles.at(-1)?.close || 0; return { resistance: res, support: sup, at_resistance: price > res * 0.995, at_support: price < sup * 1.005 } }
const volCalc  = (candles, p = 20) => { const vols = candles.map(c => c.volume), avg = vols.slice(-p - 1, -1).reduce((a, b) => a + b, 0) / p || 1, last = vols.at(-1) || 0; return { ratio: last / avg, spike: last / avg > 2.5, avg } }
const candlePatterns = (candles) => {
  if (candles.length < 2) return { patterns: [], bull_pattern: false, bear_pattern: false }
  const c = candles.at(-1), p = candles.at(-2), body = Math.abs(c.close - c.open), range = c.high - c.low, bull = c.close > c.open
  const lw = bull ? c.open - c.low : c.close - c.low, uw = bull ? c.high - c.close : c.high - c.open, pb = Math.abs(p.close - p.open)
  const pats = []
  if (range > 0 && body / range < 0.1) pats.push({ name: 'doji', bias: 'neutral' })
  if (lw > body * 2 && uw < body * 0.5) pats.push({ name: 'hammer', bias: 'bullish' })
  if (uw > body * 2 && lw < body * 0.5) pats.push({ name: 'shooting_star', bias: 'bearish' })
  if (!bull && c.close > p.open && c.open < p.close && body > pb * 0.9) pats.push({ name: 'bullish_engulfing', bias: 'bullish' })
  if (bull && c.close < p.open && c.open > p.close && body > pb * 0.9) pats.push({ name: 'bearish_engulfing', bias: 'bearish' })
  return { patterns: pats, bull_pattern: pats.some(p => p.bias === 'bullish'), bear_pattern: pats.some(p => p.bias === 'bearish') }
}

// ── Build Indicators ──────────────────────────────────────────────────
function buildIndicators(candles) {
  if (!candles || candles.length < 30) return null
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low)
  const e9 = ema(closes, 9).at(-1), e21 = ema(closes, 21).at(-1), e50 = ema(closes, 50).at(-1), e200 = ema(closes, 200).at(-1)
  const macd = macdCalc(closes), atr = atrCalc(candles), adx = adxCalc(candles)
  const bb = bbCalc(closes), vol = volCalc(candles), sr = srCalc(candles), pat = candlePatterns(candles)
  const price = closes.at(-1)
  return {
    price, ema9: e9, ema21: e21, ema50: e50, ema200: e200,
    ema_bull: e9 > e21 && e21 > e50, ema_bear: e9 < e21 && e21 < e50,
    above_ema200: price > e200, e200,
    rsi: rsiCalc(closes),
    macd_hist: macd.lastHist || 0, macd_last: macd.last || 0, macd_prev: macd.prevHist || 0,
    adx: adx.adx, pdi: adx.pdi, mdi: adx.mdi,
    bb_upper: bb.upper, bb_lower: bb.lower, bb_mid: bb.mid, bb_width: bb.width,
    atr, atr_pct: atr / Math.max(price, 0.0001),
    stoch: stochCalc(highs, lows, closes), cci: cciCalc(candles),
    williams: williamsR(highs, lows, closes), mfi: mfiCalc(candles),
    vol, vwap: bb.mid, sr,
    ...pat, at_support: sr.at_support, at_resistance: sr.at_resistance,
    nearest_resistance: sr.resistance, nearest_support: sr.support,
    ms: { bull: e9 > e21, bear: e9 < e21 },
  }
}

// ── Regime Classifier ─────────────────────────────────────────────────
function classifyRegime(ind1d, ind4h, ind1h) {
  const s = { trending: 0, ranging: 0, expansion: 0, compression: 0, panic: 0, euphoria: 0 }
  const adx_avg = (ind1d?.adx || 0) * 0.4 + (ind4h?.adx || 0) * 0.35 + (ind1h?.adx || 0) * 0.25
  if (adx_avg > 28) s.trending  += Math.min(adx_avg / 50, 1) * 0.6
  if (adx_avg < 20) s.ranging   += (1 - adx_avg / 20) * 0.5
  if (ind1d?.ema_bull && ind4h?.ema_bull) s.trending += 0.22
  const bb_w = ind1h?.bb_width || 0
  if (bb_w > 0.045) s.expansion   += Math.min(bb_w / 0.09, 1) * 0.6
  if (bb_w < 0.012) s.compression += (1 - bb_w / 0.012) * 0.6
  const rsi1h = ind1h?.rsi || 50, rsi4h = ind4h?.rsi || 50
  if (rsi1h < 22 && rsi4h < 30) s.panic   += 0.82
  else if (rsi1h < 25) s.panic            += 0.45
  if (rsi1h > 78 && rsi4h > 72) s.euphoria += 0.78
  else if (rsi1h > 75) s.euphoria          += 0.4

  let dom    = Object.entries(s).sort((a, b) => b[1] - a[1])[0]
  let regime = dom[0]
  if (regime === 'trending') {
    const pd = (ind4h?.pdi || 0) * 0.5 + (ind1h?.pdi || 0) * 0.5
    const md = (ind4h?.mdi || 0) * 0.5 + (ind1h?.mdi || 0) * 0.5
    regime = pd > md ? 'trending_up' : 'trending_down'
  }
  const risk = { trending_up: 0.3, trending_down: 0.62, ranging: 0.42, expansion: 0.5, compression: 0.3, panic: 0.92, euphoria: 0.80 }
  return {
    regime, conf: Math.min(dom[1], 1), risk: risk[regime] || 0.5,
    bias: regime.includes('up') || regime === 'expansion' ? 'bullish' : regime.includes('down') || regime === 'panic' ? 'bearish' : 'neutral',
  }
}

// ── Binance Public API ────────────────────────────────────────────────
const BINANCE_PUB = 'https://data-api.binance.vision'
const _apiCache = new Map()

async function binGet(endpoint, params = {}, ttl = 15000) {
  const key = endpoint + JSON.stringify(params)
  const cached = _apiCache.get(key)
  if (cached && Date.now() - cached.ts < ttl) return cached.data
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const r = await axios.get(`${BINANCE_PUB}${endpoint}${q ? '?' + q : ''}`, { timeout: 10000 })
  _apiCache.set(key, { data: r.data, ts: Date.now() })
  return r.data
}

async function getKlines(sym, interval, limit = 200) {
  const d = await binGet('/api/v3/klines', { symbol: sym, interval, limit })
  if (!d) return null
  return d.map(r => ({ open_time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }))
}
async function getMultiTF(sym) {
  const tfs = ['5m', '15m', '1h', '4h', '1d'], results = {}
  await settleMapLimit(tfs, 2, async tf => {
    const d = await getKlines(sym, tf, 200)
    if (d) results[tf] = d
  })
  return results
}
async function getPrice(sym) {
  try { const d = await binGet('/api/v3/ticker/price', { symbol: sym }, 3000); return parseFloat(d?.price || 0) } catch { return 0 }
}
async function get24h(sym) {
  try { return await binGet('/api/v3/ticker/24hr', { symbol: sym }, 30000) } catch { return null }
}

// ── Macro Data Engine ─────────────────────────────────────────────────
async function updateMacro() {
  const state = require('./state')
  try {
    const jobs = [
      () => axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 8000 }).then(r => ({ value: parseInt(r.data?.data?.[0]?.value || '50'), label: r.data?.data?.[0]?.value_classification || 'Neutral' })),
      () => axios.get('https://api.coingecko.com/api/v3/global', { timeout: 10000 }).then(r => parseFloat(r.data?.data?.market_cap_percentage?.btc || 54)),
      () => axios.get('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1', { timeout: 6000 }).then(r => parseFloat(r.data?.[0]?.fundingRate || 0)),
      () => axios.get('https://api.coingecko.com/api/v3/search/trending', { timeout: 10000 }).then(r => (r.data?.coins || []).slice(0, 6).map(c => c.item?.symbol?.toUpperCase()).filter(Boolean)),
    ]
    const [fg, dom, btcFunding, trending] = await settleMapLimit(jobs, 2, job => job())
    Object.assign(state.MACRO, {
      fear_greed:       fg.status === 'fulfilled' ? fg.value.value : state.MACRO.fear_greed,
      fear_greed_label: fg.status === 'fulfilled' ? fg.value.label : state.MACRO.fear_greed_label || 'Neutral',
      dominance:        dom.status === 'fulfilled' ? dom.value : state.MACRO.dominance,
      btc_funding:      btcFunding.status === 'fulfilled' ? btcFunding.value : state.MACRO.btc_funding || 0,
      trending_coins:   trending.status === 'fulfilled' ? trending.value : state.MACRO.trending_coins,
      updated_at:       new Date().toISOString(),
    })
    writeJ('macro_cache.json', state.MACRO)
    appendLog(`[Macro] FG:${state.MACRO.fear_greed} Dom:${state.MACRO.dominance?.toFixed(1)}% Funding:${(state.MACRO.btc_funding * 100).toFixed(4)}%`)
  } catch (e) { appendLog('[Macro] Update error: ' + e.message) }
}

module.exports = { buildIndicators, classifyRegime, getKlines, getMultiTF, getPrice, get24h, updateMacro }
