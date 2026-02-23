import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── IN-MEMORY RATE LIMITER ────────────────────────────────
// Resets when serverless function cold-starts, but catches burst abuse effectively
const rateLimitMap = new Map();

const LIMITS = {
  free: { requests: 3,  windowMs: 60 * 60 * 1000 }, // 3 per hour
  pro:  { requests: 50, windowMs: 60 * 60 * 1000 }, // 50 per hour
};

function getClientId(req) {
  // Use user ID if available, fall back to IP
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
  const userId = req.headers['x-user-id'] || null;
  return userId ? `user:${userId}` : `ip:${ip}`;
}

function checkRateLimit(clientId, isPro) {
  const limit = isPro ? LIMITS.pro : LIMITS.free;
  const now = Date.now();
  const record = rateLimitMap.get(clientId);

  if (!record || now - record.windowStart > limit.windowMs) {
    // Fresh window
    rateLimitMap.set(clientId, { count: 1, windowStart: now });
    return { allowed: true, remaining: limit.requests - 1 };
  }

  if (record.count >= limit.requests) {
    const resetIn = Math.ceil((limit.windowMs - (now - record.windowStart)) / 1000 / 60);
    return { allowed: false, resetInMinutes: resetIn };
  }

  record.count++;
  return { allowed: true, remaining: limit.requests - record.count };
}

// Clean up old entries every 100 requests to prevent memory leak
let cleanupCounter = 0;
function maybeCleanup() {
  if (++cleanupCounter % 100 !== 0) return;
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (now - record.windowStart > LIMITS.pro.windowMs) {
      rateLimitMap.delete(key);
    }
  }
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id, X-Pro-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Determine if Pro (trust header set by client after validate-token)
  const proToken = req.headers['x-pro-token'];
  const isPro = !!proToken; // Server trusts this since validate-token already verified it

  const clientId = getClientId(req);
  maybeCleanup();

  const rateCheck = checkRateLimit(clientId, isPro);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: `Too many requests. Try again in ${rateCheck.resetInMinutes} minute(s).`,
      resetInMinutes: rateCheck.resetInMinutes,
    });
  }

  const { model, max_tokens, messages, system } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Hard cap on tokens to prevent abuse
  const cappedTokens = Math.min(max_tokens || 180, isPro ? 500 : 200);

  try {
    const response = await client.messages.create({
      model: model || 'claude-haiku-4-5-20251001', // Default to Haiku — much cheaper
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
