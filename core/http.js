'use strict'
const http = require('http')
const https = require('https')
const zlib = require('zlib')
const { URL } = require('url')

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.HTTP_MAX_CONCURRENT || '6', 10))
const MAX_REDIRECTS = 3

const HTTP_STATS = {
  max_concurrent: MAX_CONCURRENT,
  active: 0,
  peak_active: 0,
  queued: 0,
  peak_queue: 0,
  total_started: 0,
  total_completed: 0,
  total_failed: 0,
  by_route: {},
}

let active = 0
const waiters = []

function routeKey(method, rawUrl) {
  try {
    const u = new URL(rawUrl)
    return `${String(method || 'GET').toUpperCase()} ${u.host}${u.pathname}`
  } catch {
    return String(method || 'GET').toUpperCase()
  }
}

function markRoute(key, field) {
  if (!key) return
  if (!HTTP_STATS.by_route[key]) {
    HTTP_STATS.by_route[key] = { started: 0, completed: 0, failed: 0 }
  }
  HTTP_STATS.by_route[key][field] = (HTTP_STATS.by_route[key][field] || 0) + 1
}

function acquireSlot() {
  if (active < MAX_CONCURRENT) {
    active++
    HTTP_STATS.active = active
    HTTP_STATS.peak_active = Math.max(HTTP_STATS.peak_active, active)
    return Promise.resolve()
  }
  HTTP_STATS.queued++
  HTTP_STATS.peak_queue = Math.max(HTTP_STATS.peak_queue, HTTP_STATS.queued)
  return new Promise(resolve => {
    waiters.push(() => {
      HTTP_STATS.queued = Math.max(0, HTTP_STATS.queued - 1)
      active++
      HTTP_STATS.active = active
      HTTP_STATS.peak_active = Math.max(HTTP_STATS.peak_active, active)
      resolve()
    })
  })
}

function releaseSlot() {
  active = Math.max(0, active - 1)
  HTTP_STATS.active = active
  const next = waiters.shift()
  if (next) next()
}

function getHttpStats() {
  return {
    ...HTTP_STATS,
    active,
    queued: HTTP_STATS.queued,
    by_route: Object.fromEntries(
      Object.entries(HTTP_STATS.by_route)
        .sort((a, b) => (b[1].started || 0) - (a[1].started || 0))
        .slice(0, 20)
    ),
  }
}

function closeHttpClients() {
  while (waiters.length) {
    const next = waiters.shift()
    try { next() } catch {}
  }
}

function decodeBody(buf, encoding) {
  const enc = String(encoding || '').trim().toLowerCase()
  if (!enc || enc === 'identity') return buf
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf)
  if (enc === 'deflate') return zlib.inflateSync(buf)
  if (enc === 'br') return zlib.brotliDecompressSync(buf)
  return buf
}

function normalizeHeaders(headers = {}, hasBody = false, bodyLength = 0) {
  const out = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'identity',
    Connection: 'close',
    'User-Agent': 'MIUX-Trader/4.0',
    ...headers,
  }
  if (hasBody) {
    if (!Object.keys(out).some(k => k.toLowerCase() === 'content-type')) {
      out['Content-Type'] = 'application/json'
    }
    if (!Object.keys(out).some(k => k.toLowerCase() === 'content-length')) {
      out['Content-Length'] = String(bodyLength)
    }
  }
  return out
}

async function request(method, rawUrl, data = null, options = {}, redirectCount = 0) {
  await acquireSlot()
  const route = routeKey(method, rawUrl)
  HTTP_STATS.total_started++
  markRoute(route, 'started')

  try {
    const url = new URL(rawUrl)
    const transport = url.protocol === 'https:' ? https : http
    const timeout = Math.max(1, parseInt(options.timeout || 15000, 10))
    const hasBody = data !== null && data !== undefined
    const payload = hasBody
      ? Buffer.isBuffer(data)
        ? data
        : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
      : null

    const headers = normalizeHeaders(options.headers || {}, hasBody, payload ? payload.length : 0)

    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: String(method || 'GET').toUpperCase(),
      headers,
      agent: false,
    }

    const response = await new Promise((resolve, reject) => {
      const req = transport.request(requestOptions, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks)
            const decoded = decodeBody(raw, res.headers['content-encoding'])
            resolve({ status: res.statusCode || 0, headers: res.headers || {}, buffer: decoded })
          } catch (err) {
            reject(err)
          }
        })
        res.on('error', reject)
      })

      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Request timeout after ${timeout}ms`))
      })
      req.on('error', reject)

      if (payload) req.write(payload)
      req.end()
    })

    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location && redirectCount < MAX_REDIRECTS) {
      const redirectedUrl = new URL(response.headers.location, rawUrl).toString()
      return request(method, redirectedUrl, data, options, redirectCount + 1)
    }

    const text = response.buffer.toString('utf8')
    let parsed = text
    const contentType = String(response.headers['content-type'] || '').toLowerCase()
    if (contentType.includes('application/json') || /^[\[{]/.test(text.trim())) {
      try { parsed = JSON.parse(text) } catch {}
    }

    if (response.status >= 400) {
      const msg = typeof parsed === 'object' && parsed !== null
        ? parsed.msg || parsed.message || JSON.stringify(parsed).slice(0, 280)
        : String(parsed || `HTTP ${response.status}`)
      const err = new Error(`[${requestOptions.method}] ${route} -> ${response.status} ${msg}`)
      err.status = response.status
      err.response = { status: response.status, headers: response.headers, data: parsed }
      throw err
    }

    HTTP_STATS.total_completed++
    markRoute(route, 'completed')
    return { status: response.status, headers: response.headers, data: parsed }
  } catch (err) {
    HTTP_STATS.total_failed++
    markRoute(route, 'failed')
    throw err
  } finally {
    releaseSlot()
  }
}

const httpClient = {
  get(url, options = {}) {
    return request('GET', url, null, options)
  },
  post(url, data = null, options = {}) {
    return request('POST', url, data, options)
  },
}

async function mapLimit(items, limit, worker) {
  const list = Array.from(items || [])
  if (!list.length) return []
  const max = Math.max(1, Math.min(parseInt(limit || list.length, 10), list.length))
  const out = new Array(list.length)
  let index = 0
  await Promise.all(Array.from({ length: max }, async () => {
    while (true) {
      const i = index++
      if (i >= list.length) break
      out[i] = await worker(list[i], i)
    }
  }))
  return out
}

async function settleMapLimit(items, limit, worker) {
  return mapLimit(items, limit, async (item, index) => {
    try {
      return { status: 'fulfilled', value: await worker(item, index) }
    } catch (reason) {
      return { status: 'rejected', reason }
    }
  })
}

module.exports = {
  httpClient,
  closeHttpClients,
  getHttpStats,
  mapLimit,
  settleMapLimit,
}
