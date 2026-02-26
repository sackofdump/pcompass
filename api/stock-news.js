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

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'No ticker provided' });

  // Sanitize ticker
  const clean = ticker.trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
  if (clean.length < 1 || clean.length > 6 || !/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(clean)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  // Check cache
  const cached = getCached(clean);
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json({ [clean]: cached });
  }

  // Fetch from FMP
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    console.error('[stock-news] FMP_API_KEY not set');
    return res.status(500).json({ error: 'Service unavailable' });
  }

  try {
    // Use stable endpoint (v3 is deprecated for free-tier keys)
    const url = `https://financialmodelingprep.com/stable/news/stock-latest?tickers=${clean}&limit=5&apikey=${apiKey}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      console.warn(`[stock-news] FMP returned ${r.status} for ${clean}`);
      return res.status(200).json({ [clean]: [] });
    }

    const raw = await r.json();
    const articles = (Array.isArray(raw) ? raw : []).map(a => ({
      title: a.title || '',
      text: (a.text || a.content || '').slice(0, 200),
      url: a.url || a.link || '',
      source: (a.site || a.source || a.publisher || '').replace(/^www\./, ''),
      date: a.publishedDate || a.date || '',
    }));

    setCached(clean, articles);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json({ [clean]: articles });
  } catch (e) {
    console.error('[stock-news] fetch error:', e.message);
    return res.status(200).json({ [clean]: [] });
  }
}
