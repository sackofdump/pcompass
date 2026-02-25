export const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

export function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

// Request body size guard — call at top of POST handlers
// Checks both Content-Length header AND actual parsed body size
export function checkBodySize(req, maxBytes = 1_000_000) {
  const headerLen = parseInt(req.headers['content-length'] || '0');
  if (headerLen > maxBytes) return false;
  if (req.body) {
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (bodyStr.length > maxBytes) return false;
  }
  return true;
}

// Security headers — call at top of every handler
export function setSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com https://appleid.cdn-apple.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https://financialmodelingprep.com https://appleid.apple.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "frame-src https://accounts.google.com https://appleid.apple.com",
  ].join('; '));
  if (process.env.VERCEL_ENV) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
