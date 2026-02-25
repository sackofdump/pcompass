import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { extractAuth, verifyAuthToken } from './lib/auth.js';
import { checkRateLimit } from './lib/rate-limit.js';
import { neonSQL } from './lib/neon.js';

export default async function handler(req, res) {
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

  // Rate limit by IP
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'signout', 20)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Verify auth token before performing DB write to prevent forced logout of other users
  const auth = extractAuth(req);
  if (auth.userId && auth.token && auth.email && auth.ts) {
    const valid = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
    if (valid) {
      try {
        await neonSQL(
          'UPDATE users SET session_version = COALESCE(session_version, 1) + 1 WHERE id = $1',
          [auth.userId]
        );
      } catch (e) { /* best-effort — cookie is cleared regardless */ }
    }
  }

  const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
  res.setHeader('Set-Cookie', [
    `pc_auth=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
    `pc_pro=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
  ]);

  return res.status(200).json({ success: true });
}
