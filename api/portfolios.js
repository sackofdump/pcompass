import { getAllowedOrigin, setSecurityHeaders, checkBodySize } from './lib/cors.js';
import { extractAuth, getProFromCookie, verifyAuthToken, verifyProToken } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── VERIFY USER IS WHO THEY CLAIM ─────────────────────────
// Uses AUTH token (not Pro) — any signed-in user can access their own portfolios.
// Pro token only controls limits (portfolio count), not ownership.
async function verifyUser(req, claimedUserId) {
  const auth = extractAuth(req);

  if (!auth.email || !auth.token || !auth.ts) return false;

  // Verify the HMAC token matches the email
  if (!await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv)) return false;

  // Confirm this token's email matches the claimed userId
  const rows = await neonSQL(
    `SELECT id FROM users WHERE id = $1 AND LOWER(email) = $2 LIMIT 1`,
    [parseInt(claimedUserId), auth.email]
  );
  return rows.length > 0;
}

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pro-Token, X-Pro-Email, X-Pro-Ts, X-Auth-Token, X-Auth-Email, X-Auth-Ts');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if ((req.method === 'POST' || req.method === 'DELETE') && !checkBodySize(req)) {
    return res.status(413).json({ error: 'Request body too large' });
  }

  // ── Require valid auth token (cookie-first, header fallback) ──
  const auth = extractAuth(req);
  const isAuthenticated = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.method === 'GET') {
    if (!await checkRateLimit('email:' + auth.email, 'portfolios-read', 60)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const authorized = await verifyUser(req, userId);
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const portfolios = await neonSQL(
        `SELECT id, name, holdings, updated_at FROM portfolios
         WHERE user_id = $1 ORDER BY updated_at DESC`,
        [parseInt(userId)]
      );
      return res.status(200).json({ portfolios });
    } catch (err) {
      console.error('[portfolios GET]', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method === 'POST') {
    if (!await checkRateLimit('email:' + auth.email, 'portfolios-write', 5)) {
      return res.status(429).json({ error: 'Too many saves — try again later' });
    }
    const { userId, name, holdings, portfolioId } = req.body;
    if (!userId || !name || !holdings) {
      return res.status(400).json({ error: 'userId, name, and holdings required' });
    }

    const authorized = await verifyUser(req, userId);
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

    // Validate name length
    if (typeof name !== 'string' || name.length > 100) {
      return res.status(400).json({ error: 'Name must be a string under 100 characters' });
    }

    // Validate holdings is an array with proper structure
    if (!Array.isArray(holdings)) {
      return res.status(400).json({ error: 'holdings must be an array' });
    }
    if (holdings.length > 100) {
      return res.status(400).json({ error: 'Too many holdings (max 100)' });
    }
    for (const h of holdings) {
      if (!h || typeof h.ticker !== 'string' || h.ticker.length > 10 || typeof h.pct !== 'number') {
        return res.status(400).json({ error: 'Each holding must have ticker (string) and pct (number)' });
      }
      if (!Number.isFinite(h.pct) || h.pct < 0 || h.pct > 100) {
        return res.status(400).json({ error: 'Each holding pct must be a finite number between 0 and 100' });
      }
    }

    try {
      if (portfolioId) {
        const result = await neonSQL(
          `UPDATE portfolios SET name = $1, holdings = $2, updated_at = NOW()
           WHERE id = $3 AND user_id = $4
           RETURNING id, name, holdings, updated_at`,
          [name, JSON.stringify(holdings), parseInt(portfolioId), parseInt(userId)]
        );
        if (result.length === 0) return res.status(404).json({ error: 'Portfolio not found' });
        return res.status(200).json({ portfolio: result[0] });
      } else {
        // ── Enforce portfolio count limit ──
        const countRows = await neonSQL(
          `SELECT COUNT(*)::int AS cnt FROM portfolios WHERE user_id = $1`,
          [parseInt(userId)]
        );
        const currentCount = countRows[0]?.cnt || 0;

        // Pro check only for limits, not ownership
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

        const maxPortfolios = isPro ? 50 : 3;
        if (currentCount >= maxPortfolios) {
          return res.status(403).json({ error: 'Portfolio limit reached' });
        }

        const result = await neonSQL(
          `INSERT INTO portfolios (user_id, name, holdings)
           VALUES ($1, $2, $3)
           RETURNING id, name, holdings, updated_at`,
          [parseInt(userId), name, JSON.stringify(holdings)]
        );
        return res.status(201).json({ portfolio: result[0] });
      }
    } catch (err) {
      console.error('[portfolios POST]', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method === 'DELETE') {
    if (!await checkRateLimit('email:' + auth.email, 'portfolios-write', 5)) {
      return res.status(429).json({ error: 'Too many deletes — try again later' });
    }
    const { userId, portfolioId } = req.query;
    if (!userId || !portfolioId) {
      return res.status(400).json({ error: 'userId and portfolioId required' });
    }

    const authorized = await verifyUser(req, userId);
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

    try {
      if (portfolioId === 'all') {
        await neonSQL(`DELETE FROM portfolios WHERE user_id = $1`, [parseInt(userId)]);
      } else {
        await neonSQL(
          `DELETE FROM portfolios WHERE id = $1 AND user_id = $2`,
          [parseInt(portfolioId), parseInt(userId)]
        );
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[portfolios DELETE]', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
