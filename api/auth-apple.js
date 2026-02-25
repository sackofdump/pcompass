import * as jose from 'jose';
import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { neonSQL } from './lib/neon.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── APPLE JWKS (cached) ─────────────────────────────────
const APPLE_JWKS = jose.createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);

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

  // ── Rate limit ──
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'auth-apple', 20)) {
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

    // Apple requires email_verified check
    if (payload.email_verified === false || payload.email_verified === 'false') {
      return res.status(401).json({ error: 'Unverified email' });
    }

    // Name is only sent on first sign-in (from the user object, not the JWT)
    let name = email.split('@')[0];
    if (appleUser && appleUser.name) {
      const first = appleUser.name.firstName || '';
      const last = appleUser.name.lastName || '';
      name = (first + ' ' + last).trim() || name;
    }

    // Upsert user — try apple_id first, then fall back to email match.
    // This avoids edge cases where two Apple IDs share an email alias.
    let users = await neonSQL(
      `UPDATE users SET last_login = NOW() WHERE apple_id = $1
       RETURNING id, email, name, picture`,
      [appleId]
    );

    if (users.length === 0) {
      // Not found by apple_id — upsert by email (new Apple user or Google user adding Apple)
      users = await neonSQL(
        `INSERT INTO users (apple_id, email, name, picture, last_login)
         VALUES ($1, $2, $3, '', NOW())
         ON CONFLICT (email) DO UPDATE SET
           apple_id = COALESCE(users.apple_id, $1),
           last_login = NOW(),
           name = CASE WHEN users.name IS NULL OR users.name = '' THEN $3 ELSE users.name END
         RETURNING id, email, name, picture`,
        [appleId, email, name]
      );
    }

    const user = users[0];

    // Generate HMAC-signed auth token (4hr expiry)
    // 'auth:' prefix prevents cross-use with Pro tokens
    const authTs = Math.floor(Date.now() / 1000);
    const secret = process.env.AUTH_TOKEN_SECRET;
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
    res.setHeader('Set-Cookie', `pc_auth=${cookieVal}; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=14400`);

    res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture || '' },
    });
  } catch (err) {
    console.error('Apple auth error:', err.message);
    res.status(401).json({ error: 'Apple authentication failed' });
  }
}
