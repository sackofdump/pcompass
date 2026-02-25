import * as jose from 'jose';
import { getAllowedOrigin, setSecurityHeaders, checkBodySize } from './lib/cors.js';
import { neonSQL } from './lib/neon.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── GOOGLE JWKS (cached) ────────────────────────────────
const GOOGLE_JWKS = jose.createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

export default async function handler(req, res) {
  if (!GOOGLE_CLIENT_ID) {
    console.error('GOOGLE_CLIENT_ID not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }
  // ── CORS with origin allowlist ──
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
  if (!checkBodySize(req)) return res.status(413).json({ error: 'Request body too large' });

  // ── Rate limit by IP ──
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'auth', 20)) {
    return res.status(429).json({ error: 'Too many authentication attempts' });
  }

  const { credential, code } = req.body;

  let googleId, email, name, picture;
  let rawIdToken = null; // For iOS native relay

  try {
    if (code) {
      // Authorization code flow (iOS) — exchange code for tokens
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET not configured');

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: clientSecret,
          redirect_uri: 'https://pcompass.vercel.app',
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.id_token) {
        console.error('Code exchange failed:', tokenData);
        return res.status(400).json({ error: 'Code exchange failed' });
      }
      rawIdToken = tokenData.id_token;

      // Verify the exchanged ID token
      const { payload } = await jose.jwtVerify(rawIdToken, GOOGLE_JWKS, {
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

    } else if (credential) {
      // GIS credential flow (web) — verify ID token directly
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
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture },
      ...(rawIdToken && { idToken: rawIdToken }),
    });
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
}
