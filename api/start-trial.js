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
const trialAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 60 * 1000;

function checkTrialRateLimit(ip) {
  const now = Date.now();
  const record = trialAttempts.get(ip);
  if (!record || now - record.windowStart > WINDOW_MS) {
    trialAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= MAX_ATTEMPTS) return false;
  record.count++;
  return true;
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
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
  res.setHeader('Cache-Control', 'no-store');

  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, X-Auth-Email, X-Auth-Ts');

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

  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  // ── Require valid auth token ──
  const authToken = req.headers['x-auth-token'] || '';
  const authEmail = req.headers['x-auth-email'] || '';
  const authTs    = req.headers['x-auth-ts']    || '';
  const isAuthenticated = await verifyAuthToken(authEmail, authToken, authTs);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (authEmail.toLowerCase().trim() !== email) {
    return res.status(403).json({ error: 'Token email mismatch' });
  }

  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!checkTrialRateLimit(ip)) {
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
