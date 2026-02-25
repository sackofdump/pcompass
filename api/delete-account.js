import { getAllowedOrigin, setSecurityHeaders, checkBodySize } from './lib/cors.js';
import { extractAuth, verifyAuthToken } from './lib/auth.js';
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
  if (!checkBodySize(req)) return res.status(413).json({ error: 'Request body too large' });

  try {
    // ── Rate limit by IP + email ──
    const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
    if (!await checkRateLimit(ip, 'delete-account', 10)) {
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    }

    // ── Verify auth token (cookie-first, header fallback) ──
    const auth = extractAuth(req);
    const bodyEmail = (req.body.email || '').toLowerCase().trim();

    // Rate limit: 5 attempts per hour per email
    if (bodyEmail && !await checkRateLimit('email:' + bodyEmail, 'delete-account', 5)) {
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    }

    if (!bodyEmail) return res.status(400).json({ error: 'Email required' });

    // Auth token must match the email being deleted
    if (auth.email.toLowerCase().trim() !== bodyEmail) {
      return res.status(403).json({ error: 'Email mismatch' });
    }

    if (!await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv)) {
      return res.status(401).json({ error: 'Invalid or expired auth token' });
    }

    // ── Invalidate all sessions before deleting ──
    // Increment session_version so any outstanding tokens become invalid immediately
    await neonSQL(`UPDATE users SET session_version = COALESCE(session_version, 1) + 1 WHERE LOWER(email) = $1`, [bodyEmail]);

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

    // Clear auth cookie so it can't be reused
    const secure = process.env.VERCEL_ENV ? '; Secure' : '';
    res.setHeader('Set-Cookie', `pc_auth=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`);

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
}
