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

// ── GOOGLE NEWS RSS PARSER ─────────────────────────────────
// Free, no API key, no rate limits
async function fetchGoogleNews(ticker, limit) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(ticker + ' stock')}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return [];
  const xml = await r.text();

  // Simple XML parse — extract <item> blocks
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    // Source is after " - " at end of title (e.g. "Headline - Reuters")
    const sourceSplit = title.split(' - ');
    const source = sourceSplit.length > 1 ? sourceSplit.pop().trim() : '';
    const cleanTitle = sourceSplit.join(' - ').trim();

    if (cleanTitle) {
      items.push({
        ticker,
        title: decodeXML(cleanTitle),
        text: '',
        url: decodeXML(link),
        source: decodeXML(source),
        date: pubDate ? new Date(pubDate).toISOString() : '',
      });
    }
  }
  return items;
}

function decodeXML(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
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

  try {
    const isSingle = tickers.length === 1;
    const perTicker = isSingle ? 5 : Math.max(2, Math.floor(10 / tickers.length));

    // Fetch news for each ticker in parallel via Google News RSS
    const allArticles = [];
    await Promise.allSettled(
      tickers.map(async (ticker) => {
        const articles = await fetchGoogleNews(ticker, perTicker);
        allArticles.push(...articles);
      })
    );

    // Sort newest first
    allArticles.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });

    // Cap total articles
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
