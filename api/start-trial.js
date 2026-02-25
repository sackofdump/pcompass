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

// ── CORS ORIGIN ALLOWLIST ────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

// ── DB-BACKED RATE LIMITER ───────────────────────────────
async function checkRateLimit(ip, endpoint, maxRequests) {
  try {
    const result = await neonSQL(
      `SELECT COUNT(*)::int AS cnt FROM api_usage WHERE client_key = $1 AND endpoint = $2 AND created_at > NOW() - INTERVAL '1 hour'`,
      [ip, endpoint]
    );
    const count = result[0]?.cnt || 0;
    if (count >= maxRequests) return false;
    await neonSQL(
      `INSERT INTO api_usage (client_key, endpoint) VALUES ($1, $2)`,
      [ip, endpoint]
    );
    return true;
  } catch (e) {
    return false; // fail closed
  }
}

async function neonSQL(sql, params = []) {
  const connStr = process.env.POSTGRES_URL;
  const host = new URL(connStr).hostname;
  const r = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connStr },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  return data.rows || [];
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
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

  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  // ── Require valid auth token (cookie-first, header fallback) ──
  const authCk = getAuthFromCookie(req);
  const authToken = authCk?.token || req.headers['x-auth-token'] || '';
  const authEmail = (authCk?.email || req.headers['x-auth-email'] || '').toLowerCase().trim();
  const authTs    = authCk?.ts || req.headers['x-auth-ts'] || '';
  const isAuthenticated = await verifyAuthToken(authEmail, authToken, authTs);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (authEmail.toLowerCase().trim() !== email) {
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
