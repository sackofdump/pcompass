import { getAllowedOrigin, setSecurityHeaders, checkBodySize } from './lib/cors.js';
import { extractAuth, getProFromCookie, verifyAuthToken, verifyProToken } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';
import { checkRateLimit } from './lib/rate-limit.js';

const VALID_FEATURES = ['pdf', 'picks', 'slots', 'showmore'];

// ── HANDLER ───────────────────────────────────────────────
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

  // ── Require valid auth token (cookie-first, header fallback) ──
  const auth = extractAuth(req);
  const isAuthenticated = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // ── Validate feature param ──
  const { feature } = req.body || {};
  if (!feature || !VALID_FEATURES.includes(feature)) {
    return res.status(400).json({ error: 'Invalid feature. Must be one of: ' + VALID_FEATURES.join(', ') });
  }

  // ── Rate limit: 20/hr per email ──
  const clientKey = `email:${auth.email}`;
  try {
    if (!await checkRateLimit(clientKey, 'check-feature', 20)) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
  } catch (err) {
    console.error('[check-feature] rate limit error:', err.message);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  // ── Verify Pro status (cookie-first, header fallback) ──
  const proCk = getProFromCookie(req);
  const proToken = proCk?.token || req.headers['x-pro-token'] || '';
  const proEmail = (proCk?.email || req.headers['x-pro-email'] || '').toLowerCase().trim();
  const proTs    = proCk?.ts || req.headers['x-pro-ts'] || '';
  const proUserId = proCk?.userId || '';
  let isPro = await verifyProToken(proUserId, proEmail, proToken, proTs);
  // Prevent privilege escalation: pro token email must match authenticated user
  if (isPro && proEmail !== auth.email) isPro = false;
  // Cross-check: pro token userId must match auth userId
  if (isPro && proUserId && proUserId !== auth.userId) isPro = false;
  if (isPro) {
    try {
      const lic = await neonSQL(`SELECT active FROM pro_licenses WHERE LOWER(email) = $1 AND active = true LIMIT 1`, [proEmail]);
      if (lic.length === 0) isPro = false;
    } catch { isPro = false; }
  }

  return res.status(200).json({ allowed: isPro });
}
