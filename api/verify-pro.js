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
// Prevents someone from hammering verify-pro to enumerate valid emails
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

  const secret = process.env.PRO_TOKEN_SECRET;
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
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
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
  const authCk = getAuthFromCookie(req);
  const authToken = authCk?.token || req.headers['x-auth-token'] || '';
  const authEmail = (authCk?.email || req.headers['x-auth-email'] || '').toLowerCase().trim();
  const authTs    = authCk?.ts || req.headers['x-auth-ts'] || '';
  const isAuthenticated = await verifyAuthToken(authEmail, authToken, authTs);
  if (!isAuthenticated) {
    return res.status(401).json({ pro: false, error: 'Authentication required' });
  }
  // Ensure caller can only check their own email
  if (authEmail.toLowerCase().trim() !== email) {
    return res.status(403).json({ pro: false, error: 'Token email mismatch' });
  }

  // Rate limit by IP (secondary defense)
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'verify-pro', 30)) {
    return res.status(429).json({ pro: false, error: 'Too many verification attempts' });
  }

  try {
    // Uses idx_pro_licenses_email index (created in db-setup.js)
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
      encoder.encode(`${email}:${timestamp}`)
    );
    const token = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // Set HttpOnly pro cookie
    const cookieVal = encodeURIComponent(`${email}|${timestamp}|${token}`);
    const secure = process.env.VERCEL_ENV ? '; Secure' : '';
    res.setHeader('Set-Cookie', `pc_pro=${cookieVal}; HttpOnly${secure}; SameSite=Lax; Path=/api; Max-Age=14400`);

    // Don't cache this — it contains a fresh signed token each time
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ pro: true, plan: license.plan, expiresIn: 14400 });

  } catch (err) {
    console.error('[verify-pro] error:', err.message);
    return res.status(500).json({ pro: false, error: 'Server error' });
  }
}
