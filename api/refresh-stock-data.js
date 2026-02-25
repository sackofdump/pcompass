import { neonSQL } from './lib/neon.js';

// ── ALL TICKERS FROM STOCK_DB (excluding ETFs — they don't have meaningful betas) ──
const STOCK_TICKERS = [
  'AAPL','MSFT','GOOGL','GOOG','META','AMZN','NVDA','AMD','INTC','TSM','AVGO','QCOM','MU',
  'CRM','ORCL','NOW','SNOW','PLTR','HOOD','SOFI','COIN','DKNG','JPM','BAC','GS','V','MA',
  'JNJ','UNH','PFE','LLY','ABBV','MRNA','TSLA','RIVN','NIO','LULU','NKE','COST','WMT',
  'PG','KO','MCD','SBUX','DIS','NFLX','SPOT','UBER','ABNB','XOM','CVX','NEE','BABA','BIDU',
  'CHWY','AMC','GME','DUOL','RBLX','U','APP','PINS','SNAP','RDDT','PYPL','AFRM','UPST','NU',
  'MSTR','MARA','RIOT','AI','BBAI','PATH','SOUN','IONQ','ANET','DDOG','ZS','CRWD','PANW',
  'OKTA','MDB','NET','HCP','ISRG','DXCM','TDOC','HIMS','RXRX','BEAM','CRSP','SHOP','ETSY',
  'W','ONON','DECK','CELH','MNST','LYFT','BKNG','EXPE','LUV','DAL','GM','F','LCID','OXY',
  'COP','SLB','FCX','AA','RTX','NOC','GD','BA','GE','DE','AMT','O','BX','KKR','SCHW','MS',
  'BRK','BRKB','AXP','PEP','MDLZ','CL','IBM','ADBE','SAP','INTU','WDAY','ZM','DOCU','TWLO',
  'BOX','GTLB','TTD','FROG','SMAR','ACHR','JOBY','EXAI','MTCH','IAC','BMBL','LYV','WBD',
  'PARA','EA','TTWO','ATVI','FIS','FISV','GPN','SQ','CVS','CI','HCA','TMO','DHR','SYK',
  'MDT','BSX','REGN','VRTX','BIIB','GILD','ILMN','TGT','HD','LOW','TJX','ULTA','ROST','DG',
  'YUM','CMG','DPZ','HSY','GIS','K','EL','PSX','MPC','VLO','HAL','FSLR','ENPH','SEDG','RUN',
  'HON','MMM','EMR','ITW','UPS','FDX','URI','CARR','LDOS','KTOS','AXON','WFC','C','USB','TFC',
  'COF','DFS','ICE','CME','SPGI','MCO','SPG','EQR','AVB','DLR','EQIX','DUK','SO','AEP','EXC',
  'PCG','NUE','X','CLF','MP','MELI','SE','PDD','JD','TCOM','HUT','CLSK','PGR','ALL','MET',
  'AFL','PRU','CB','TRV','AON','MMC','S','CYBR','FTNT','CHKP','RPD',
  // New additions
  'T','VZ','TMUS','ON','SMCI','ARM','DELL','HPQ','HPE','LRCX','KLAC','AMAT','MRVL','ADI',
  'NXPI','TXN','ASML','MSCI','TEAM','HUBS','VEEV','BILL','PCTY','PAYC','FOUR','ZTS','A',
  'BDX','EW','GEHC','IQV','IDXX','ALGN','HOLX','MOH','CNC','HUM','DLTR','BBY','AZO','ORLY',
  'CMCSA','CHTR','FOXA','CAT','ETN','PH','ROK','AME','IR','GWW','FAST','WAB','XYL','WM',
  'RSG','VRSK','BR','EOG','PXD','DVN','CTRA','BKR','PNC','MTB','FITB','HBAN','KEY','ALLY',
  'NDAQ','CBOE','PSA','WELL','ARE','CBRE','MAA','STZ','SYY','KHC','TAP','LMT','LHX','HII',
  'TDG','HWM','TLRY','CGC','RKLB','LUNR','RDW','FLUT','MGM','WYNN','LVS','CZR','LI','XPEV',
  'BILI','GRAB','GLOB','ZIM','LIN','APD','DOW','DD','SHW','ECL','PPG','ADM','MOS','CF',
  'RH','CPRT',
];

// ── YAHOO FINANCE FETCHER ──────────────────────────────────
async function fetchHistorical(ticker, range = '6mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const closes = result.indicators?.quote?.[0]?.close;
  if (!closes || closes.length < 20) return null;
  // Filter out null values (holidays/missing data)
  return closes.filter(c => c != null);
}

// ── COMPUTE DAILY RETURNS ──────────────────────────────────
function dailyReturns(closes) {
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) continue;
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return returns;
}

// ── COMPUTE BETA VS SPY ────────────────────────────────────
function computeBeta(stockReturns, spyReturns) {
  // Align lengths (use the shorter of the two)
  const len = Math.min(stockReturns.length, spyReturns.length);
  if (len < 15) return null; // Need enough data points
  const sr = stockReturns.slice(-len);
  const mr = spyReturns.slice(-len);

  const avgStock = sr.reduce((a, b) => a + b, 0) / len;
  const avgMarket = mr.reduce((a, b) => a + b, 0) / len;

  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < len; i++) {
    const dStock = sr[i] - avgStock;
    const dMarket = mr[i] - avgMarket;
    covariance += dStock * dMarket;
    variance += dMarket * dMarket;
  }
  covariance /= len;
  variance /= len;

  if (variance === 0) return null;
  const beta = covariance / variance;
  // Clamp to reasonable range and round to 2 decimals
  return Math.round(Math.max(-1, Math.min(4, beta)) * 100) / 100;
}

// ── FETCH 1-DAY DATA FOR PICKS SCORING ─────────────────────
async function fetchQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const volume = result.indicators?.quote?.[0]?.volume;
    const closes = result.indicators?.quote?.[0]?.close;
    const avgVolume = volume && volume.length > 1
      ? volume.slice(0, -1).reduce((a, b) => a + (b || 0), 0) / (volume.length - 1)
      : 0;
    const latestVolume = volume ? volume[volume.length - 1] || 0 : 0;
    const price = meta?.regularMarketPrice || 0;
    const prev = meta?.chartPreviousClose || 0;
    const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    // 5-day momentum: first close vs last close
    const validCloses = closes ? closes.filter(c => c != null) : [];
    const momentum5d = validCloses.length >= 2
      ? ((validCloses[validCloses.length - 1] - validCloses[0]) / validCloses[0]) * 100
      : 0;
    return { price, changePct, momentum5d, latestVolume, avgVolume };
  } catch {
    return null;
  }
}

// ── STOCK_DB STATIC INFO (sector, name, cap) ───────────────
// Minimal copy for picks generation (matches public/data.js)
const STOCK_INFO = {
  AAPL:{name:'Apple',sector:'Big Tech',cap:'mega'},MSFT:{name:'Microsoft',sector:'Big Tech',cap:'mega'},
  GOOGL:{name:'Alphabet',sector:'Big Tech',cap:'mega'},META:{name:'Meta',sector:'Big Tech',cap:'mega'},
  AMZN:{name:'Amazon',sector:'E-Commerce',cap:'mega'},NVDA:{name:'NVIDIA',sector:'Semiconductors',cap:'mega'},
  AMD:{name:'AMD',sector:'Semiconductors',cap:'large'},INTC:{name:'Intel',sector:'Semiconductors',cap:'large'},
  TSM:{name:'TSMC',sector:'Semiconductors',cap:'mega'},AVGO:{name:'Broadcom',sector:'Semiconductors',cap:'mega'},
  QCOM:{name:'Qualcomm',sector:'Semiconductors',cap:'large'},MU:{name:'Micron',sector:'Semiconductors',cap:'large'},
  CRM:{name:'Salesforce',sector:'Software / SaaS',cap:'large'},ORCL:{name:'Oracle',sector:'Software / SaaS',cap:'mega'},
  NOW:{name:'ServiceNow',sector:'Software / SaaS',cap:'large'},SNOW:{name:'Snowflake',sector:'Software / SaaS',cap:'large'},
  PLTR:{name:'Palantir',sector:'AI & Robotics',cap:'large'},HOOD:{name:'Robinhood',sector:'Fintech',cap:'mid'},
  SOFI:{name:'SoFi',sector:'Fintech',cap:'mid'},COIN:{name:'Coinbase',sector:'Crypto / Bitcoin',cap:'large'},
  DKNG:{name:'DraftKings',sector:'Sports Betting',cap:'mid'},JPM:{name:'JPMorgan',sector:'Banking',cap:'mega'},
  BAC:{name:'Bank of America',sector:'Banking',cap:'mega'},GS:{name:'Goldman Sachs',sector:'Banking',cap:'large'},
  V:{name:'Visa',sector:'Banking',cap:'mega'},MA:{name:'Mastercard',sector:'Banking',cap:'mega'},
  JNJ:{name:"J&J",sector:'Healthcare',cap:'mega'},UNH:{name:'UnitedHealth',sector:'Healthcare',cap:'mega'},
  PFE:{name:'Pfizer',sector:'Healthcare',cap:'mega'},LLY:{name:'Eli Lilly',sector:'Healthcare',cap:'mega'},
  ABBV:{name:'AbbVie',sector:'Healthcare',cap:'large'},MRNA:{name:'Moderna',sector:'Biotech',cap:'large'},
  TSLA:{name:'Tesla',sector:'EVs & Autos',cap:'mega'},RIVN:{name:'Rivian',sector:'EVs & Autos',cap:'mid'},
  NIO:{name:'NIO',sector:'EVs & Autos',cap:'mid'},LULU:{name:'Lululemon',sector:'Apparel',cap:'large'},
  NKE:{name:'Nike',sector:'Apparel',cap:'large'},COST:{name:'Costco',sector:'Retail',cap:'mega'},
  WMT:{name:'Walmart',sector:'Consumer Staples',cap:'mega'},PG:{name:'P&G',sector:'Consumer Staples',cap:'mega'},
  KO:{name:'Coca-Cola',sector:'Consumer Staples',cap:'mega'},MCD:{name:"McDonald's",sector:'Food & Beverage',cap:'mega'},
  SBUX:{name:'Starbucks',sector:'Food & Beverage',cap:'large'},DIS:{name:'Disney',sector:'Entertainment',cap:'large'},
  NFLX:{name:'Netflix',sector:'Entertainment',cap:'mega'},SPOT:{name:'Spotify',sector:'Entertainment',cap:'large'},
  UBER:{name:'Uber',sector:'Travel & Mobility',cap:'large'},ABNB:{name:'Airbnb',sector:'Travel & Mobility',cap:'large'},
  XOM:{name:'ExxonMobil',sector:'Oil & Gas',cap:'mega'},CVX:{name:'Chevron',sector:'Oil & Gas',cap:'mega'},
  NEE:{name:'NextEra Energy',sector:'Clean Energy',cap:'mega'},BABA:{name:'Alibaba',sector:'China / Emerging',cap:'large'},
  BIDU:{name:'Baidu',sector:'China / Emerging',cap:'large'},CHWY:{name:'Chewy',sector:'Pets & Specialty',cap:'mid'},
  DUOL:{name:'Duolingo',sector:'Software / SaaS',cap:'mid'},RBLX:{name:'Roblox',sector:'Entertainment',cap:'mid'},
  U:{name:'Unity',sector:'Software / SaaS',cap:'mid'},APP:{name:'AppLovin',sector:'Software / SaaS',cap:'large'},
  PINS:{name:'Pinterest',sector:'Social Media',cap:'mid'},SNAP:{name:'Snap',sector:'Social Media',cap:'mid'},
  RDDT:{name:'Reddit',sector:'Social Media',cap:'mid'},PYPL:{name:'PayPal',sector:'Fintech',cap:'large'},
  AFRM:{name:'Affirm',sector:'Fintech',cap:'mid'},UPST:{name:'Upstart',sector:'Fintech',cap:'small'},
  NU:{name:'Nubank',sector:'Fintech',cap:'large'},MSTR:{name:'MicroStrategy',sector:'Crypto / Bitcoin',cap:'mid'},
  AI:{name:'C3.ai',sector:'AI & Robotics',cap:'small'},SOUN:{name:'SoundHound AI',sector:'AI & Robotics',cap:'small'},
  IONQ:{name:'IonQ',sector:'AI & Robotics',cap:'small'},ANET:{name:'Arista Networks',sector:'Software / SaaS',cap:'large'},
  DDOG:{name:'Datadog',sector:'Software / SaaS',cap:'large'},ZS:{name:'Zscaler',sector:'Cybersecurity',cap:'large'},
  CRWD:{name:'CrowdStrike',sector:'Cybersecurity',cap:'large'},PANW:{name:'Palo Alto Networks',sector:'Cybersecurity',cap:'large'},
  NET:{name:'Cloudflare',sector:'Cybersecurity',cap:'large'},MDB:{name:'MongoDB',sector:'Software / SaaS',cap:'mid'},
  ISRG:{name:'Intuitive Surgical',sector:'Healthcare',cap:'large'},SHOP:{name:'Shopify',sector:'E-Commerce',cap:'large'},
  MELI:{name:'MercadoLibre',sector:'E-Commerce',cap:'large'},SE:{name:'Sea Limited',sector:'E-Commerce',cap:'large'},
  HD:{name:'Home Depot',sector:'Retail',cap:'mega'},LOW:{name:"Lowe's",sector:'Retail',cap:'large'},
  TGT:{name:'Target',sector:'Retail',cap:'large'},ADBE:{name:'Adobe',sector:'Software / SaaS',cap:'mega'},
  INTU:{name:'Intuit',sector:'Software / SaaS',cap:'large'},IBM:{name:'IBM',sector:'Software / SaaS',cap:'large'},
  BA:{name:'Boeing',sector:'Industrials',cap:'large'},GE:{name:'GE Aerospace',sector:'Industrials',cap:'large'},
  HON:{name:'Honeywell',sector:'Industrials',cap:'mega'},RTX:{name:'RTX (Raytheon)',sector:'Defense',cap:'mega'},
  NOC:{name:'Northrop Grumman',sector:'Defense',cap:'large'},AXON:{name:'Axon Enterprise',sector:'Defense',cap:'large'},
  SQ:{name:'Block (Square)',sector:'Fintech',cap:'large'},TTD:{name:'The Trade Desk',sector:'Software / SaaS',cap:'large'},
  CELH:{name:'Celsius Holdings',sector:'Food & Beverage',cap:'mid'},ONON:{name:'On Running',sector:'Apparel',cap:'mid'},
  DECK:{name:'Deckers (Hoka/UGG)',sector:'Apparel',cap:'large'},CMG:{name:'Chipotle',sector:'Food & Beverage',cap:'large'},
  FSLR:{name:'First Solar',sector:'Clean Energy',cap:'large'},ENPH:{name:'Enphase Energy',sector:'Clean Energy',cap:'mid'},
  BX:{name:'Blackstone',sector:'Banking',cap:'mega'},KKR:{name:'KKR',sector:'Banking',cap:'large'},
  WFC:{name:'Wells Fargo',sector:'Banking',cap:'mega'},C:{name:'Citigroup',sector:'Banking',cap:'large'},
  COF:{name:'Capital One',sector:'Banking',cap:'large'},SPGI:{name:'S&P Global',sector:'Banking',cap:'mega'},
  PGR:{name:'Progressive',sector:'Insurance',cap:'large'},CB:{name:'Chubb',sector:'Insurance',cap:'mega'},
  FTNT:{name:'Fortinet',sector:'Cybersecurity',cap:'large'},CYBR:{name:'CyberArk',sector:'Cybersecurity',cap:'mid'},
  BKNG:{name:'Booking Holdings',sector:'Travel & Mobility',cap:'large'},HIMS:{name:'Hims & Hers',sector:'Healthcare',cap:'mid'},
};

// ── GENERATE STOCK PICKS ───────────────────────────────────
// Score stocks by momentum, volume surge, sector diversity, and cap size
async function generatePicks(betas) {
  // Pick candidates: large/mega cap stocks only (more reliable, more relevant)
  const candidates = STOCK_TICKERS.filter(t => {
    const info = STOCK_INFO[t];
    return info && (info.cap === 'mega' || info.cap === 'large');
  });

  // Fetch recent quotes for top candidates (batch of 20)
  const topCandidates = candidates.slice(0, 40);
  const quotes = {};
  const BATCH = 10;
  for (let i = 0; i < topCandidates.length; i += BATCH) {
    const batch = topCandidates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async t => [t, await fetchQuote(t)]));
    for (const [t, q] of results) {
      if (q) quotes[t] = q;
    }
  }

  // Score each candidate
  const scored = [];
  const seenSectors = new Set();

  for (const ticker of topCandidates) {
    const info = STOCK_INFO[ticker];
    const quote = quotes[ticker];
    if (!info || !quote) continue;

    let score = 50;
    // Momentum boost (5-day)
    score += Math.min(20, Math.max(-10, quote.momentum5d * 2));
    // Volume surge (above average = interesting)
    if (quote.avgVolume > 0 && quote.latestVolume > quote.avgVolume * 1.2) {
      score += 10;
    }
    // Mega cap slight boost (stability)
    if (info.cap === 'mega') score += 5;
    // Penalize extreme volatility
    const beta = betas[ticker];
    if (beta && beta > 2.0) score -= 10;

    scored.push({ ticker, score, sector: info.sector, beta: beta || 1.0 });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Pick top 5 across different sectors
  const picks = [];
  for (const item of scored) {
    if (picks.length >= 5) break;
    if (seenSectors.has(item.sector)) continue;
    seenSectors.add(item.sector);

    const info = STOCK_INFO[item.ticker];
    const beta = item.beta;
    const risk = beta < 0.8 ? 'Low' : beta < 1.2 ? 'Medium' : beta < 1.6 ? 'High' : 'Very High';

    // Build avoidIfHeld list: same ticker + related ETFs
    const avoidIfHeld = [item.ticker];
    const sectorETFs = {
      'Semiconductors': ['SMH', 'SOXX'],
      'Big Tech': ['QQQ', 'XLK'],
      'Software / SaaS': ['IGV', 'QQQ'],
      'AI & Robotics': ['ARKK'],
      'Banking': ['XLF'],
      'Healthcare': ['XLV'],
      'Oil & Gas': ['XLE'],
      'Fintech': ['FINX'],
      'Biotech': ['XBI', 'ARKG'],
      'EVs & Autos': ['ARKK'],
      'Crypto / Bitcoin': ['IBIT', 'BITO'],
      'Cybersecurity': ['IGV'],
    };
    if (sectorETFs[info.sector]) avoidIfHeld.push(...sectorETFs[info.sector]);

    // Generate a brief description
    const descs = {
      'Big Tech': 'Mega-cap tech leader with strong moat',
      'Semiconductors': 'Chip industry momentum play',
      'Software / SaaS': 'Cloud/SaaS growth with recurring revenue',
      'AI & Robotics': 'AI sector exposure with growth potential',
      'Banking': 'Financial sector strength',
      'Healthcare': 'Healthcare sector stability and growth',
      'Fintech': 'Financial innovation and disruption',
      'Oil & Gas': 'Energy sector cash flow play',
      'Clean Energy': 'Renewable energy transition play',
      'Entertainment': 'Consumer media and entertainment',
      'E-Commerce': 'Digital commerce growth',
      'Consumer Staples': 'Defensive positioning with dividends',
      'Retail': 'Consumer spending momentum',
      'EVs & Autos': 'Electric vehicle transition play',
      'Apparel': 'Consumer brand strength',
      'Travel & Mobility': 'Travel recovery momentum',
      'Defense': 'Defense spending tailwind',
      'Industrials': 'Industrial infrastructure build',
      'Cybersecurity': 'Cybersecurity demand growth',
      'Biotech': 'Biotech innovation pipeline',
      'Food & Beverage': 'Consumer staples with growth',
      'Insurance': 'Insurance sector stability',
    };
    const desc = descs[info.sector] || 'Strong momentum and fundamentals';

    picks.push({
      ticker: item.ticker,
      name: info.name,
      sector: info.sector,
      risk,
      desc,
      avoidIfHeld,
    });
  }

  return picks;
}

// ── BATCH PROCESSING ───────────────────────────────────────
async function fetchBetasInBatches(spyReturns) {
  const betas = {};
  const BATCH = 10;
  let fetched = 0;
  let failed = 0;

  for (let i = 0; i < STOCK_TICKERS.length; i += BATCH) {
    const batch = STOCK_TICKERS.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async ticker => {
        try {
          const closes = await fetchHistorical(ticker);
          if (!closes) return [ticker, null];
          const returns = dailyReturns(closes);
          const beta = computeBeta(returns, spyReturns);
          return [ticker, beta];
        } catch {
          return [ticker, null];
        }
      })
    );
    for (const [ticker, beta] of results) {
      if (beta != null) {
        betas[ticker] = beta;
        fetched++;
      } else {
        failed++;
      }
    }
  }

  console.log(`[refresh-stock-data] Betas: ${fetched} fetched, ${failed} failed`);
  return betas;
}

// ── HANDLER ────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only allow GET (Vercel cron sends GET)
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify this is a Vercel cron call or manual trigger
  // In production, Vercel sets this header for cron invocations
  const isCron = req.headers['x-vercel-cron'] === '1';
  const isManual = req.headers['x-manual-trigger'] === 'true';
  if (process.env.VERCEL_ENV === 'production' && !isCron && !isManual) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const startTime = Date.now();
  console.log('[refresh-stock-data] Starting refresh...');

  try {
    // Step 1: Fetch SPY historical data (benchmark)
    const spyCloses = await fetchHistorical('SPY');
    if (!spyCloses) {
      return res.status(500).json({ error: 'Failed to fetch SPY data' });
    }
    const spyReturns = dailyReturns(spyCloses);
    console.log(`[refresh-stock-data] SPY: ${spyReturns.length} daily returns`);

    // Step 2: Fetch all stock betas in batches
    const betas = await fetchBetasInBatches(spyReturns);

    // Step 3: Generate fresh stock picks
    const picks = await generatePicks(betas);

    // Step 4: Store in DB (upsert)
    await neonSQL(
      `INSERT INTO stock_data (key, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      ['betas', JSON.stringify(betas)]
    );

    await neonSQL(
      `INSERT INTO stock_data (key, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      ['picks', JSON.stringify(picks)]
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[refresh-stock-data] Done in ${elapsed}s — ${Object.keys(betas).length} betas, ${picks.length} picks`);

    return res.status(200).json({
      success: true,
      betas: Object.keys(betas).length,
      picks: picks.length,
      elapsed: `${elapsed}s`,
    });
  } catch (err) {
    console.error('[refresh-stock-data] Error:', err.message);
    return res.status(500).json({ error: 'Refresh failed', message: err.message });
  }
}
