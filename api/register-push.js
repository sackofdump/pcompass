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
  return r.json();
}

// ── IP-BASED RATE LIMITER (DB-backed) ───────────────────
async function checkRateLimit(ip) {
  const MAX_REQUESTS = 20; // per IP per hour
  try {
    const result = await neonSQL(
      `SELECT COUNT(*) FROM api_usage WHERE client_key = $1 AND endpoint = 'register-push' AND created_at > NOW() - INTERVAL '1 hour'`,
      [ip]
    );
    const count = parseInt(result.rows?.[0]?.[0] || '0');
    if (count >= MAX_REQUESTS) return false;
    await neonSQL(
      `INSERT INTO api_usage (client_key, endpoint) VALUES ($1, 'register-push')`,
      [ip]
    );
    return true;
  } catch (e) {
    // Fail closed — deny if rate limit check fails
    return false;
  }
}

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(204).end();
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

  try {
    // Rate limit by IP
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',').pop()?.trim() || 'unknown';
    if (!await checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const { token, email, platform } = req.body || {};

    // Validate token format
    if (!token || typeof token !== 'string' || !token.startsWith('ExponentPushToken[')) {
      return res.status(400).json({ error: 'Invalid push token format' });
    }

    // Validate token length (ExponentPushToken[...] is typically ~50 chars)
    if (token.length > 100) {
      return res.status(400).json({ error: 'Token too long' });
    }

    // Use authenticated email, not client-provided email
    const cleanEmail = authEmail || (email ? String(email).toLowerCase().trim().slice(0, 255) : null);
    const cleanPlatform = (platform && typeof platform === 'string') ? platform.slice(0, 20) : 'ios';

    // Upsert token
    await neonSQL(
      `INSERT INTO push_tokens (token, email, platform, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (token) DO UPDATE SET
         email = COALESCE($2, push_tokens.email),
         platform = $3,
         updated_at = NOW()`,
      [token, cleanEmail, cleanPlatform]
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[register-push] error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
