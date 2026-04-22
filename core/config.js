'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const crypto = require('crypto')

const VALID_MODES = ['paper', 'analysis', 'safe', 'live_testnet', 'live_mainnet']

function normalizeMode(r = 'paper') {
  const m = String(r || 'paper').trim().toLowerCase()
  if (VALID_MODES.includes(m)) return m
  if (m === 'live' || m === 'mainnet') return 'live_mainnet'
  if (m === 'testnet') return 'live_testnet'
  return 'paper'
}

const isLiveMode = m => m === 'live_testnet' || m === 'live_mainnet'
const getModeLabel = m =>
  ({ paper: 'PAPER', analysis: 'ANALYSIS', safe: 'SAFE', live_testnet: 'LIVE DEMO', live_mainnet: 'LIVE MAINNET' }[m] || 'PAPER')

function getBinanceEnv(mode) {
  if (mode === 'live_testnet') return 'testnet'
  if (mode === 'live_mainnet') return 'mainnet'
  return 'off'
}

function isBinanceActive(mode) {
  return isLiveMode(mode)
}

const MODE = normalizeMode(process.env.TRADING_MODE || 'paper')
const BINANCE_ENV = getBinanceEnv(MODE)
const BINANCE_ACTIVE = isBinanceActive(MODE)

const DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || '').trim() || crypto.randomBytes(18).toString('base64url')
const PASSWORD_SOURCE = process.env.DASHBOARD_PASSWORD ? 'env' : 'generated'

const CFG = {
  PORT:     parseInt(process.env.PORT || '3000', 10),
  HOST:     process.env.HOST || '0.0.0.0',
  CAPITAL:  parseFloat(process.env.INITIAL_CAPITAL || '10000'),
  PASSWORD: DASHBOARD_PASSWORD,
  PASSWORD_SOURCE,
  DASHBOARD_ORIGIN: String(process.env.DASHBOARD_ORIGIN || '').trim(),
  SESSION_SECRET: String(process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex'),
  SPOT_TARGET_PCT: parseFloat(process.env.PORTFOLIO_SPOT_TARGET_PCT || '0.90'),
  BTC_WITHIN_SPOT: parseFloat(process.env.PORTFOLIO_BTC_WITHIN_SPOT_PCT || '0.70'),
  ALT_WITHIN_SPOT: parseFloat(process.env.PORTFOLIO_ALT_WITHIN_SPOT_PCT || '0.30'),
  UM_TARGET_PCT:   parseFloat(process.env.PORTFOLIO_UM_TARGET_PCT || '0.10'),
  MODE, BINANCE_ENV, BINANCE_ACTIVE,
  AI_PRIMARY_URL:    process.env.AI_PRIMARY_URL || 'http://127.0.0.1:3573/v1/chat/completions',
  AI_PRIMARY_KEY:    process.env.AI_PRIMARY_KEY || '',
  AI_PRIMARY_MODEL:  process.env.AI_PRIMARY_MODEL || 'qwen2.5-3b-instruct-q4',
  AI_TIMEOUT_MS:     parseInt(process.env.AI_TIMEOUT_MS || '35000', 10),
  AI_MIN_RULE_SCORE: parseFloat(process.env.AI_MIN_RULE_SCORE || '0.68'),
  GROQ_API_KEY:       process.env.GROQ_API_KEY || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENAI_API_KEY:     process.env.OPENAI_API_KEY || '',
  GEMINI_API_KEY:     process.env.GEMINI_API_KEY || '',
  SCAN_SYMBOLS: (process.env.SCAN_SYMBOLS ||
    'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,NEARUSDT,DOTUSDT,INJUSDT,SUIUSDT,UNIUSDT,AAVEUSDT,RENDERUSDT,FETUSDT,SEIUSDT,ATOMUSDT,LTCUSDT,WLDUSDT'
  ).split(',').map(s => s.trim()).filter(Boolean),
}

function getSpotBase(env)    { return env === 'testnet' ? 'https://demo-api.binance.com'  : 'https://api.binance.com' }
function getFuturesBase(env) { return env === 'testnet' ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com' }

function getSpotCreds(env) {
  if (env === 'testnet') return { key: process.env.BINANCE_DEMO_SPOT_API_KEY || '', sec: process.env.BINANCE_DEMO_SPOT_API_SECRET || '' }
  return { key: process.env.BINANCE_MAINNET_SPOT_API_KEY || '', sec: process.env.BINANCE_MAINNET_SPOT_API_SECRET || '' }
}

function getUmCreds(env) {
  if (env === 'testnet') return { key: process.env.BINANCE_DEMO_UM_API_KEY || '', sec: process.env.BINANCE_DEMO_UM_API_SECRET || '' }
  return { key: process.env.BINANCE_MAINNET_UM_API_KEY || '', sec: process.env.BINANCE_MAINNET_UM_API_SECRET || '' }
}

module.exports = {
  CFG, MODE, BINANCE_ENV, BINANCE_ACTIVE,
  normalizeMode, isLiveMode, getModeLabel,
  getBinanceEnv, isBinanceActive,
  getSpotBase, getFuturesBase, getSpotCreds, getUmCreds,
}
