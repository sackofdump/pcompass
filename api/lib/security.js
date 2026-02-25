// ── SECURITY HEADERS ─────────────────────────────────────
// Applied to all API responses
export function setSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.VERCEL_ENV) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

// ── REQUEST SIZE CHECK ───────────────────────────────────
// Rejects oversized POST bodies (1MB max)
export function checkRequestSize(req, res, maxBytes = 1_000_000) {
  const len = parseInt(req.headers['content-length'] || '0');
  if (len > maxBytes) {
    res.status(413).json({ error: 'Request too large' });
    return false;
  }
  return true;
}
