import { getAllowedOrigin, setSecurityHeaders, checkBodySize } from '../lib/cors.js';
import { extractAuth, getProFromCookie, verifyAuthToken, verifyProToken } from '../lib/auth.js';
import { neonSQL } from '../lib/neon.js';
import { checkRateLimit } from '../lib/rate-limit.js';

// ── VALID FEATURES (for check-feature) ──────────────────
const VALID_FEATURES = ['pdf', 'picks', 'slots', 'showmore'];

// ── PRO-ONLY STOCK PICKS (was in api/pro-picks.js) ─────
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

// ── ROUTER ──────────────────────────────────────────────
export default async function handler(req, res) {
  const action = req.query._action || 'verify';
  switch (action) {
    case 'verify': return handleVerify(req, res);
    case 'check-feature': return handleCheckFeature(req, res);
    case 'start-trial': return handleStartTrial(req, res);
    case 'picks': return handlePicks(req, res);
    default: return res.status(400).json({ error: 'Unknown action' });
  }
}

// ════════════════════════════════════════════════════════
// VERIFY PRO (was api/verify-pro.js)
// ════════════════════════════════════════════════════════
async function handleVerify(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, X-Auth-Email, X-Auth-Ts');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // Allow both GET (restore purchases) and POST (checkout verification)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ pro: false, error: 'Method not allowed' });
  }

  const email = ((req.query.email || req.body?.email) || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ pro: false, error: 'Valid email required' });
  }

  // ── Require valid auth token (cookie-first, header fallback) ──
  const auth = extractAuth(req);
  const isAuthenticated = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
  if (!isAuthenticated) {
    return res.status(401).json({ pro: false, error: 'Authentication required' });
  }
  // Ensure caller can only check their own email
  if (auth.email.toLowerCase().trim() !== email) {
    return res.status(403).json({ pro: false, error: 'Token email mismatch' });
  }

  // Rate limit by IP (secondary defense)
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'verify-pro', 30)) {
    return res.status(429).json({ pro: false, error: 'Too many verification attempts' });
  }

  try {
    // Uses idx_pro_licenses_email index
    const rows = await neonSQL(
      `SELECT active, plan FROM pro_licenses WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (rows.length === 0 || !rows[0].active) {
      return res.status(200).json({ pro: false });
    }

    const license = rows[0];

    // Generate signed HMAC token — expires in 4 hours
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = process.env.PRO_TOKEN_SECRET;
    if (!secret) throw new Error('PRO_TOKEN_SECRET not configured');

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign(
      'HMAC', key,
      encoder.encode(`${auth.userId}:${email}:${timestamp}`)
    );
    const token = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // Set HttpOnly pro cookie (format: userId|email|ts|token)
    const cookieVal = encodeURIComponent(`${auth.userId}|${email}|${timestamp}|${token}`);
    const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
    res.setHeader('Set-Cookie', `pc_pro=${cookieVal}; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=14400`);

    // Don't cache this — it contains a fresh signed token each time
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ pro: true, plan: license.plan, expiresIn: 14400 });

  } catch (err) {
    console.error('[verify-pro] error:', err.message);
    return res.status(500).json({ pro: false, error: 'Server error' });
  }
}

// ════════════════════════════════════════════════════════
// CHECK FEATURE (was api/check-feature.js)
// ════════════════════════════════════════════════════════
async function handleCheckFeature(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pro-Token, X-Pro-Email, X-Pro-Ts, X-Auth-Token, X-Auth-Email, X-Auth-Ts');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkBodySize(req)) return res.status(413).json({ error: 'Request body too large' });

  // ── Require valid auth token (cookie-first, header fallback) ──
  const auth = extractAuth(req);
  const isAuthenticated = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // ── Validate feature param ──
  const { feature } = req.body || {};
  if (!feature || !VALID_FEATURES.includes(feature)) {
    return res.status(400).json({ error: 'Invalid feature. Must be one of: ' + VALID_FEATURES.join(', ') });
  }

  // ── Rate limit: 20/hr per email ──
  const clientKey = `email:${auth.email}`;
  try {
    if (!await checkRateLimit(clientKey, 'check-feature', 20)) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
  } catch (err) {
    console.error('[check-feature] rate limit error:', err.message);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  // ── Verify Pro status (cookie-first, header fallback) ──
  const proCk = getProFromCookie(req);
  const proToken = proCk?.token || req.headers['x-pro-token'] || '';
  const proEmail = (proCk?.email || req.headers['x-pro-email'] || '').toLowerCase().trim();
  const proTs    = proCk?.ts || req.headers['x-pro-ts'] || '';
  const proUserId = proCk?.userId || '';
  let isPro = await verifyProToken(proUserId, proEmail, proToken, proTs);
  // Prevent privilege escalation: pro token email must match authenticated user
  if (isPro && proEmail !== auth.email) isPro = false;
  // Cross-check: pro token userId must match auth userId
  if (isPro && proUserId && proUserId !== auth.userId) isPro = false;
  if (isPro) {
    try {
      const lic = await neonSQL(`SELECT active FROM pro_licenses WHERE LOWER(email) = $1 AND active = true LIMIT 1`, [proEmail]);
      if (lic.length === 0) isPro = false;
    } catch { isPro = false; }
  }

  return res.status(200).json({ allowed: isPro });
}

// ════════════════════════════════════════════════════════
// START TRIAL (was api/start-trial.js)
// ════════════════════════════════════════════════════════
async function handleStartTrial(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, X-Auth-Email, X-Auth-Ts');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkBodySize(req)) return res.status(413).json({ error: 'Request body too large' });

  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  // ── Require valid auth token (cookie-first, header fallback) ──
  const auth = extractAuth(req);
  const isAuthenticated = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (auth.email.toLowerCase().trim() !== email) {
    return res.status(403).json({ error: 'Token email mismatch' });
  }

  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'start-trial', 10)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  try {
    // Check if this email already has a trial
    const existing = await neonSQL(
      `SELECT trial_start FROM trials WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (existing.length > 0) {
      const trialStart = existing[0].trial_start;
      const now = Math.floor(Date.now() / 1000);
      const SEVEN_DAYS = 7 * 24 * 60 * 60;

      if (now - trialStart > SEVEN_DAYS) {
        return res.status(200).json({ error: 'trial_used', message: 'Trial already used' });
      }
      // Still active — return existing
      return res.status(200).json({ success: true, trialStart });
    }

    // Start new trial
    const trialStart = Math.floor(Date.now() / 1000);
    await neonSQL(
      `INSERT INTO trials (email, trial_start) VALUES ($1, $2)`,
      [email, trialStart]
    );

    return res.status(200).json({ success: true, trialStart });

  } catch (err) {
    console.error('[start-trial] error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ════════════════════════════════════════════════════════
// PRO PICKS (was api/pro-picks.js)
// ════════════════════════════════════════════════════════
async function handlePicks(req, res) {
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

  return res.status(200).json({
    stocks: PRO_STOCK_PICKS,
    etfs: PRO_ETFS,
  });
}
