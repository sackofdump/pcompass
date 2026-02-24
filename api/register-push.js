// ── CORS ORIGIN ALLOWLIST ────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

// ── NEON SQL HELPER ──────────────────────────────────────
async function neonSQL(sql, params = []) {
  const connStr = process.env.POSTGRES_URL;
  if (!connStr) throw new Error('POSTGRES_URL not set');
  const host = new URL(connStr).hostname;
  const r = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connStr },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── IP-BASED RATE LIMITER (DB-backed) ───────────────────
async function checkRateLimit(ip) {
  const MAX_REQUESTS = 20; // per IP per hour
  try {
    const result = await neonSQL(
      `SELECT COUNT(*) FROM api_usage WHERE client_key = $1 AND endpoint = 'register-push' AND created_at > NOW() - INTERVAL '1 hour'`,
      [ip]
    );
    const count = parseInt(result.rows?.[0]?.[0] || '0');
    if (count >= MAX_REQUESTS) return false;
    await neonSQL(
      `INSERT INTO api_usage (client_key, endpoint) VALUES ($1, 'register-push')`,
      [ip]
    );
    return true;
  } catch (e) {
    // Fail closed — deny if rate limit check fails
    return false;
  }
}

export default async function handler(req, res) {
  // CORS
  const origin = getAllowedOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Rate limit by IP
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',').pop()?.trim() || 'unknown';
    if (!await checkRateLimit(ip)) {
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

    // Sanitize inputs
    const cleanEmail = email ? String(email).toLowerCase().trim().slice(0, 255) : null;
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
