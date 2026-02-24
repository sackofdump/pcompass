import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  const data = await r.json();
  return data;
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

// ── PRO TOKEN VERIFICATION (server-side, not just trusting client header) ──
async function verifyProToken(email, token, timestamp) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (isNaN(ts) || now - ts > 14400) return false; // expired

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

// ── AUTH TOKEN VERIFICATION ──────────────────────────────
async function verifyAuthToken(email, token, timestamp) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (isNaN(ts) || now - ts > 14400) return false;

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

// ── DB-BACKED RATE LIMITER ───────────────────────────────
const LIMITS = {
  free:      { requests: 3,  windowMs: 60 * 60 * 1000 },       // 3/hr
  pro:       { requests: 50, windowMs: 60 * 60 * 1000 },       // 50/hr
  screenshot:{ requests: 3,  windowMs: 24 * 60 * 60 * 1000 },  // 3/day free
};

async function checkRateLimitDB(clientKey, endpoint, limitKey) {
  const limit = LIMITS[limitKey] || LIMITS.free;
  const windowStart = new Date(Date.now() - limit.windowMs).toISOString();

  // Count recent requests
  const countResult = await neonSQL(
    `SELECT COUNT(*)::int AS cnt FROM api_usage
     WHERE client_key = $1 AND endpoint = $2 AND created_at > $3`,
    [clientKey, endpoint, windowStart]
  );
  const count = countResult.rows?.[0]?.cnt || 0;

  if (count >= limit.requests) {
    return { allowed: false, remaining: 0, used: count };
  }

  // Record this request
  await neonSQL(
    `INSERT INTO api_usage (client_key, endpoint) VALUES ($1, $2)`,
    [clientKey, endpoint]
  );

  // Lazy cleanup (1 in 50 chance) — delete rows older than 48 hours
  if (Math.random() < 0.02) {
    neonSQL(`DELETE FROM api_usage WHERE created_at < NOW() - INTERVAL '48 hours'`).catch(() => {});
  }

  return { allowed: true, remaining: limit.requests - count - 1, used: count + 1 };
}

function getClientKey(req, isPro, proEmail, authEmail) {
  // Always prefer verified email over IP for rate limiting
  if (isPro && proEmail) return `email:${proEmail.toLowerCase().trim()}`;
  if (authEmail) return `email:${authEmail.toLowerCase().trim()}`;
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  return `ip:${ip}`;
}

// ── DETECT SCREENSHOT REQUESTS ────────────────────────────
function isScreenshotRequest(messages) {
  return messages?.some(m =>
    Array.isArray(m.content) &&
    m.content.some(c => c.type === 'image')
  );
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  // ── CORS with origin allowlist ──
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

  // Block requests with an Origin header that isn't in the allowlist
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Require valid auth token ──
  const authToken = req.headers['x-auth-token'] || '';
  const authEmail = req.headers['x-auth-email'] || '';
  const authTs    = req.headers['x-auth-ts']    || '';
  const isAuthenticated = await verifyAuthToken(authEmail, authToken, authTs);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  // ── Verify Pro server-side (don't just trust the header) ──
  const proToken = req.headers['x-pro-token'] || '';
  const proEmail = req.headers['x-pro-email'] || '';
  const proTs    = req.headers['x-pro-ts']    || '';
  const isPro = await verifyProToken(proEmail, proToken, proTs);

  const { messages } = req.body;

  // ── Message validation ──
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  if (messages.length > 1) {
    return res.status(400).json({ error: 'Only single-message requests are supported' });
  }
  const msg = messages[0];
  if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) {
    return res.status(400).json({ error: 'Each message must have role "user" or "assistant"' });
  }

  // ── Content length limits ──
  const MAX_TEXT_LENGTH = 2000;
  const MAX_IMAGE_B64_BYTES = 5 * 1024 * 1024;
  if (typeof msg.content === 'string') {
    if (msg.content.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: 'Message content exceeds ' + MAX_TEXT_LENGTH + ' character limit' });
    }
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'text' && block.text && block.text.length > MAX_TEXT_LENGTH) {
        return res.status(400).json({ error: 'Text block exceeds ' + MAX_TEXT_LENGTH + ' character limit' });
      }
      if (block.type === 'image' && block.source?.type === 'base64') {
        if ((block.source.data || '').length > MAX_IMAGE_B64_BYTES) {
          return res.status(400).json({ error: 'Image exceeds 5 MB size limit' });
        }
      }
    }
  }

  // Screenshot requests have their own stricter rate limit for free users
  const isScreenshot = isScreenshotRequest(messages);
  const limitKey = isPro ? 'pro' : isScreenshot ? 'screenshot' : 'free';
  const endpoint = isScreenshot ? 'screenshot' : 'analysis';

  const clientKey = getClientKey(req, isPro, proEmail, authEmail);

  let rateCheck;
  try {
    rateCheck = await checkRateLimitDB(clientKey, endpoint, limitKey);
  } catch (err) {
    console.error('Rate limit DB error:', err.message);
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again shortly.' });
  }

  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.',
      remaining: rateCheck.remaining,
      used: rateCheck.used,
    });
  }

  // Server decides model and tokens — client has no say
  const resolvedModel = isPro ? 'claude-sonnet-4-5-20250929' : 'claude-haiku-4-5-20251001';
  const resolvedMaxTokens = isScreenshot ? 1000 : 200;

  try {
    const response = await client.messages.create({
      model: resolvedModel,
      max_tokens: resolvedMaxTokens,
      system: 'You are a stock portfolio analysis assistant for Portfolio Compass. Only answer questions related to stock portfolio analysis, investment allocation, sector exposure, diversification, and market data. Refuse any requests unrelated to portfolio analysis.',
      messages,
    });

    res.setHeader('X-RateLimit-Remaining', rateCheck.remaining ?? 0);
    res.setHeader('X-RateLimit-Used', rateCheck.used ?? 0);
    return res.status(200).json(response);

  } catch (err) {
    console.error('Claude API error:', err.message);
    if (err.status === 429) {
      return res.status(429).json({ error: 'Anthropic rate limit hit. Try again shortly.' });
    }
    return res.status(500).json({ error: 'Claude API error' });
  }
}
