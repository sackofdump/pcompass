import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { extractAuth, getProFromCookie, verifyAuthToken, verifyProToken } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── PRO-ONLY STOCK PICKS (indices 5-25 from original STOCK_PICKS) ──
const PRO_STOCK_PICKS = [
  {ticker:'V',   name:'Visa',           sector:'Banking',          risk:'Low',    desc:'Global payments network, recession-lite', avoidIfHeld:['V','MA','XLF']},
  {ticker:'COIN',name:'Coinbase',       sector:'Crypto / Bitcoin', risk:'Very High',desc:'Crypto exchange, direct crypto exposure',avoidIfHeld:['COIN','IBIT','BITO']},
  {ticker:'SQ',  name:'Block (Square)', sector:'Fintech',          risk:'High',   desc:'Payments + Bitcoin ecosystem play',       avoidIfHeld:['SQ','HOOD','FINX']},
  {ticker:'LLY', name:'Eli Lilly',      sector:'Healthcare',       risk:'Medium', desc:'GLP-1 weight loss drugs, massive growth', avoidIfHeld:['LLY','XLV']},
  {ticker:'UNH', name:'UnitedHealth',   sector:'Healthcare',       risk:'Low',    desc:'Largest US health insurer, stable cash',  avoidIfHeld:['UNH','XLV']},
  {ticker:'MRNA',name:'Moderna',        sector:'Biotech',          risk:'High',   desc:'mRNA platform beyond COVID vaccines',     avoidIfHeld:['MRNA','XBI']},
  {ticker:'AMZN',name:'Amazon',         sector:'E-Commerce',       risk:'Medium', desc:'E-commerce + AWS cloud dominance',        avoidIfHeld:['AMZN','QQQ']},
  {ticker:'COST',name:'Costco',         sector:'Retail',           risk:'Low',    desc:'Membership retail, recession-resistant',  avoidIfHeld:['COST','XLP']},
  {ticker:'SBUX',name:'Starbucks',      sector:'Food & Beverage',  risk:'Medium', desc:'Brand recovery + international expansion',avoidIfHeld:['SBUX']},
  {ticker:'XOM', name:'ExxonMobil',     sector:'Oil & Gas',        risk:'Medium', desc:'Dividend king, energy price hedge',       avoidIfHeld:['XOM','XLE']},
  {ticker:'NEE', name:'NextEra Energy', sector:'Clean Energy',     risk:'Low',    desc:'Largest renewable energy utility in US',  avoidIfHeld:['NEE','ICLN']},
  {ticker:'NEM', name:'Newmont',        sector:'Gold & Metals',    risk:'Medium', desc:'Gold mining hedge against inflation',     avoidIfHeld:['NEM','GLD','GDX']},
  {ticker:'LMT', name:'Lockheed Martin',sector:'Defense',          risk:'Low',    desc:'Defense spending, geopolitical hedge',   avoidIfHeld:['LMT','XLI']},
  {ticker:'CAT', name:'Caterpillar',    sector:'Industrials',      risk:'Medium', desc:'Infrastructure spending + global demand', avoidIfHeld:['CAT','XLI']},
  {ticker:'JNJ', name:'J&J',           sector:'Healthcare',        risk:'Low',    desc:'Diversified pharma + medtech, steady div',avoidIfHeld:['JNJ','XLV']},
  {ticker:'KO',  name:'Coca-Cola',      sector:'Consumer Staples', risk:'Low',    desc:'Recession-proof consumer staple',        avoidIfHeld:['KO','XLP']},
  {ticker:'PLD', name:'Prologis',       sector:'Real Estate',      risk:'Low',    desc:'E-commerce warehouse REIT, stable income',avoidIfHeld:['PLD','XLRE']},
  {ticker:'BABA',name:'Alibaba',        sector:'China / Emerging', risk:'High',   desc:'Chinese e-commerce at deep discount',    avoidIfHeld:['BABA','VWO','KWEB']},
  {ticker:'ABNB',name:'Airbnb',         sector:'Travel & Mobility',risk:'Medium', desc:'Asset-light travel platform, high margins',avoidIfHeld:['ABNB']},
  {ticker:'UBER',name:'Uber',           sector:'Travel & Mobility',risk:'Medium', desc:'Ride-share + delivery global network',   avoidIfHeld:['UBER']},
];

// ── PRO-ONLY ETFs (beyond the first 4 per strategy) ──
const PRO_ETFS = {
  aggressive: [
    {ticker:'QQQ',name:'Invesco QQQ',desc:'Nasdaq-100 mega-cap tech',exp:'0.20%',sectors:['Big Tech','Software / SaaS']},
    {ticker:'SOXX',name:'iShares Semis',desc:'Broad semiconductor ETF',exp:'0.35%',sectors:['Semiconductors']},
    {ticker:'IWM',name:'Russell 2000',desc:'Small-cap growth exposure',exp:'0.19%',sectors:['Small-Caps']},
    {ticker:'CIBR',name:'Cybersecurity ETF',desc:'Pure-play cyber leaders',exp:'0.60%',sectors:['Cybersecurity']},
  ],
  moderate: [
    {ticker:'IGV',name:'iShares Software',desc:'Software & SaaS companies',exp:'0.41%',sectors:['Software / SaaS']},
    {ticker:'RSP',name:'Equal Weight S&P',desc:'S&P 500 with equal weighting',exp:'0.20%',sectors:['Broad Market']},
  ],
  conservative: [
    {ticker:'VNQ',name:'Vanguard REIT',desc:'Real estate investment trusts',exp:'0.12%',sectors:['Real Estate']},
    {ticker:'GLD',name:'SPDR Gold Shares',desc:'Physical gold price tracking',exp:'0.40%',sectors:['Gold & Metals']},
    {ticker:'AGG',name:'Core Bond ETF',desc:'Broad investment-grade bonds',exp:'0.03%',sectors:['Bonds']},
    {ticker:'IAK',name:'Insurance ETF',desc:'US property & life insurers',exp:'0.40%',sectors:['Insurance']},
  ],
};

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pro-Token, X-Pro-Email, X-Pro-Ts, X-Auth-Token, X-Auth-Email, X-Auth-Ts');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit by IP (30 req/hr)
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit('ip:' + ip, 'pro-picks', 30)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // ── Require valid auth token (cookie-first, header fallback) ──
  const auth = extractAuth(req);
  const isAuthenticated = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // ── Verify Pro status (cookie-first, header fallback) ──
  const proCk = getProFromCookie(req);
  const proToken = proCk?.token || req.headers['x-pro-token'] || '';
  const proEmail = (proCk?.email || req.headers['x-pro-email'] || '').toLowerCase().trim();
  const proTs    = proCk?.ts || req.headers['x-pro-ts'] || '';
  let isPro = await verifyProToken(proEmail, proToken, proTs);
  // Prevent privilege escalation: pro token email must match authenticated user
  if (isPro && proEmail !== auth.email) isPro = false;
  if (isPro) {
    try {
      const lic = await neonSQL(`SELECT active FROM pro_licenses WHERE LOWER(email) = $1 AND active = true LIMIT 1`, [proEmail]);
      if (lic.length === 0) isPro = false;
    } catch { isPro = false; }
  }

  if (!isPro) {
    return res.status(403).json({ error: 'Pro subscription required' });
  }

  return res.status(200).json({
    stocks: PRO_STOCK_PICKS,
    etfs: PRO_ETFS,
  });
}
