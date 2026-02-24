import * as jose from 'jose';

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
const authAttempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 60 * 60 * 1000;

function checkAuthRateLimit(ip) {
  const now = Date.now();
  const record = authAttempts.get(ip);
  if (!record || now - record.windowStart > WINDOW_MS) {
    authAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= MAX_ATTEMPTS) return false;
  record.count++;
  return true;
}

// ── NEON SQL HELPER ──────────────────────────────────────
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

// ── APPLE JWKS (cached) ─────────────────────────────────
const APPLE_JWKS = jose.createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Rate limit ──
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!checkAuthRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many authentication attempts' });
  }

  const { id_token, user: appleUser } = req.body;

  if (!id_token) {
    return res.status(400).json({ error: 'No id_token provided' });
  }

  try {
    // Verify Apple id_token JWT against Apple's public keys
    const { payload } = await jose.jwtVerify(id_token, APPLE_JWKS, {
      issuer: 'https://appleid.apple.com',
      audience: process.env.APPLE_SERVICE_ID,
    });

    const appleId = payload.sub;
    const email = payload.email;

    if (!appleId || !email) {
      return res.status(401).json({ error: 'Token missing user info' });
    }

    // Name is only sent on first sign-in (from the user object, not the JWT)
    let name = email.split('@')[0];
    if (appleUser && appleUser.name) {
      const first = appleUser.name.firstName || '';
      const last = appleUser.name.lastName || '';
      name = (first + ' ' + last).trim() || name;
    }

    // Upsert user — try apple_id first, fall back to email match
    // This handles: new Apple user, returning Apple user, and Google user adding Apple
    const users = await neonSQL(
      `INSERT INTO users (apple_id, email, name, picture, last_login)
       VALUES ($1, $2, $3, '', NOW())
       ON CONFLICT (email) DO UPDATE SET
         apple_id = COALESCE(users.apple_id, $1),
         last_login = NOW(),
         name = CASE WHEN users.name IS NULL OR users.name = '' THEN $3 ELSE users.name END
       RETURNING id, email, name, picture`,
      [appleId, email, name]
    );

    const user = users[0];

    // Generate HMAC-signed auth token (24hr expiry)
    // 'auth:' prefix prevents cross-use with Pro tokens
    const authTs = Math.floor(Date.now() / 1000);
    const secret = process.env.PRO_TOKEN_SECRET;
    if (!secret) throw new Error('PRO_TOKEN_SECRET not configured');
    const enc = new TextEncoder();
    const authKey = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const authSig = await crypto.subtle.sign(
      'HMAC', authKey,
      enc.encode(`auth:${email.toLowerCase().trim()}:${authTs}`)
    );
    const authToken = Array.from(new Uint8Array(authSig))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture || '' },
      authToken,
      authTs,
    });
  } catch (err) {
    console.error('Apple auth error:', err);
    res.status(401).json({ error: 'Apple authentication failed' });
  }
}
