import { neonSQL } from './neon.js';

export async function checkRateLimit(clientKey, endpoint, maxRequests) {
  try {
    const result = await neonSQL(
      `SELECT COUNT(*)::int AS cnt FROM api_usage WHERE client_key = $1 AND endpoint = $2 AND created_at > NOW() - INTERVAL '1 hour'`,
      [clientKey, endpoint]
    );
    const count = result[0]?.cnt || 0;
    if (count >= maxRequests) return false;
    await neonSQL(
      `INSERT INTO api_usage (client_key, endpoint) VALUES ($1, $2)`,
      [clientKey, endpoint]
    );
    return true;
  } catch (e) {
    return false; // fail closed
  }
}
