// ── CORS ORIGIN ALLOWLIST ────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

// ── IN-MEMORY RATE LIMITER ────────────────────────────────
// Prevents someone from hammering verify-pro to enumerate valid emails
const verifyAttempts = new Map();
const MAX_ATTEMPTS = 10; // per IP per hour
const WINDOW_MS = 60 * 60 * 1000;

function checkVerifyRateLimit(ip) {
  const now = Date.now();
  const record = verifyAttempts.get(ip);
  if (!record || now - record.windowStart > WINDOW_MS) {
    verifyAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= MAX_ATTEMPTS) return false;
  record.count++;
  return true;
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
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── AUTH TOKEN VERIFICATION ──────────────────────────────
async function verifyAuthToken(email, token, timestamp) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (isNaN(ts) || now - ts > 86400) return false;

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

  // ── Require valid auth token ──
  const authToken = req.headers['x-auth-token'] || '';
  const authEmail = req.headers['x-auth-email'] || '';
  const authTs    = req.headers['x-auth-ts']    || '';
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
  if (!checkVerifyRateLimit(ip)) {
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

    // Generate signed HMAC token — expires in 24 hours
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

    // Don't cache this — it contains a fresh signed token each time
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ pro: true, plan: license.plan, token, timestamp, expiresIn: 86400 });

  } catch (err) {
    console.error('[verify-pro] error:', err.message);
    return res.status(500).json({ pro: false, error: 'Server error' });
  }
}
