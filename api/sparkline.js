import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── IN-MEMORY CACHE ─────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ── VALID RANGES ─────────────────────────────────────────
const VALID_RANGES = new Set(['1d', '5d', '1mo', '3mo']);

// ── FETCH SPARKLINE FROM YAHOO FINANCE ───────────────────
async function fetchSparkline(ticker, range) {
  const cacheKey = `${ticker}:${range}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const interval = range === '1d' ? '5m' : '1d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const closes = result.indicators?.quote?.[0]?.close;
    const timestamps = result.timestamp;
    if (!closes || !timestamps || closes.length < 2) return null;

    // Filter out null values while keeping timestamps aligned
    const filtered = { closes: [], timestamps: [] };
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null) {
        filtered.closes.push(Math.round(closes[i] * 100) / 100);
        filtered.timestamps.push(timestamps[i]);
      }
    }

    if (filtered.closes.length < 2) return null;
    setCached(cacheKey, filtered);
    return filtered;
  } catch {
    return null;
  }
}

// ── HANDLER ──────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // Rate limit by IP
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'sparkline', 20)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { tickers, range = '1mo' } = req.query;
  if (!tickers) return res.status(400).json({ error: 'No tickers provided' });

  // Validate range
  if (!VALID_RANGES.has(range)) {
    return res.status(400).json({ error: 'Invalid range. Use: 5d, 1mo, 3mo' });
  }

  // Deduplicate and sanitize tickers
  const tickerList = [...new Set(
    tickers.split(',')
      .map(t => t.trim().toUpperCase().replace(/[^A-Z0-9.]/g, ''))
      .filter(t => t.length >= 1 && t.length <= 6 && /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(t))
  )];

  if (tickerList.length === 0) {
    return res.status(400).json({ error: 'No valid tickers provided' });
  }
  if (tickerList.length > 40) {
    return res.status(400).json({ error: 'Too many tickers. Max 40 per request.' });
  }

  // Fetch in parallel, batches of 10
  const output = {};
  for (let i = 0; i < tickerList.length; i += 10) {
    const batch = tickerList.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        const data = await fetchSparkline(ticker, range);
        output[ticker] = data;
      })
    );
  }

  // Edge cache: 4hr on CDN, 30min stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=14400, stale-while-revalidate=1800');
  return res.status(200).json(output);
}
