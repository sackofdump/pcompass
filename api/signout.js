import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secure = process.env.VERCEL_ENV ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `pc_auth=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
    `pc_pro=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
  ]);

  return res.status(200).json({ success: true });
}
