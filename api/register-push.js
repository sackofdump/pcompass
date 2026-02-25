import { getAllowedOrigin, setSecurityHeaders, checkBodySize } from './lib/cors.js';
import { extractAuth, verifyAuthToken } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';
import { checkRateLimit } from './lib/rate-limit.js';

export default async function handler(req, res) {
  // CORS
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
    return res.status(204).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkBodySize(req)) return res.status(413).json({ error: 'Request body too large' });

  // ── Require valid auth token (cookie-first, header fallback) ──
  const auth = extractAuth(req);
  const isAuthenticated = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    // Rate limit by IP
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',').pop()?.trim() || 'unknown';
    if (!await checkRateLimit(ip, 'register-push', 20)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const { token, email, platform } = req.body || {};

    // Validate token format
    if (!token || typeof token !== 'string' || !token.startsWith('ExponentPushToken[')) {
      return res.status(400).json({ error: 'Invalid push token format' });
    }

    // Validate token length (ExponentPushToken[...] is typically ~50 chars)
    if (token.length > 100) {
      return res.status(400).json({ error: 'Token too long' });
    }

    // Use authenticated email, not client-provided email
    const cleanEmail = auth.email || (email ? String(email).toLowerCase().trim().slice(0, 255) : null);
    const cleanPlatform = (platform && typeof platform === 'string') ? platform.slice(0, 20) : 'ios';

    // Upsert token
    await neonSQL(
      `INSERT INTO push_tokens (token, email, platform, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (token) DO UPDATE SET
         email = COALESCE($2, push_tokens.email),
         platform = $3,
         updated_at = NOW()`,
      [token, cleanEmail, cleanPlatform]
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[register-push] error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
