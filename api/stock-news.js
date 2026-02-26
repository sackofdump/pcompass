import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── SIMPLE IN-MEMORY CACHE ────────────────────────────────
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

const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ── YAHOO CRUMB + COOKIE (same pattern as market-data.js) ──
let _crumb = null;
let _cookie = null;
let _crumbTs = 0;
const CRUMB_TTL = 30 * 60 * 1000;

async function getCrumb() {
  if (_crumb && _cookie && Date.now() - _crumbTs < CRUMB_TTL) {
    return { crumb: _crumb, cookie: _cookie };
  }
  try {
    const consentRes = await fetch('https://fc.yahoo.com', {
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    });
    const setCookies = consentRes.headers.get('set-cookie') || '';
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': setCookies.split(';')[0] || '' },
      signal: AbortSignal.timeout(4000),
    });
    if (crumbRes.ok) {
      _crumb = await crumbRes.text();
      _cookie = setCookies.split(';')[0] || '';
      _crumbTs = Date.now();
      return { crumb: _crumb, cookie: _cookie };
    }
  } catch { /* fall through */ }
  return { crumb: null, cookie: null };
}

// ── YAHOO FINANCE SEARCH (news) ─────────────────────────────
async function fetchYahooNews(ticker, limit, crumb, cookie) {
  try {
    let url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=${limit}&quotesCount=0`;
    if (crumb) url += `&crumb=${encodeURIComponent(crumb)}`;
    const headers = { 'User-Agent': UA };
    if (cookie) headers['Cookie'] = cookie;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers,
    });
    if (!r.ok) {
      console.error(`[stock-news] Yahoo search ${r.status} for ${ticker}`);
      return [];
    }
    const data = await r.json();
    if (!data.news || !Array.isArray(data.news)) return [];
    return data.news.map(a => ({
      ticker,
      title: a.title || '',
      text: '',
      url: a.link || '',
      source: a.publisher || '',
      date: a.providerPublishTime
        ? new Date(a.providerPublishTime * 1000).toISOString()
        : '',
    }));
  } catch (e) {
    console.error(`[stock-news] Yahoo fetch error for ${ticker}:`, e.message);
    return [];
  }
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
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
  if (!await checkRateLimit(ip, 'stock-news', 30)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // Accept either ?tickers=AAPL,MSFT (batch) or ?ticker=AAPL (legacy single)
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
  const cached = getCached(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json(cached);
  }

  try {
    const isSingle = tickers.length === 1;
    const perTicker = isSingle ? 5 : Math.max(2, Math.floor(10 / tickers.length));

    // Get Yahoo crumb once for the batch
    const { crumb, cookie } = await getCrumb();

    // Fetch news for each ticker in parallel via Yahoo Finance search
    const allArticles = [];
    await Promise.allSettled(
      tickers.map(async (ticker) => {
        const articles = await fetchYahooNews(ticker, perTicker, crumb, cookie);
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

    setCached(cacheKey, result);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json(result);
  } catch (e) {
    console.error('[stock-news] fetch error:', e.message);
    return res.status(200).json(tickers.length === 1 ? { [tickers[0]]: [] } : []);
  }
}
