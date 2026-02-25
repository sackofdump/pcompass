import { getAllowedOrigin, setSecurityHeaders, checkBodySize } from './lib/cors.js';
import { extractAuth, verifyAuthToken } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';
import { checkRateLimit } from './lib/rate-limit.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, X-Auth-Email, X-Auth-Ts');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkBodySize(req)) return res.status(413).json({ error: 'Request body too large' });

  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  // ── Require valid auth token (cookie-first, header fallback) ──
  const auth = extractAuth(req);
  const isAuthenticated = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (auth.email.toLowerCase().trim() !== email) {
    return res.status(403).json({ error: 'Token email mismatch' });
  }

  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'start-trial', 10)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  try {
    // Check if this email already has a trial
    const existing = await neonSQL(
      `SELECT trial_start FROM trials WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (existing.length > 0) {
      const trialStart = existing[0].trial_start;
      const now = Math.floor(Date.now() / 1000);
      const SEVEN_DAYS = 7 * 24 * 60 * 60;

      if (now - trialStart > SEVEN_DAYS) {
        return res.status(200).json({ error: 'trial_used', message: 'Trial already used' });
      }
      // Still active — return existing
      return res.status(200).json({ success: true, trialStart });
    }

    // Start new trial
    const trialStart = Math.floor(Date.now() / 1000);
    await neonSQL(
      `INSERT INTO trials (email, trial_start) VALUES ($1, $2)`,
      [email, trialStart]
    );

    return res.status(200).json({ success: true, trialStart });

  } catch (err) {
    console.error('[start-trial] error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
