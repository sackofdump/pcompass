export const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

export function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

// Request body size guard — call at top of POST handlers
export function checkBodySize(req, maxBytes = 1_000_000) {
  const len = parseInt(req.headers['content-length'] || '0');
  return len <= maxBytes;
}

// Security headers — call at top of every handler
export function setSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.VERCEL_ENV) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
