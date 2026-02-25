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
    // Uses idx_pro_licenses_email index
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
    res.setHeader('Set-Cookie', `pc_pro=${cookieVal}; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=14400`);

    // Don't cache this — it contains a fresh signed token each time
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ pro: true, plan: license.plan, expiresIn: 14400 });

  } catch (err) {
    console.error('[verify-pro] error:', err.message);
    return res.status(500).json({ pro: false, error: 'Server error' });
  }
}
