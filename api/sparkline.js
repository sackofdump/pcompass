import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── IN-MEMORY CACHE ─────────────────────────────────────
const cache = new Map();

function getCacheTtl(range) {
  if (range === 'live') return 5 * 1000; // 5s for live
  if (range === '1d') return 60 * 1000; // 1 min for 1d
  return 30 * 60 * 1000; // 30 min for others
}

function getCached(key, range) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > getCacheTtl(range)) { cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ── VALID RANGES ─────────────────────────────────────────
const VALID_RANGES = new Set(['live', '1d', '5d', '1mo', '3mo', '1y', '5y']);

// ── POLYGON RANGE MAPPING ────────────────────────────────
const POLYGON_RANGE_MAP = {
  'live': { multiplier: 1,  timespan: 'minute', hoursBack: 1 },
  '1d':  { multiplier: 5,  timespan: 'minute', daysBack: 1 },
  '5d':  { multiplier: 30, timespan: 'minute', daysBack: 7 },
  '1mo': { multiplier: 1,  timespan: 'day',    daysBack: 35 },
  '3mo': { multiplier: 1,  timespan: 'day',    daysBack: 95 },
  '1y':  { multiplier: 1,  timespan: 'week',   daysBack: 370 },
  '5y':  { multiplier: 1,  timespan: 'week',   daysBack: 1850 },
};

// ── FETCH SPARKLINE FROM POLYGON.IO (primary) ────────────
async function fetchPolygon(ticker, range) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const config = POLYGON_RANGE_MAP[range];
  if (!config) return null;

  try {
    const to = new Date();
    const from = config.hoursBack
      ? new Date(to.getTime() - config.hoursBack * 60 * 60 * 1000)
      : new Date(to.getTime() - config.daysBack * 24 * 60 * 60 * 1000);

    const fmt = d => d.toISOString().split('T')[0]; // YYYY-MM-DD
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${config.multiplier}/${config.timespan}/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${apiKey}`;

    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const data = await r.json();

    if (!data?.results || data.results.length < 2) return null;

    const closes = [];
    const timestamps = [];
    for (const bar of data.results) {
      if (bar.c != null) {
        closes.push(Math.round(bar.c * 100) / 100);
        timestamps.push(Math.floor(bar.t / 1000)); // Polygon uses ms, we store seconds
      }
    }

    if (closes.length < 2) return null;
    return { closes, timestamps };
  } catch {
    return null;
  }
}

// ── YAHOO CRUMB + COOKIE (fallback) ─────────────────────
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

// ── FETCH SPARKLINE FROM YAHOO FINANCE (fallback) ────────
async function fetchYahoo(ticker, range, crumb, cookie) {
  const interval = range === '1d' ? '5m' : (range === '1y' || range === '5y') ? '1wk' : '1d';

  for (const useCrumb of [true, false]) {
    try {
      let url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      };
      if (useCrumb && crumb) {
        url += `&crumb=${encodeURIComponent(crumb)}`;
        if (cookie) headers['Cookie'] = cookie;
      }

      const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!r.ok) {
        if (useCrumb && crumb) continue;
        return null;
      }
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result) {
        if (useCrumb && crumb) continue;
        return null;
      }

      const closes = result.indicators?.quote?.[0]?.close;
      const timestamps = result.timestamp;
      if (!closes || !timestamps || closes.length < 2) return null;

      const filtered = { closes: [], timestamps: [] };
      for (let i = 0; i < closes.length; i++) {
        if (closes[i] != null) {
          filtered.closes.push(Math.round(closes[i] * 100) / 100);
          filtered.timestamps.push(timestamps[i]);
        }
      }

      if (filtered.closes.length < 2) return null;
      return filtered;
    } catch {
      if (useCrumb && crumb) continue;
      return null;
    }
  }
  return null;
}

// ── COMBINED FETCH (Polygon primary, Yahoo fallback) ─────
async function fetchSparkline(ticker, range, crumb, cookie) {
  const cacheKey = `${ticker}:${range}`;
  const cached = getCached(cacheKey, range);
  if (cached) return cached;

  // Try Polygon first
  let result = await fetchPolygon(ticker, range);

  // Fallback to Yahoo
  if (!result) {
    result = await fetchYahoo(ticker, range, crumb, cookie);
  }

  if (result) {
    setCached(cacheKey, result);
  }
  return result;
}

// ── HANDLER ──────────────────────────────────────────────
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
  if (!await checkRateLimit(ip, 'sparkline', 600)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { tickers, range = '1mo' } = req.query;
  if (!tickers) return res.status(400).json({ error: 'No tickers provided' });

  if (!VALID_RANGES.has(range)) {
    return res.status(400).json({ error: 'Invalid range. Use: 1d, 5d, 1mo, 3mo, 1y, 5y' });
  }

  const tickerList = [...new Set(
    tickers.split(',')
      .map(t => t.trim().toUpperCase().replace(/[^A-Z0-9.]/g, ''))
      .filter(t => t.length >= 1 && t.length <= 6 && /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(t))
  )];

  if (tickerList.length === 0) {
    return res.status(400).json({ error: 'No valid tickers provided' });
  }
  if (tickerList.length > 40) {
    return res.status(400).json({ error: 'Too many tickers. Max 40 per request.' });
  }

  // Get Yahoo crumb as fallback
  const { crumb, cookie } = await getCrumb();

  const output = {};
  await Promise.allSettled(
    tickerList.map(async (ticker) => {
      const data = await fetchSparkline(ticker, range, crumb, cookie);
      if (data) output[ticker] = data;
    })
  );

  // Shorter edge cache for live/intraday, longer for historical
  const edgeCache = range === 'live' ? 'no-cache, no-store'
    : range === '1d' ? 's-maxage=60, stale-while-revalidate=30'
    : range === '5d' ? 's-maxage=300, stale-while-revalidate=120'
    : 's-maxage=14400, stale-while-revalidate=1800';
  res.setHeader('Cache-Control', edgeCache);
  return res.status(200).json(output);
}
