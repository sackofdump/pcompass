import { getAllowedOrigin } from './lib/cors.js';
import { neonSQL } from './lib/neon.js';

export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }
  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rows = await neonSQL(`SELECT key, data, updated_at FROM stock_data WHERE key IN ('betas', 'picks')`);

    const result = {};
    for (const row of rows) {
      result[row.key] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      result[row.key + '_updated'] = row.updated_at;
    }

    // Edge cache for 1 hour
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json(result);
  } catch (err) {
    console.error('[stock-data] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stock data' });
  }
}
