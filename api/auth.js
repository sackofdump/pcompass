// ── CORS ORIGIN ALLOWLIST ────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

// ── IN-MEMORY RATE LIMITER ────────────────────────────────
const authAttempts = new Map();
const MAX_ATTEMPTS = 10; // per IP per hour
const WINDOW_MS = 60 * 60 * 1000;

function checkAuthRateLimit(ip) {
  const now = Date.now();
  const record = authAttempts.get(ip);
  if (!record || now - record.windowStart > WINDOW_MS) {
    authAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= MAX_ATTEMPTS) return false;
  record.count++;
  return true;
}

// ── NEON SQL HELPER ──────────────────────────────────────
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

export default async function handler(req, res) {
  // ── CORS with origin allowlist ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Rate limit by IP ──
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!checkAuthRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many authentication attempts' });
  }

  const { credential } = req.body;

  let googleId, email, name, picture;

  try {
    if (credential) {
      // Verify Google ID token
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
      const payload = await verifyRes.json();
      if (payload.error) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      if (payload.aud !== '564027426495-8p19f9da30bikcsjje4uv0up59tgf9i5.apps.googleusercontent.com') {
        return res.status(401).json({ error: 'Token audience mismatch' });
      }
      // Accept token if it has a valid sub (user ID) and email
      if (!payload.sub || !payload.email) {
        return res.status(401).json({ error: 'Token missing user info' });
      }
      googleId = payload.sub;
      email = payload.email;
      name = payload.name || payload.email;
      picture = payload.picture || '';
    } else {
      return res.status(400).json({ error: 'No credential provided' });
    }

    const users = await neonSQL(
      `INSERT INTO users (google_id, email, name, picture, last_login)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (google_id) DO UPDATE SET last_login = NOW(), name = $3, picture = $4
       RETURNING id, email, name, picture`,
      [googleId, email, name, picture]
    );

    const user = users[0];
    res.status(200).json({ success: true, user: { id: user.id, email: user.email, name: user.name, picture: user.picture } });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}
