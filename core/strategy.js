'use strict'

// ── Conflict Detector ─────────────────────────────────────────────────
function detectStrategyConflict(strategies) {
  if (!strategies || strategies.length < 2) return { has_conflict: false }
  const buys  = strategies.filter(s => s.side === 'BUY' || s.side === 'BUY_DCA')
  const sells = strategies.filter(s => s.side === 'SHORT' || s.side === 'SELL')
  if (buys.length > 0 && sells.length > 0)
    return { has_conflict: true, type: 'direction_conflict', buys: buys.map(s => s.name), sells: sells.map(s => s.name) }
  const MOMENTUM  = ['scalp_ema_ribbon', 'swing_breakout', 'scalp_breakout', 'momentum_htf']
  const REVERSION = ['mean_reversion', 'oversold_bounce', 'scalp_stoch_rsi']
  if (strategies.some(s => MOMENTUM.includes(s.id)) && strategies.some(s => REVERSION.includes(s.id)))
    return { has_conflict: true, type: 'momentum_vs_reversion' }
  return { has_conflict: false }
}

// ── Strategy Library (18 strategies) ─────────────────────────────────
const STRATEGIES = {
  scalp_ema_ribbon:   { name: 'EMA Ribbon Scalp',      type: 'scalping',       tf: '5m',  min_conf: 0.62, sl: 1.2, tp: 1.8, color: '#3b82f6',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50) { s += 0.28; f.push('EMA ribbon bullish') }
      if (ind.rsi > 52 && ind.rsi < 68) { s += 0.14; f.push(`RSI momentum (${ind.rsi.toFixed(0)})`) }
      if (ind.macd_hist > 0 && ind.macd_hist > ind.macd_prev) { s += 0.16; f.push('MACD accelerating') }
      if (ind.vol?.ratio > 1.1) { s += 0.10; f.push('Volume confirming') }
      if (reg === 'trending_up') { s += 0.12; f.push('Trending up regime') }
      if (reg === 'compression') s -= 0.15
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  scalp_stoch_rsi:    { name: 'Stoch RSI Scalp',       type: 'scalping',       tf: '5m',  min_conf: 0.60, sl: 1.0, tp: 1.5, color: '#06b6d4',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.stoch < 25) { s += 0.30; f.push(`Stoch oversold (${ind.stoch.toFixed(0)})`) }
      if (ind.rsi < 38) { s += 0.20; f.push('RSI oversold') }
      if (ind.bull_pattern) { s += 0.15; f.push('Bullish pattern') }
      if (ind.at_support) { s += 0.18; f.push('At support level') }
      if (reg === 'ranging') { s += 0.10; f.push('Range regime') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  scalp_vwap:         { name: 'VWAP Bounce',           type: 'scalping',       tf: '15m', min_conf: 0.60, sl: 1.0, tp: 1.6, color: '#8b5cf6',
    run: (ind) => { let s = 0, f = []
      if (ind.price > ind.vwap) { s += 0.22; f.push('Above VWAP') }
      if (ind.price > ind.ema21) { s += 0.18; f.push('Above EMA21') }
      if (ind.vol?.ratio > 1.15) { s += 0.16; f.push('Volume surge') }
      if (ind.rsi > 48 && ind.rsi < 68) { s += 0.12; f.push('RSI healthy') }
      if (ind.macd_hist > 0) { s += 0.10; f.push('MACD positive') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  scalp_breakout:     { name: 'Micro Breakout',         type: 'scalping',       tf: '5m',  min_conf: 0.63, sl: 1.0, tp: 2.0, color: '#10b981',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.bb_width < 0.015 && reg === 'compression') { s += 0.20; f.push('BB squeeze') }
      if (ind.vol?.spike) { s += 0.25; f.push('Volume spike') }
      if (ind.price > ind.bb_upper * 0.998) { s += 0.20; f.push('Breaking upper BB') }
      if (ind.macd_hist > 0 && ind.macd_hist > ind.macd_prev) { s += 0.12; f.push('MACD momentum') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  scalp_cci:          { name: 'CCI Momentum',           type: 'scalping',       tf: '15m', min_conf: 0.62, sl: 1.3, tp: 2.0, color: '#84cc16',
    run: (ind) => { let s = 0, f = []
      if (ind.cci > 100) { s += 0.28; f.push(`CCI breakout (${ind.cci.toFixed(0)})`) }
      if (ind.cci > 150) { s += 0.10; f.push('CCI extreme momentum') }
      if (ind.vol?.ratio > 1.2) { s += 0.14; f.push('Volume expansion') }
      if (ind.rsi > 55 && ind.rsi < 72) { s += 0.12; f.push('RSI trend zone') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  scalp_williams:     { name: 'Williams %R Reversal',   type: 'scalping',       tf: '15m', min_conf: 0.61, sl: 1.2, tp: 1.8, color: '#f97316',
    run: (ind) => { let s = 0, f = []
      if (ind.williams < -80) { s += 0.30; f.push(`Williams oversold (${ind.williams.toFixed(0)})`) }
      if (ind.stoch < 30) { s += 0.18; f.push('Stoch confirms') }
      if (ind.rsi < 40) { s += 0.15; f.push('RSI oversold zone') }
      if (ind.bull_pattern) { s += 0.12; f.push('Bullish reversal') }
      if (ind.above_ema200) { s += 0.10; f.push('Above EMA200') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  swing_breakout:     { name: 'Swing Breakout',         type: 'swing',          tf: '1h',  min_conf: 0.65, sl: 1.5, tp: 3.0, color: '#22d3ee',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.at_resistance && ind.vol?.ratio > 1.4) { s += 0.28; f.push('Clean breakout + volume') }
      if (ind.adx > 25) { s += 0.18; f.push(`Strong trend ADX:${ind.adx.toFixed(0)}`) }
      if (ind.ema_bull) { s += 0.15; f.push('EMA stack bullish') }
      if (ind.rsi > 55 && ind.rsi < 72) { s += 0.12; f.push('RSI momentum') }
      if (reg === 'trending_up' || reg === 'expansion') { s += 0.14; f.push('Expansion regime') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  swing_momentum:     { name: 'HTF Momentum',           type: 'swing',          tf: '4h',  min_conf: 0.67, sl: 2.0, tp: 4.0, color: '#a855f7',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.ema_bull) { s += 0.22; f.push('4H EMA bullish stack') }
      if (ind.adx > 30) { s += 0.20; f.push(`Strong ADX ${ind.adx.toFixed(0)}`) }
      if (ind.rsi > 55 && ind.rsi < 75) { s += 0.15; f.push('RSI trend zone') }
      if (ind.vol?.ratio > 1.2) { s += 0.12; f.push('Volume confirmation') }
      if (ind.macd_hist > 0 && ind.macd_hist > ind.macd_prev) { s += 0.14; f.push('MACD expanding') }
      if (reg === 'trending_up') { s += 0.12; f.push('Trending up') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  mean_reversion:     { name: 'Mean Reversion',         type: 'mean_reversion', tf: '1h',  min_conf: 0.63, sl: 1.5, tp: 2.5, color: '#f59e0b',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.rsi < 35) { s += 0.28; f.push(`RSI oversold ${ind.rsi.toFixed(0)}`) }
      if (ind.price < ind.bb_lower * 1.005) { s += 0.22; f.push('Below lower BB') }
      if (ind.williams < -85) { s += 0.15; f.push('Williams extreme') }
      if (ind.at_support) { s += 0.18; f.push('At major support') }
      if (reg === 'ranging') { s += 0.12; f.push('Range regime') }
      if (reg === 'trending_up' || reg === 'trending_down') s -= 0.20
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  range_bounce:       { name: 'Range Bounce',           type: 'swing',          tf: '1h',  min_conf: 0.61, sl: 1.2, tp: 2.0, color: '#14b8a6',
    run: (ind, reg) => { let s = 0, f = []
      if (reg === 'ranging') { s += 0.25; f.push('Confirmed range regime') }
      if (ind.at_support) { s += 0.25; f.push('At range support') }
      if (ind.rsi < 42) { s += 0.18; f.push('RSI low in range') }
      if (ind.stoch < 30) { s += 0.15; f.push('Stoch oversold') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  btc_dca_accumulate: { name: 'BTC DCA Accumulate',     type: 'btc_dca',        tf: '1d',  min_conf: 0.55, sl: null, tp: null, color: '#f7931a',
    run: (ind, reg, vol, macro) => { let s = 0.5, f = []
      const fg = macro?.fear_greed || 50
      if (ind.price < ind.ema200 * 1.05) { s += 0.18; f.push('Near EMA200 - DCA zone') }
      if (fg < 35) { s += 0.20; f.push(`Fear zone FG:${fg}`) }
      else if (fg > 75) s -= 0.15
      if (ind.rsi < 45) { s += 0.12; f.push('RSI not overbought') }
      if (reg !== 'euphoria' && reg !== 'panic') { s += 0.10; f.push('Regime safe') }
      return { score: Math.min(Math.max(s, 0), 0.90), factors: f, side: 'BUY_DCA' } } },

  btc_scalp_compound: { name: 'BTC Scalp Compound',     type: 'btc_scalp',      tf: '15m', min_conf: 0.65, sl: 1.2, tp: 1.5, color: '#fb923c',
    run: (ind) => { let s = 0, f = []
      if (ind.ema_bull) { s += 0.22; f.push('BTC EMA bullish') }
      if (ind.rsi > 52 && ind.rsi < 68) { s += 0.18; f.push('RSI momentum') }
      if (ind.macd_hist > 0) { s += 0.15; f.push('MACD positive') }
      if (ind.vol?.ratio > 1.15) { s += 0.12; f.push('Volume supporting') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY_DCA' } } },

  futures_short:      { name: 'Futures Short',          type: 'futures_short',  tf: '1h',  min_conf: 0.68, sl: 1.5, tp: 3.0, color: '#ef4444',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.ema_bear) { s += 0.22; f.push('EMA stack bearish') }
      if (ind.rsi > 72) { s += 0.18; f.push(`RSI overbought ${ind.rsi.toFixed(0)}`) }
      if (ind.at_resistance && ind.rsi > 68) { s += 0.20; f.push('Resistance + overbought') }
      if (ind.bear_pattern) { s += 0.15; f.push('Bearish pattern') }
      if (reg === 'trending_down' || reg === 'euphoria') { s += 0.15; f.push('Bearish regime') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'SHORT' } } },

  mfi_divergence:     { name: 'MFI Divergence',         type: 'swing',          tf: '1h',  min_conf: 0.62, sl: 1.3, tp: 2.5, color: '#0ea5e9',
    run: (ind) => { let s = 0, f = []
      if (ind.mfi < 30) { s += 0.28; f.push(`MFI extreme low ${ind.mfi.toFixed(0)}`) }
      if (ind.mfi < 40 && ind.rsi < 45) { s += 0.18; f.push('MFI+RSI both low') }
      if (ind.at_support) { s += 0.15; f.push('At support') }
      if (ind.vol?.ratio < 0.8) { s += 0.10; f.push('Low volume accumulation') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  bb_squeeze:         { name: 'BB Squeeze',             type: 'scalping',       tf: '15m', min_conf: 0.63, sl: 1.1, tp: 2.2, color: '#d946ef',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.bb_width < 0.01) { s += 0.32; f.push('Extreme BB squeeze') }
      else if (ind.bb_width < 0.015) { s += 0.18; f.push('BB compression') }
      if (reg === 'compression') { s += 0.20; f.push('Compression regime') }
      if (ind.adx < 20) { s += 0.15; f.push('Low ADX coiling') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  trend_pullback:     { name: 'Trend Pullback',         type: 'swing',          tf: '4h',  min_conf: 0.66, sl: 1.5, tp: 3.5, color: '#84cc16',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.ema_bull && ind.rsi < 52 && ind.rsi > 38) { s += 0.28; f.push('Pullback in uptrend') }
      if (ind.price > ind.ema50 && ind.price < ind.ema21) { s += 0.20; f.push('Retesting EMA21') }
      if (ind.macd_hist < 0 && ind.macd_hist > ind.macd_prev) { s += 0.15; f.push('MACD turning up') }
      if (reg === 'trending_up') { s += 0.18; f.push('Trending up confirmed') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  oversold_bounce:    { name: 'Oversold Bounce',        type: 'swing',          tf: '1h',  min_conf: 0.62, sl: 1.2, tp: 2.0, color: '#34d399',
    run: (ind) => { let s = 0, f = []
      if (ind.rsi < 28) { s += 0.30; f.push(`RSI extreme oversold ${ind.rsi.toFixed(0)}`) }
      if (ind.stoch < 20) { s += 0.20; f.push('Stoch deeply oversold') }
      if (ind.williams < -90) { s += 0.18; f.push('Williams extreme low') }
      if (ind.bull_pattern) { s += 0.15; f.push('Bullish reversal candle') }
      if (ind.vol?.spike) { s += 0.12; f.push('Volume spike') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },

  adx_breakout:       { name: 'ADX Trend Entry',        type: 'swing',          tf: '4h',  min_conf: 0.67, sl: 1.8, tp: 4.0, color: '#f43f5e',
    run: (ind, reg) => { let s = 0, f = []
      if (ind.adx > 35) { s += 0.28; f.push(`Strong trend ADX:${ind.adx.toFixed(0)}`) }
      if (ind.adx > 25 && ind.pdi > ind.mdi) { s += 0.22; f.push('+DI > -DI bullish') }
      if (ind.ema_bull) { s += 0.18; f.push('EMA stack supports') }
      if (ind.vol?.ratio > 1.3) { s += 0.15; f.push('Volume spike') }
      if (reg === 'trending_up') { s += 0.12; f.push('Trending up') }
      return { score: Math.min(Math.max(s, 0), 1), factors: f, side: 'BUY' } } },
}

// ── Strategy Runner ───────────────────────────────────────────────────
function runAllStrategies(sym, indByTf, regime, memory = {}, macro = {}) {
  const ind1h  = indByTf['1h']  || {}
  const ind4h  = indByTf['4h']  || {}
  const ind15m = indByTf['15m'] || ind1h
  const ind5m  = indByTf['5m']  || ind15m
  const ind1d  = indByTf['1d']  || ind4h
  const reg    = regime?.regime || 'unknown'
  const results = []

  for (const [id, strat] of Object.entries(STRATEGIES)) {
    if ((strat.type === 'btc_dca' || strat.type === 'btc_scalp') && sym !== 'BTCUSDT') continue
    if (strat.type === 'futures_short' && regime?.bias === 'bullish' && (regime?.conf || 0) > 0.7) continue
    const ind = { '5m': ind5m, '15m': ind15m, '1h': ind1h, '4h': ind4h, '1d': ind1d }[strat.tf] || ind1h
    if (!ind?.price) continue
    try {
      const r = strat.run(ind, reg, ind1h.vol, macro)
      // Memory adjustments
      const ss = memory.strategy_stats?.[id]
      if (ss?.win_rate > 0.65) r.score = Math.min(r.score * 1.05, 1)
      if (ss?.win_rate < 0.35) r.score *= 0.92
      if (memory.coin_profiles?.[sym]?.best_strategy === id) r.score = Math.min(r.score * 1.04, 1)
      // HTF bias
      if (ind1d.ema_bull && r.side === 'BUY') r.score = Math.min(r.score * 1.06, 1)
      if (ind1d.ema_bear && r.side === 'BUY') r.score *= 0.88
      // Macro fear/greed
      const fg = macro?.fear_greed || 50
      if (fg > 80 && r.side === 'BUY' && strat.type !== 'btc_dca') r.score *= 0.85
      if (fg < 25 && r.side === 'BUY') r.score = Math.min(r.score * 1.10, 1)

      results.push({
        id, name: strat.name, type: strat.type, tf: strat.tf, color: strat.color,
        min_conf: strat.min_conf, sl: strat.sl, tp: strat.tp,
        score: r.score, factors: r.factors, side: r.side, actionable: r.score >= strat.min_conf,
      })
    } catch {}
  }

  results.sort((a, b) => b.score - a.score)
  const actionable = results.filter(r => r.actionable)
  const top3       = results.slice(0, 3)
  const conflict   = detectStrategyConflict(top3)
  return { results, best: results[0], actionable, top3, conflict }
}

module.exports = { STRATEGIES, runAllStrategies, detectStrategyConflict }
