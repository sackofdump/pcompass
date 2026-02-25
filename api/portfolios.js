// ── COOKIE HELPERS ───────────────────────────────────────
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [key, ...rest] = c.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}
function getAuthFromCookie(req) {
  const c = parseCookies(req);
  if (c.pc_auth) {
    const [e, t, tk] = c.pc_auth.split('|');
    if (e && t && tk) return { email: e, ts: t, token: tk };
  }
  return null;
}
function getProFromCookie(req) {
  const c = parseCookies(req);
  if (c.pc_pro) {
    const [e, t, tk] = c.pc_pro.split('|');
    if (e && t && tk) return { email: e, ts: t, token: tk };
  }
  return null;
}

// ── CORS ORIGIN ALLOWLIST ────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

async function neonSQL(sql, params = []) {
  const connStr = process.env.POSTGRES_URL;
  const host = new URL(connStr).hostname;
  const r = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connStr },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  return data.rows || [];
}

// ── TIMING-SAFE COMPARISON ──────────────────────────────
function timingSafeEqual(a, b) {
  const maxLen = Math.max(a.length, b.length);
  const aPad = a.padEnd(maxLen, '\0');
  const bPad = b.padEnd(maxLen, '\0');
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    mismatch |= aPad.charCodeAt(i) ^ bPad.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── AUTH TOKEN VERIFICATION ──────────────────────────────
async function verifyAuthToken(email, token, timestamp) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (isNaN(ts) || now - ts > 14400 || ts - now > 300) return false;

  const secret = process.env.AUTH_TOKEN_SECRET || process.env.PRO_TOKEN_SECRET;
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`auth:${email.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return timingSafeEqual(token, expected);
}

// ── PRO TOKEN VERIFICATION ──────────────────────────────
async function verifyProToken(email, token, timestamp) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (isNaN(ts) || now - ts > 14400 || ts - now > 300) return false;

  const secret = process.env.PRO_TOKEN_SECRET;
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${email.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return timingSafeEqual(token, expected);
}

// ── VERIFY USER IS WHO THEY CLAIM ─────────────────────────
// Without this, any user could pass userId=1 and read/write anyone's portfolios
async function verifyUser(req, claimedUserId) {
  const proCk = getProFromCookie(req);
  const proToken = proCk?.token || req.headers['x-pro-token'] || '';
  const proEmail = (proCk?.email || req.headers['x-pro-email'] || '').toLowerCase().trim();
  const proTs    = proCk?.ts || req.headers['x-pro-ts'] || '';

  if (!proEmail || !proToken || !proTs) return false;

  // Verify the HMAC token matches the email
  if (!await verifyProToken(proEmail, proToken, proTs)) return false;

  // Confirm this token's email matches the claimed userId
  const rows = await neonSQL(
    `SELECT id FROM users WHERE id = $1 AND email = $2 LIMIT 1`,
    [parseInt(claimedUserId), proEmail.toLowerCase().trim()]
  );
  return rows.length > 0;
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
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

  // ── Require valid auth token (cookie-first, header fallback) ──
  const authCk = getAuthFromCookie(req);
  const authToken = authCk?.token || req.headers['x-auth-token'] || '';
  const authEmail = (authCk?.email || req.headers['x-auth-email'] || '').toLowerCase().trim();
  const authTs    = authCk?.ts || req.headers['x-auth-ts'] || '';
  const isAuthenticated = await verifyAuthToken(authEmail, authToken, authTs);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.method === 'GET') {
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

        const proCk2 = getProFromCookie(req);
        const proToken2 = proCk2?.token || req.headers['x-pro-token'] || '';
        const proEmail2 = (proCk2?.email || req.headers['x-pro-email'] || '').toLowerCase().trim();
        const proTs2    = proCk2?.ts || req.headers['x-pro-ts'] || '';
        let isPro = await verifyProToken(proEmail2, proToken2, proTs2);
        if (isPro) {
          try {
            const lic = await neonSQL(`SELECT active FROM pro_licenses WHERE LOWER(email) = $1 AND active = true LIMIT 1`, [proEmail2]);
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
    const { userId, portfolioId } = req.query;
    if (!userId || !portfolioId) {
      return res.status(400).json({ error: 'userId and portfolioId required' });
    }

    const authorized = await verifyUser(req, userId);
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

    try {
      await neonSQL(
        `DELETE FROM portfolios WHERE id = $1 AND user_id = $2`,
        [parseInt(portfolioId), parseInt(userId)]
      );
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[portfolios DELETE]', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
