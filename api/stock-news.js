import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── SIMPLE IN-MEMORY CACHE ────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min (news doesn't change fast)

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;

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
  if (!await checkRateLimit(ip, 'stock-news', 30)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // Accept either ?tickers=AAPL,MSFT (batch) or ?ticker=AAPL (legacy single)
  const raw = req.query.tickers || req.query.ticker || '';
  if (!raw) return res.status(400).json({ error: 'No tickers provided' });

  // Parse + sanitize ticker list (cap at 20)
  const tickers = raw.split(',')
    .map(t => t.trim().toUpperCase().replace(/[^A-Z0-9.]/g, ''))
    .filter(t => t.length >= 1 && t.length <= 6 && TICKER_RE.test(t))
    .slice(0, 20);

  if (tickers.length === 0) {
    return res.status(400).json({ error: 'Invalid tickers' });
  }

  // Cache key: sorted tickers joined
  const cacheKey = [...tickers].sort().join(',');
  const cached = getCached(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json(cached);
  }

  // Fetch from FMP
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    console.error('[stock-news] FMP_API_KEY not set');
    return res.status(500).json({ error: 'Service unavailable' });
  }

  try {
    const tickerParam = tickers.join(',');
    const limit = tickers.length === 1 ? 5 : 10;

    // Try multiple FMP endpoints (stable paths vary by plan)
    const endpoints = [
      `https://financialmodelingprep.com/stable/stock-news?tickers=${tickerParam}&limit=${limit}&apikey=${apiKey}`,
      `https://financialmodelingprep.com/stable/news/stock-latest?tickers=${tickerParam}&limit=${limit}&apikey=${apiKey}`,
      `https://financialmodelingprep.com/api/v3/stock_news?tickers=${tickerParam}&limit=${limit}&apikey=${apiKey}`,
    ];

    let rawData = null;
    for (const url of endpoints) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const body = await r.json();
        if (Array.isArray(body) && body.length > 0) {
          rawData = body;
          break;
        }
      } catch { /* try next endpoint */ }
    }

    if (!rawData || rawData.length === 0) {
      console.warn(`[stock-news] No articles from any FMP endpoint for ${tickerParam}`);
      const empty = tickers.length === 1 ? { [tickers[0]]: [] } : [];
      setCached(cacheKey, empty);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
      return res.status(200).json(empty);
    }

    const articles = rawData.map(a => ({
      ticker: (a.symbol || '').toUpperCase(),
      title: a.title || '',
      text: (a.text || a.content || '').slice(0, 200),
      url: a.url || a.link || '',
      source: (a.site || a.source || a.publisher || '').replace(/^www\./, ''),
      date: a.publishedDate || a.date || '',
    })).sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });

    const result = tickers.length === 1
      ? { [tickers[0]]: articles }
      : articles;

    setCached(cacheKey, result);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json(result);
  } catch (e) {
    console.error('[stock-news] fetch error:', e.message);
    return res.status(200).json(tickers.length === 1 ? { [tickers[0]]: [] } : []);
  }
}
