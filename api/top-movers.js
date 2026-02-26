import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';

// ── IN-MEMORY CACHE ─────────────────────────────────────
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

// ── BROAD UNIVERSE OF MAJOR STOCKS ──────────────────────
// ~100 high-volume tickers covering all major sectors to find true daily top movers.
// These are the most-traded names across sectors; actual "top movers" are sorted by |changePct|.
const UNIVERSE = [
  // Big Tech
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AVGO','ORCL','CRM',
  'ADBE','INTC','CSCO','IBM','QCOM','TXN','NOW','SHOP','SNOW','PLTR',
  // Semiconductors
  'AMD','MU','MRVL','LRCX','KLAC','AMAT','ARM','SMCI','ON','MCHP',
  // Fintech / Finance
  'JPM','GS','MS','V','MA','PYPL','SQ','COIN','HOOD','SOFI',
  // Consumer / Retail
  'AMZN','WMT','COST','TGT','NKE','SBUX','MCD','DIS','NFLX','ABNB',
  // Healthcare / Biotech
  'JNJ','UNH','PFE','ABBV','LLY','MRK','BMY','GILD','AMGN','MRNA',
  // Energy
  'XOM','CVX','COP','SLB','OXY','MPC','VLO','DVN','FANG','HAL',
  // AI / Software
  'AI','SOUN','PATH','DDOG','NET','ZS','CRWD','PANW','FTNT','OKTA',
  // EV / Auto
  'RIVN','LCID','F','GM','NIO','LI','XPEV',
  // Social / Media
  'RDDT','SNAP','PINS','SPOT','ROKU',
  // Crypto-adjacent
  'MARA','RIOT','MSTR','CLSK',
  // Industrial / Defense
  'BA','LMT','RTX','GE','CAT','DE','HON',
  // Other popular / high-vol
  'APP','UBER','LYFT','DASH','RBLX','U','AFRM','UPST',
];

// Deduplicate
const TICKERS = [...new Set(UNIVERSE)];

// ── FETCH QUOTES VIA FMP ────────────────────────────────
async function fetchQuotes(tickers) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return {};

  const results = {};

  // Fetch in parallel batches of 15 to avoid overwhelming FMP
  for (let i = 0; i < tickers.length; i += 15) {
    const batch = tickers.slice(i, i + 15);
    const settled = await Promise.allSettled(
      batch.map(async (ticker) => {
        try {
          const url = `https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${apiKey}`;
          const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
          if (!r.ok) return;
          const data = await r.json();
          if (Array.isArray(data) && data.length > 0 && data[0].price != null) {
            results[ticker] = {
              price: Math.round(data[0].price * 100) / 100,
              changePct: Math.round((data[0].changePercentage ?? 0) * 100) / 100,
              name: data[0].name || data[0].companyName || ticker,
            };
          }
        } catch { /* skip */ }
      })
    );
  }

  return results;
}

// ── HANDLER ──────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
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

  // Return cached result if fresh
  if (_cache && (Date.now() - _cacheTs < CACHE_TTL_MS)) {
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(_cache);
  }

  try {
    const quotes = await fetchQuotes(TICKERS);
    const movers = [];
    for (const [ticker, q] of Object.entries(quotes)) {
      if (q && q.changePct != null) {
        movers.push({ ticker, changePct: q.changePct, name: q.name, price: q.price });
      }
    }

    // Sort by absolute change descending, take top 8
    movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
    const top = movers.slice(0, 8);

    _cache = top;
    _cacheTs = Date.now();

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(top);
  } catch (e) {
    console.error('[top-movers] error:', e);
    return res.status(500).json({ error: 'Failed to fetch top movers' });
  }
}
