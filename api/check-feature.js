// ── COOKIE HELPERS ───────────────────────────────────────
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [key, ...rest] = c.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}
function getAuthFromCookie(req) {
  const c = parseCookies(req);
  if (c.pc_auth) {
    const [e, t, tk] = c.pc_auth.split('|');
    if (e && t && tk) return { email: e, ts: t, token: tk };
  }
  return null;
}
function getProFromCookie(req) {
  const c = parseCookies(req);
  if (c.pc_pro) {
    const [e, t, tk] = c.pc_pro.split('|');
    if (e && t && tk) return { email: e, ts: t, token: tk };
  }
  return null;
}

// ── CORS ORIGIN ALLOWLIST ────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

// ── TIMING-SAFE COMPARISON ──────────────────────────────
function timingSafeEqual(a, b) {
  const maxLen = Math.max(a.length, b.length);
  const aPad = a.padEnd(maxLen, '\0');
  const bPad = b.padEnd(maxLen, '\0');
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    mismatch |= aPad.charCodeAt(i) ^ bPad.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── AUTH TOKEN VERIFICATION ──────────────────────────────
async function verifyAuthToken(email, token, timestamp) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (isNaN(ts) || now - ts > 14400 || ts - now > 300) return false;

  const secret = process.env.AUTH_TOKEN_SECRET || process.env.PRO_TOKEN_SECRET;
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`auth:${email.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return timingSafeEqual(token, expected);
}

// ── PRO TOKEN VERIFICATION ──────────────────────────────
async function verifyProToken(email, token, timestamp) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (isNaN(ts) || now - ts > 14400 || ts - now > 300) return false;

  const secret = process.env.PRO_TOKEN_SECRET;
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${email.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return timingSafeEqual(token, expected);
}

// ── NEON SQL HELPER ──────────────────────────────────────
async function neonSQL(sql, params = []) {
  const connStr = process.env.POSTGRES_URL;
  if (!connStr) throw new Error('POSTGRES_URL not set');
  const host = new URL(connStr).hostname;
  const r = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connStr },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  return data;
}

// ── DB-BACKED RATE LIMITER ───────────────────────────────
async function checkRateLimitDB(clientKey, endpoint, maxRequests, windowMs) {
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  const countResult = await neonSQL(
    `SELECT COUNT(*)::int AS cnt FROM api_usage
     WHERE client_key = $1 AND endpoint = $2 AND created_at > $3`,
    [clientKey, endpoint, windowStart]
  );
  const count = countResult.rows?.[0]?.cnt || 0;

  if (count >= maxRequests) {
    return { allowed: false };
  }

  await neonSQL(
    `INSERT INTO api_usage (client_key, endpoint) VALUES ($1, $2)`,
    [clientKey, endpoint]
  );

  return { allowed: true };
}

const VALID_FEATURES = ['pdf', 'picks', 'slots'];

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
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

  // ── Require valid auth token (cookie-first, header fallback) ──
  const authCk = getAuthFromCookie(req);
  const authToken = authCk?.token || req.headers['x-auth-token'] || '';
  const authEmail = (authCk?.email || req.headers['x-auth-email'] || '').toLowerCase().trim();
  const authTs    = authCk?.ts || req.headers['x-auth-ts'] || '';
  const isAuthenticated = await verifyAuthToken(authEmail, authToken, authTs);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // ── Validate feature param ──
  const { feature } = req.body || {};
  if (!feature || !VALID_FEATURES.includes(feature)) {
    return res.status(400).json({ error: 'Invalid feature. Must be one of: ' + VALID_FEATURES.join(', ') });
  }

  // ── Rate limit: 20/hr per email ──
  const clientKey = `email:${authEmail.toLowerCase().trim()}`;
  try {
    const rateCheck = await checkRateLimitDB(clientKey, 'check-feature', 20, 60 * 60 * 1000);
    if (!rateCheck.allowed) {
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
  let isPro = await verifyProToken(proEmail, proToken, proTs);
  if (isPro) {
    try {
      const lic = await neonSQL(`SELECT active FROM pro_licenses WHERE LOWER(email) = $1 AND active = true LIMIT 1`, [proEmail]);
      if (!lic.rows || lic.rows.length === 0) isPro = false;
    } catch { isPro = false; }
  }

  return res.status(200).json({ allowed: isPro });
}
