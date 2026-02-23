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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
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
