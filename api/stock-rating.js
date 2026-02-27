import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── IN-MEMORY CACHE (1 hour TTL) ──────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchAnalystRating(ticker) {
  try {
    // Yahoo Finance quoteSummary — financialData module has analyst ratings
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=financialData`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const fd = data?.quoteSummary?.result?.[0]?.financialData;
    if (!fd) return null;

    return {
      ticker,
      rating: fd.recommendationKey || null,           // "buy", "hold", "sell", "strong_buy", "underperform"
      ratingScore: fd.recommendationMean?.raw || null, // 1.0 (Strong Buy) to 5.0 (Strong Sell)
      analysts: fd.numberOfAnalystOpinions?.raw || 0,
      targetHigh: fd.targetHighPrice?.raw || null,
      targetLow: fd.targetLowPrice?.raw || null,
      targetMean: fd.targetMeanPrice?.raw || null,
      targetMedian: fd.targetMedianPrice?.raw || null,
      currentPrice: fd.currentPrice?.raw || null,
      source: 'Yahoo Finance',
    };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  setSecurityHeaders(res);
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(origin);
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin || 'https://pcompass.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'stock-rating', 120)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const raw = (req.query.ticker || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
  if (!raw || !TICKER_RE.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  const cached = getCached(raw);
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json(cached);
  }

  try {
    const rating = await fetchAnalystRating(raw);
    if (!rating) {
      return res.status(200).json({ ticker: raw, rating: null, source: 'Yahoo Finance' });
    }
    setCached(raw, rating);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json(rating);
  } catch (err) {
    console.error('[stock-rating] error:', err);
    return res.status(500).json({ error: 'Failed to fetch rating' });
  }
}
