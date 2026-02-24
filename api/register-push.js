// ── CORS ORIGIN ALLOWLIST ────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Allow no-origin requests (native app direct fetch)
  if (!origin) return null;
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
    const { token, email, platform } = req.body || {};

    // Validate token format
    if (!token || typeof token !== 'string' || !token.startsWith('ExponentPushToken[')) {
      return res.status(400).json({ error: 'Invalid push token format' });
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
