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
  if (isNaN(ts) || now - ts > 86400) return false;

  const secret = process.env.PRO_TOKEN_SECRET;
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

export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pro-Token, X-Pro-Email, X-Pro-Ts, X-Auth-Token, X-Auth-Email, X-Auth-Ts');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── Verify auth token ──
    const authToken = req.headers['x-auth-token'] || '';
    const authEmail = req.headers['x-auth-email'] || '';
    const authTs    = req.headers['x-auth-ts']    || '';
    const bodyEmail = (req.body.email || '').toLowerCase().trim();

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

    // Delete api_usage records (exact prefix match, escape LIKE wildcards)
    const safeEmail = bodyEmail.replace(/%/g, '\\%').replace(/_/g, '\\_');
    await neonSQL(`DELETE FROM api_usage WHERE client_key LIKE $1 ESCAPE '\\'`, ['email:' + safeEmail + '%']);

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
