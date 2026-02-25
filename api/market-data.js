import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── SIMPLE IN-MEMORY CACHE ────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min in-function cache (edge handles the 1hr)

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ── FETCH BATCH VIA FMP ──────────────────────────────────
// Single API call for all tickers using Financial Modeling Prep batch quote endpoint
async function fetchBatch(tickerList) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    console.error('[market-data] FMP_API_KEY not set');
    return {};
  }

  // Check cache first — return cached results and only fetch uncached
  const results = {};
  const uncached = [];
  for (const ticker of tickerList) {
    const cached = getCached(ticker);
    if (cached) {
      results[ticker] = cached;
    } else {
      uncached.push(ticker);
    }
  }

  if (uncached.length === 0) return results;

  try {
    const url = `https://financialmodelingprep.com/api/v3/quote/${uncached.join(',')}?apikey=${apiKey}`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
    });

    if (!r.ok) {
      console.warn('[market-data] FMP responded', r.status);
      return results; // return whatever we had cached
    }

    const data = await r.json();
    if (!Array.isArray(data)) return results;

    for (const quote of data) {
      if (!quote.symbol || quote.price == null) continue;
      const changePct = quote.changesPercentage ?? 0;
      const momentum = Math.min(100, Math.max(0, 50 + changePct * 5));
      const result = {
        price: Math.round(quote.price * 100) / 100,
        changePct: Math.round(changePct * 100) / 100,
        change: Math.round(changePct * 100) / 100,
        momentum: Math.round(momentum),
        marketState: quote.marketOpen ? 'REGULAR' : 'CLOSED',
        name: quote.name || quote.symbol,
      };
      setCached(quote.symbol, result);
      results[quote.symbol] = result;
    }
  } catch (e) {
    console.warn('[market-data] FMP fetch failed:', e.message);
  }

  // Fill in nulls for any tickers that didn't return
  for (const ticker of uncached) {
    if (!results[ticker]) results[ticker] = null;
  }

  return results;
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  // ── CORS ──
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
  if (!await checkRateLimit(ip, 'market-data', 30)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'No tickers provided' });

  // Deduplicate and sanitize
  const tickerList = [...new Set(
    tickers.split(',')
      .map(t => t.trim().toUpperCase().replace(/[^A-Z0-9.]/g, ''))
      .filter(t => t.length >= 1 && t.length <= 6 && /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(t))
  )];

  // Hard cap — don't let someone request 500 tickers
  if (tickerList.length > 40) {
    return res.status(400).json({ error: 'Too many tickers. Max 40 per request.' });
  }

  // Fetch all via single FMP batch call
  const output = await fetchBatch(tickerList);

  // Cache headers — Vercel edge will cache this response per unique ticker combo
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json(output);
}
