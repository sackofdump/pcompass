import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { getAuthFromCookie, verifyAuthToken } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';
import { checkRateLimit } from './lib/rate-limit.js';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pro-Token, X-Pro-Email, X-Pro-Ts, X-Auth-Token, X-Auth-Email, X-Auth-Ts');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── Verify auth token (cookie-first, header fallback) ──
    const authCk = getAuthFromCookie(req);
    const authToken = authCk?.token || req.headers['x-auth-token'] || '';
    const authEmail = (authCk?.email || req.headers['x-auth-email'] || '').toLowerCase().trim();
    const authTs    = authCk?.ts || req.headers['x-auth-ts'] || '';
    const bodyEmail = (req.body.email || '').toLowerCase().trim();

    // Rate limit: 5 attempts per hour per email
    if (bodyEmail && !await checkRateLimit('email:' + bodyEmail, 'delete-account', 5)) {
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    }

    if (!bodyEmail) return res.status(400).json({ error: 'Email required' });

    // Auth token must match the email being deleted
    if (authEmail.toLowerCase().trim() !== bodyEmail) {
      return res.status(403).json({ error: 'Email mismatch' });
    }

    if (!await verifyAuthToken(authEmail, authToken, authTs)) {
      return res.status(401).json({ error: 'Invalid or expired auth token' });
    }

    // ── Delete user data ──
    // portfolios are ON DELETE CASCADE from users table
    // Delete pro license first (no FK)
    await neonSQL(`DELETE FROM pro_licenses WHERE LOWER(email) = $1`, [bodyEmail]);

    // Delete api_usage records for this user
    await neonSQL(`DELETE FROM api_usage WHERE client_key = $1`, ['email:' + bodyEmail]);

    // Delete user (cascades to portfolios)
    const deleted = await neonSQL(
      `DELETE FROM users WHERE LOWER(email) = $1 RETURNING id`,
      [bodyEmail]
    );

    if (deleted.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
}
