import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── PRO TOKEN VERIFICATION (server-side, not just trusting client header) ──
async function verifyProToken(email, token, timestamp) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (now - ts > 86400) return false; // expired

  const secret = process.env.PRO_TOKEN_SECRET;
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${email.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);

  return token === expected;
}

// ── IN-MEMORY RATE LIMITER ────────────────────────────────
// Resets on cold start but reliably catches burst abuse
const rateLimitMap = new Map();

const LIMITS = {
  free:      { requests: 3,  windowMs: 60 * 60 * 1000 },  // 3/hr
  pro:       { requests: 50, windowMs: 60 * 60 * 1000 },  // 50/hr
  screenshot:{ requests: 3,  windowMs: 24 * 60 * 60 * 1000 }, // 3/day free
};

function getClientId(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
  const userId = req.headers['x-user-id'] || null;
  return userId ? `user:${userId}` : `ip:${ip}`;
}

function checkRateLimit(clientId, limitKey) {
  const limit = LIMITS[limitKey] || LIMITS.free;
  const now = Date.now();
  const mapKey = `${limitKey}:${clientId}`;
  const record = rateLimitMap.get(mapKey);

  if (!record || now - record.windowStart > limit.windowMs) {
    rateLimitMap.set(mapKey, { count: 1, windowStart: now });
    return { allowed: true, remaining: limit.requests - 1 };
  }

  if (record.count >= limit.requests) {
    const resetIn = Math.ceil((limit.windowMs - (now - record.windowStart)) / 1000 / 60);
    return { allowed: false, resetInMinutes: resetIn };
  }

  record.count++;
  return { allowed: true, remaining: limit.requests - record.count };
}

// Cleanup old entries every 100 requests to prevent memory leak
let cleanupCounter = 0;
function maybeCleanup() {
  if (++cleanupCounter % 100 !== 0) return;
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (now - record.windowStart > LIMITS.pro.windowMs * 2) {
      rateLimitMap.delete(key);
    }
  }
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id, X-Pro-Token, X-Pro-Email, X-Pro-Ts');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Verify Pro server-side (don't just trust the header) ──
  const proToken = req.headers['x-pro-token'] || '';
  const proEmail = req.headers['x-pro-email'] || '';
  const proTs    = req.headers['x-pro-ts']    || '';
  const isPro = await verifyProToken(proEmail, proToken, proTs);

  const clientId = getClientId(req);
  maybeCleanup();

  const { model, max_tokens, messages, system } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Screenshot requests have their own stricter rate limit for free users
  const isScreenshot = isScreenshotRequest(messages);
  const limitKey = isPro ? 'pro' : isScreenshot ? 'screenshot' : 'free';

  const rateCheck = checkRateLimit(clientId, limitKey);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: `Too many requests. Try again in ${rateCheck.resetInMinutes} minute(s).`,
      resetInMinutes: rateCheck.resetInMinutes,
    });
  }

  // Hard cap on tokens to prevent abuse
  const cappedTokens = Math.min(max_tokens || 180, isPro ? 500 : 200);

  // Force cheaper model for free users on screenshot imports (vision is expensive)
  const resolvedModel = isScreenshot && !isPro
    ? 'claude-haiku-4-5-20251001'
    : model || 'claude-haiku-4-5-20251001';

  try {
    const response = await client.messages.create({
      model: resolvedModel,
      max_tokens: cappedTokens,
      ...(system ? { system } : {}),
      messages,
    });

    res.setHeader('X-RateLimit-Remaining', rateCheck.remaining ?? 0);
    return res.status(200).json(response);

  } catch (err) {
    console.error('Claude API error:', err.message);
    if (err.status === 429) {
      return res.status(429).json({ error: 'Anthropic rate limit hit. Try again shortly.' });
    }
    return res.status(500).json({ error: 'Claude API error', detail: err.message });
  }
}
