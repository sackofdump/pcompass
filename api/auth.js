import * as jose from 'jose';

// ── GOOGLE JWKS (cached) ────────────────────────────────
const GOOGLE_JWKS = jose.createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_CLIENT_ID = '564027426495-8p19f9da30bikcsjje4uv0up59tgf9i5.apps.googleusercontent.com';

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

export default async function handler(req, res) {
  // ── CORS with origin allowlist ──
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
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Rate limit by IP ──
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'auth', 20)) {
    return res.status(429).json({ error: 'Too many authentication attempts' });
  }

  const { credential } = req.body;

  let googleId, email, name, picture;

  try {
    if (credential) {
      // Verify Google ID token locally via JWKS
      const { payload } = await jose.jwtVerify(credential, GOOGLE_JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: GOOGLE_CLIENT_ID,
      });

      if (!payload.sub || !payload.email) {
        return res.status(401).json({ error: 'Token missing user info' });
      }
      googleId = payload.sub;
      email = payload.email;
      name = payload.name || payload.email;
      picture = payload.picture || '';
    } else {
      return res.status(400).json({ error: 'No credential provided' });
    }

    const users = await neonSQL(
      `INSERT INTO users (google_id, email, name, picture, last_login)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (google_id) DO UPDATE SET last_login = NOW(), name = $3, picture = $4
       RETURNING id, email, name, picture`,
      [googleId, email, name, picture]
    );

    const user = users[0];

    // Generate HMAC-signed auth token (24hr expiry)
    // 'auth:' prefix prevents cross-use with Pro tokens
    const authTs = Math.floor(Date.now() / 1000);
    const secret = process.env.AUTH_TOKEN_SECRET || process.env.PRO_TOKEN_SECRET;
    if (!secret) throw new Error('AUTH_TOKEN_SECRET not configured');
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

    // Set HttpOnly auth cookie
    const cookieVal = encodeURIComponent(`${email.toLowerCase().trim()}|${authTs}|${authToken}`);
    const secure = process.env.VERCEL_ENV ? '; Secure' : '';
    res.setHeader('Set-Cookie', `pc_auth=${cookieVal}; HttpOnly${secure}; SameSite=Lax; Path=/api; Max-Age=14400`);

    res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture },
    });
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
}
