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

// ── YAHOO FINANCE RSS FEED ──────────────────────────────────
// Public RSS feed — no API key, no crumb, no auth needed
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

// Decode basic XML entities
function decodeXML(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
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
  const cached = getCached(cacheKey);
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

    setCached(cacheKey, result);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json(result);
  } catch (e) {
    console.error('[stock-news] fetch error:', e.message);
    return res.status(200).json(tickers.length === 1 ? { [tickers[0]]: [] } : []);
  }
}
