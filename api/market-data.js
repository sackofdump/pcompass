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

// ── YAHOO CRUMB + COOKIE (shared with sparkline pattern) ──
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': setCookies.split(';')[0] || '',
      },
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

// ── FETCH QUOTE VIA YAHOO FINANCE (primary) ──────────────
async function fetchYahoo(ticker, crumb, cookie) {
  try {
    let url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    if (crumb) url += `&crumb=${encodeURIComponent(crumb)}`;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    };
    if (cookie) headers['Cookie'] = cookie;

    const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) return null;

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    const momentum = Math.min(100, Math.max(0, 50 + changePct * 5));

    return {
      price: Math.round(price * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      change: Math.round(changePct * 100) / 100,
      momentum: Math.round(momentum),
      marketState: meta.marketState || 'REGULAR',
      name: meta.shortName || meta.longName || meta.symbol || '',
    };
  } catch {
    return null;
  }
}

// ── FETCH QUOTE VIA FMP (fallback) ───────────────────────
async function fetchFMP(ticker) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${apiKey}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0 || data[0]?.price == null) return null;
    const q = data[0];
    const changePct = q.changePercentage ?? 0;
    const momentum = Math.min(100, Math.max(0, 50 + changePct * 5));
    return {
      price: Math.round(q.price * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      change: Math.round(changePct * 100) / 100,
      momentum: Math.round(momentum),
      marketState: 'REGULAR',
      name: q.name || q.companyName || q.symbol || '',
    };
  } catch {
    return null;
  }
}

// ── BATCH FETCH ──────────────────────────────────────────
async function fetchBatch(tickerList) {
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

  // Get Yahoo crumb once for the batch
  const { crumb, cookie } = await getCrumb();

  // Fetch all uncached in parallel: Yahoo first, FMP fallback
  await Promise.allSettled(
    uncached.map(async (ticker) => {
      let result = await fetchYahoo(ticker, crumb, cookie);
      if (!result) result = await fetchFMP(ticker);
      if (result) {
        setCached(ticker, result);
        results[ticker] = result;
      } else {
        results[ticker] = null;
      }
    })
  );

  return results;
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
  if (!await checkRateLimit(ip, 'market-data', 30)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'No tickers provided' });

  const tickerList = [...new Set(
    tickers.split(',')
      .map(t => t.trim().toUpperCase().replace(/[^A-Z0-9.]/g, ''))
      .filter(t => t.length >= 1 && t.length <= 6 && /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(t))
  )];

  if (tickerList.length > 40) {
    return res.status(400).json({ error: 'Too many tickers. Max 40 per request.' });
  }

  const output = await fetchBatch(tickerList);

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json(output);
}
