import { getAllowedOrigin, setSecurityHeaders } from '../lib/cors.js';
import { neonSQL } from '../lib/neon.js';
import { checkRateLimit } from '../lib/rate-limit.js';

// ── SHARED ──────────────────────────────────────────────
const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ── NEWS CACHE (30min TTL) ──────────────────────────────
const newsCache = new Map();
const NEWS_TTL_MS = 30 * 60 * 1000;

function getNewsCached(key) {
  const entry = newsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > NEWS_TTL_MS) { newsCache.delete(key); return null; }
  return entry.data;
}
function setNewsCached(key, data) { newsCache.set(key, { data, ts: Date.now() }); }

// ── RATING CACHE (1hr TTL) ──────────────────────────────
const ratingCache = new Map();
const RATING_TTL_MS = 60 * 60 * 1000;

function getRatingCached(key) {
  const entry = ratingCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > RATING_TTL_MS) { ratingCache.delete(key); return null; }
  return entry.data;
}
function setRatingCached(key, data) { ratingCache.set(key, { data, ts: Date.now() }); }

// ── YAHOO RSS HELPERS ───────────────────────────────────
async function fetchYahooRSS(ticker, limit) {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': UA },
    });
    if (!r.ok) {
      console.error(`[stock-news] Yahoo RSS ${r.status} for ${ticker}`);
      return [];
    }
    const xml = await r.text();

    // Simple RSS XML parsing (no dependency needed)
    const articles = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && articles.length < limit) {
      const block = match[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
      if (title) {
        articles.push({
          ticker,
          title: decodeXML(title.trim()),
          text: '',
          url: link.trim(),
          source: decodeXML(source.trim()),
          date: pubDate ? new Date(pubDate.trim()).toISOString() : '',
        });
      }
    }
    return articles;
  } catch (e) {
    console.error(`[stock-news] RSS error for ${ticker}:`, e.message);
    return [];
  }
}

function decodeXML(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// ── YAHOO ANALYST RATING HELPER ─────────────────────────
async function fetchAnalystRating(ticker) {
  try {
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

// ── ROUTER ──────────────────────────────────────────────
export default async function handler(req, res) {
  const action = req.query._action || 'data';
  switch (action) {
    case 'data': return handleData(req, res);
    case 'news': return handleNews(req, res);
    case 'rating': return handleRating(req, res);
    default: return res.status(400).json({ error: 'Unknown action' });
  }
}

// ════════════════════════════════════════════════════════
// STOCK DATA (was api/stock-data.js)
// ════════════════════════════════════════════════════════
async function handleData(req, res) {
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

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit by IP (30 req/hr — this endpoint is edge-cached so mostly warm hits)
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit('ip:' + ip, 'stock-data', 30)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const rows = await neonSQL(`SELECT key, data, updated_at FROM stock_data WHERE key IN ('betas', 'picks')`);

    const result = {};
    for (const row of rows) {
      result[row.key] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      result[row.key + '_updated'] = row.updated_at;
    }

    // Only edge-cache when we have actual data; don't cache empty responses
    if (rows.length > 0) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('[stock-data] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stock data' });
  }
}

// ════════════════════════════════════════════════════════
// STOCK NEWS (was api/stock-news.js)
// ════════════════════════════════════════════════════════
async function handleNews(req, res) {
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

  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'stock-news', 120)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // Accept either ?tickers=AAPL,MSFT (batch) or ?ticker=AAPL (single)
  const raw = req.query.tickers || req.query.ticker || '';
  if (!raw) return res.status(400).json({ error: 'No tickers provided' });

  const tickers = raw.split(',')
    .map(t => t.trim().toUpperCase().replace(/[^A-Z0-9.]/g, ''))
    .filter(t => t.length >= 1 && t.length <= 6 && TICKER_RE.test(t))
    .slice(0, 20);

  if (tickers.length === 0) {
    return res.status(400).json({ error: 'Invalid tickers' });
  }

  const cacheKey = [...tickers].sort().join(',');
  const cached = getNewsCached(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json(cached);
  }

  try {
    const isSingle = tickers.length === 1;
    const perTicker = isSingle ? 5 : Math.max(2, Math.floor(10 / tickers.length));

    // Fetch news for each ticker in parallel via Yahoo RSS
    const allArticles = [];
    await Promise.allSettled(
      tickers.map(async (ticker) => {
        const articles = await fetchYahooRSS(ticker, perTicker);
        allArticles.push(...articles);
      })
    );

    // Sort newest first
    allArticles.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });

    const trimmed = allArticles.slice(0, isSingle ? 5 : 10);

    const result = isSingle
      ? { [tickers[0]]: trimmed }
      : trimmed;

    setNewsCached(cacheKey, result);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json(result);
  } catch (e) {
    console.error('[stock-news] fetch error:', e.message);
    return res.status(200).json(tickers.length === 1 ? { [tickers[0]]: [] } : []);
  }
}

// ════════════════════════════════════════════════════════
// STOCK RATING (was api/stock-rating.js)
// ════════════════════════════════════════════════════════
async function handleRating(req, res) {
  setSecurityHeaders(res);
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin || 'http://localhost:3000');
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

  const cached = getRatingCached(raw);
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json(cached);
  }

  try {
    const rating = await fetchAnalystRating(raw);
    if (!rating) {
      return res.status(200).json({ ticker: raw, rating: null, source: 'Yahoo Finance' });
    }
    setRatingCached(raw, rating);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json(rating);
  } catch (err) {
    console.error('[stock-rating] error:', err);
    return res.status(500).json({ error: 'Failed to fetch rating' });
  }
}
