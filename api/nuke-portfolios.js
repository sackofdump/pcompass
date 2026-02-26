import { getAllowedOrigin, setSecurityHeaders } from './lib/cors.js';
import { neonSQL } from './lib/neon.js';

// ONE-TIME endpoint to delete ALL portfolios from the database.
// Remove this file after use.
export default async function handler(req, res) {
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const count = await neonSQL(`SELECT COUNT(*)::int AS cnt FROM portfolios`);
    await neonSQL(`DELETE FROM portfolios`);
    return res.status(200).json({
      success: true,
      deleted: count[0]?.cnt || 0,
      message: 'All portfolios deleted from database'
    });
  } catch (err) {
    console.error('[nuke-portfolios]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
