'use strict'
const { httpClient: axios } = require('./http')
const { CFG } = require('./config')
const { appendLog } = require('./state')

// ── AI State ──────────────────────────────────────────────────────────
const AI_STATE = {
  status: 'idle', calls_total: 0, calls_success: 0, calls_failed: 0,
  last_provider: '', last_latency_ms: 0, last_call_at: null,
}

// ── Provider Definitions ──────────────────────────────────────────────
const AI_PROVIDERS = [
  {
    id: 'primary', label: 'Qwen Local',
    isAvailable: () => !!CFG.AI_PRIMARY_URL,
    call: async (prompt, sys) => {
      const r = await axios.post(CFG.AI_PRIMARY_URL, {
        model: CFG.AI_PRIMARY_MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
        max_tokens: 300, temperature: 0.3, stream: false,
      }, { headers: { Authorization: `Bearer ${CFG.AI_PRIMARY_KEY}`, 'Content-Type': 'application/json' }, timeout: CFG.AI_TIMEOUT_MS })
      return r.data?.choices?.[0]?.message?.content || ''
    },
  },
  {
    id: 'groq', label: 'Groq',
    isAvailable: () => !!CFG.GROQ_API_KEY,
    call: async (prompt, sys) => {
      const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant', max_tokens: 300, temperature: 0.3,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      }, { headers: { Authorization: `Bearer ${CFG.GROQ_API_KEY}` }, timeout: 15000 })
      return r.data?.choices?.[0]?.message?.content || ''
    },
  },
  {
    id: 'openrouter', label: 'OpenRouter',
    isAvailable: () => !!CFG.OPENROUTER_API_KEY,
    call: async (prompt, sys) => {
      const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: 'mistralai/mistral-7b-instruct:free', max_tokens: 300, temperature: 0.3,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      }, { headers: { Authorization: `Bearer ${CFG.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://miux-trader.local' }, timeout: 20000 })
      return r.data?.choices?.[0]?.message?.content || ''
    },
  },
  {
    id: 'gemini', label: 'Gemini',
    isAvailable: () => !!CFG.GEMINI_API_KEY,
    call: async (prompt, sys) => {
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CFG.GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: `${sys}\n\n${prompt}` }] }], generationConfig: { maxOutputTokens: 300, temperature: 0.3 } },
        { timeout: 20000 })
      return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    },
  },
  {
    id: 'openai', label: 'OpenAI',
    isAvailable: () => !!CFG.OPENAI_API_KEY,
    call: async (prompt, sys) => {
      const r = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 300, temperature: 0.3,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      }, { headers: { Authorization: `Bearer ${CFG.OPENAI_API_KEY}` }, timeout: 20000 })
      return r.data?.choices?.[0]?.message?.content || ''
    },
  },
]

// ── Prompt Builder ────────────────────────────────────────────────────
const AI_SYSTEM_PROMPT = `You are a conservative crypto trading signal validator.
Rules:
- WAIT and SKIP are valid and often better than forcing a trade
- Never recommend BUY if conflict exists between strategies without clear resolution
- Use memory to avoid repeating known losing patterns
- In ranging/sideways market, prefer WAIT over BUY
- Fear&Greed >80: be very cautious on alts. <25: DCA opportunities only
- Respond ONLY with the JSON object requested. No preamble, no explanation outside JSON.`

function buildPrompt(sym, regime, top3, indicators, macro, memory, portfolio) {
  const confStr   = top3.map((s, i) => `[${i + 1}] ${s.name} score=${(s.score * 100).toFixed(0)}% side=${s.side} tf=${s.tf}`).join(' | ')
  const { detectStrategyConflict } = require('./strategy')
  const conflict  = detectStrategyConflict(top3)
  const macStr    = `FG=${macro.fear_greed}(${macro.fear_greed_label || '?'}) Dom=${(macro.dominance || 54).toFixed(1)}% Funding=${((macro.btc_funding || 0) * 100).toFixed(4)}%`
  const memStr    = `win_rate=${((memory.win_rate || 0.5) * 100).toFixed(0)}% avg_rr=${(memory.avg_rr || 1.5).toFixed(1)} loss_pattern=${memory.recent_loss_pattern || 'none'}`
  const portStr   = `open_pos=${portfolio.open_positions} drawdown=${(portfolio.drawdown * 100).toFixed(1)}% loss_streak=${portfolio.loss_streak || 0}`
  return `SYMBOL: ${sym}
REGIME: ${regime?.regime || 'unknown'} (conf=${((regime?.conf || 0) * 100).toFixed(0)}%)
STRATEGIES: ${confStr}
CONFLICT: ${conflict.has_conflict ? `YES - ${conflict.type}` : 'none'}
INDICATORS: RSI=${(indicators.rsi || 50).toFixed(0)} MACD=${indicators.macd_hist >= 0 ? '+' : ''}${(indicators.macd_hist || 0).toFixed(3)} EMA=${indicators.ema_bull ? 'bullish' : 'bearish'} Vol=${(indicators.vol?.ratio || 1).toFixed(2)}x BB_width=${(indicators.bb_width || 0).toFixed(4)}
MACRO: ${macStr}
MEMORY: ${memStr}
PORTFOLIO: ${portStr}

Respond ONLY with valid JSON:
{"verdict":"BUY|SELL|WAIT|SKIP","reasoning":"max 25 words","suggested_tp_r":1.5,"suggested_sl_r":1.0}`
}

function parseResponse(raw) {
  if (!raw) return null
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim()
    const match   = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    const obj = JSON.parse(match[0])
    if (!['BUY', 'SELL', 'WAIT', 'SKIP'].includes(obj.verdict)) return null
    return {
      verdict:        obj.verdict,
      reasoning:      String(obj.reasoning || '').slice(0, 100),
      suggested_tp_r: Math.min(Math.max(parseFloat(obj.suggested_tp_r) || 1.5, 1.0), 5.0),
      suggested_sl_r: Math.min(Math.max(parseFloat(obj.suggested_sl_r) || 1.0, 0.5), 3.0),
    }
  } catch { return null }
}

// ── Core Call ─────────────────────────────────────────────────────────
async function callAI(sym, regime, top3, indicators, macro, memory, portfolio) {
  const prompt = buildPrompt(sym, regime, top3, indicators, macro, memory, portfolio)
  const t0 = Date.now()
  AI_STATE.calls_total++
  AI_STATE.last_call_at = new Date().toISOString()

  for (const provider of AI_PROVIDERS) {
    if (!provider.isAvailable()) continue
    try {
      const raw    = await provider.call(prompt, AI_SYSTEM_PROMPT)
      const parsed = parseResponse(raw)
      if (!parsed) { appendLog(`[AI] ${provider.label} bad JSON, trying next`); continue }
      AI_STATE.calls_success++
      AI_STATE.last_provider   = provider.label
      AI_STATE.last_latency_ms = Date.now() - t0
      AI_STATE.status = 'ok'
      appendLog(`[AI] ${provider.label} ${sym} → ${parsed.verdict} (${AI_STATE.last_latency_ms}ms)`)
      return { ...parsed, provider: provider.label, latency_ms: AI_STATE.last_latency_ms }
    } catch (e) { appendLog(`[AI] ${provider.label} failed: ${e.message}`) }
  }
  AI_STATE.calls_failed++
  AI_STATE.status = 'all_failed'
  return null
}

// ── Decision Gate ─────────────────────────────────────────────────────
async function aiDecisionGate(sym, scan, strats, ind1h, STATE, MACRO_DATA, MEMORY_DATA) {
  const bestScore = strats.best?.score || 0
  if (bestScore < CFG.AI_MIN_RULE_SCORE)
    return { verdict: 'SKIP', reasoning: 'Rule score too low', skip_reason: 'low_score', provider: 'rule_engine' }
  if (strats.conflict.has_conflict && bestScore < 0.72)
    return { verdict: 'WAIT', reasoning: `Strategy conflict: ${strats.conflict.type}`, provider: 'rule_engine' }

  const fg = MACRO_DATA.fear_greed || 50
  if (fg < 20 && strats.best?.type !== 'btc_dca')
    return { verdict: 'WAIT', reasoning: 'Extreme fear — DCA only', provider: 'macro_filter' }
  if (fg > 85 && strats.best?.type !== 'btc_dca' && sym !== 'BTCUSDT')
    return { verdict: 'SKIP', reasoning: 'Extreme greed on alts', provider: 'macro_filter' }

  const portMeta = { open_positions: Object.keys(STATE.positions).length, drawdown: STATE.portfolio.drawdown || 0, loss_streak: STATE.portfolio.loss_streak || 0 }
  const memMeta  = { win_rate: MEMORY_DATA.win_rate || 0.5, avg_rr: MEMORY_DATA.avg_rr || 1.5, recent_loss_pattern: MEMORY_DATA.recent_loss_pattern || 'none' }
  const result   = await callAI(sym, scan.regime, strats.top3, ind1h, MACRO_DATA, memMeta, portMeta)
  return result || { verdict: 'BUY', reasoning: 'AI unavailable — fallback', provider: 'fallback', suggested_tp_r: 1.8, suggested_sl_r: 1.0 }
}

module.exports = { AI_STATE, AI_PROVIDERS, callAI, aiDecisionGate }
