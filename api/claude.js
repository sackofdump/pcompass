import Anthropic from '@anthropic-ai/sdk';
import { getAllowedOrigin, setSecurityHeaders, checkBodySize } from './lib/cors.js';
import { getAuthFromCookie, getProFromCookie, verifyAuthToken, verifyProToken } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── DB-BACKED RATE LIMITER ───────────────────────────────
const LIMITS = {
  free:      { requests: 3,  windowMs: 60 * 60 * 1000 },       // 3/hr
  pro:       { requests: 50, windowMs: 60 * 60 * 1000 },       // 50/hr
  screenshot:{ requests: 3,  windowMs: 24 * 60 * 60 * 1000 },  // 3/day free
};

async function checkRateLimitDB(clientKey, endpoint, limitKey) {
  const limit = LIMITS[limitKey] || LIMITS.free;
  const windowStart = new Date(Date.now() - limit.windowMs).toISOString();

  // Single atomic CTE: insert + count in one statement (no race condition)
  const countResult = await neonSQL(
    `WITH ins AS (
      INSERT INTO api_usage (client_key, endpoint) VALUES ($1, $2)
      RETURNING created_at
    )
    SELECT COUNT(*)::int AS cnt FROM api_usage
    WHERE client_key = $1 AND endpoint = $2 AND created_at > $3`,
    [clientKey, endpoint, windowStart]
  );
  const count = countResult[0]?.cnt || 0;

  // Lazy cleanup (1 in 50 chance) — delete rows older than 48 hours
  if (Math.random() < 0.02) {
    neonSQL(`DELETE FROM api_usage WHERE created_at < NOW() - INTERVAL '48 hours'`).catch(() => {});
  }

  if (count > limit.requests) {
    return { allowed: false, remaining: 0, used: count };
  }

  return { allowed: true, remaining: limit.requests - count, used: count };
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
  setSecurityHeaders(res);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pro-Token, X-Pro-Email, X-Pro-Ts, X-Auth-Token, X-Auth-Email, X-Auth-Ts');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  // Block requests with an Origin header that isn't in the allowlist
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkBodySize(req, 10_000_000)) return res.status(413).json({ error: 'Request body too large' });

  // ── Require valid auth token (cookie-first, header fallback) ──
  const authCk = getAuthFromCookie(req);
  const authToken = authCk?.token || req.headers['x-auth-token'] || '';
  const authEmail = (authCk?.email || req.headers['x-auth-email'] || '').toLowerCase().trim();
  const authTs    = authCk?.ts || req.headers['x-auth-ts'] || '';
  const isAuthenticated = await verifyAuthToken(authEmail, authToken, authTs);
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  // ── Verify Pro server-side (cookie-first, header fallback) ──
  const proCk = getProFromCookie(req);
  const proToken = proCk?.token || req.headers['x-pro-token'] || '';
  const proEmail = (proCk?.email || req.headers['x-pro-email'] || '').toLowerCase().trim();
  const proTs    = proCk?.ts || req.headers['x-pro-ts'] || '';
  let isPro = await verifyProToken(proEmail, proToken, proTs);
  if (isPro) {
    // DB validation: confirm license is still active (handles cancellations)
    try {
      const lic = await neonSQL(`SELECT active FROM pro_licenses WHERE LOWER(email) = $1 AND active = true LIMIT 1`, [proEmail]);
      if (lic.length === 0) isPro = false;
    } catch { isPro = false; }
  }

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
        const mime = block.source.media_type || '';
        if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(mime)) {
          return res.status(400).json({ error: 'Unsupported image type. Use PNG, JPEG, WebP, or GIF.' });
        }
        const b64 = block.source.data || '';
        const decodedSize = Math.ceil(b64.length * 3 / 4);
        if (decodedSize > MAX_IMAGE_B64_BYTES) {
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
