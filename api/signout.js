import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { extractAuth } from './lib/auth.js';
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

  // Increment session_version to invalidate all existing tokens
  const auth = extractAuth(req);
  if (auth.userId) {
    try {
      await neonSQL(
        'UPDATE users SET session_version = COALESCE(session_version, 1) + 1 WHERE id = $1',
        [auth.userId]
      );
    } catch (e) { /* best-effort — cookie is cleared regardless */ }
  }

  const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
  res.setHeader('Set-Cookie', [
    `pc_auth=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
    `pc_pro=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
  ]);

  return res.status(200).json({ success: true });
}
