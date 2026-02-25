import { getAllowedOrigin } from './lib/cors.js';
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

// ── FETCH SINGLE TICKER ───────────────────────────────────
async function fetchTicker(ticker) {
  const cached = getCached(ticker);
  if (cached) return cached;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000), // 5s timeout per ticker
    });

    if (!r.ok) return null;

    const data = await r.json();
    const quote = data?.chart?.result?.[0]?.meta;
    const price = quote?.regularMarketPrice;
    const prev  = quote?.chartPreviousClose;

    if (!quote || !price || !prev) return null;

    const changePct = ((price - prev) / prev * 100);
    // Momentum: 50 = neutral, 0-100 scale based on recent change
    const momentum = Math.min(100, Math.max(0, 50 + changePct * 5));

    const result = {
      price: Math.round(price * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      change: Math.round(changePct * 100) / 100, // alias for backwards compat
      momentum: Math.round(momentum),
      marketState: quote.marketState || 'REGULAR',
      name: quote.shortName || quote.longName || ticker,
    };

    setCached(ticker, result);
    return result;
  } catch {
    return null;
  }
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
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
  if (!await checkRateLimit(ip, 'market-data', 60)) {
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

  // Fetch all in parallel
  const results = await Promise.all(
    tickerList.map(async ticker => [ticker, await fetchTicker(ticker)])
  );

  const output = Object.fromEntries(results);

  // Cache headers — Vercel edge will cache this response per unique ticker combo
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json(output);
}
