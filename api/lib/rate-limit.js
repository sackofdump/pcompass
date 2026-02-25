import { neonSQL } from './neon.js';

export async function checkRateLimit(clientKey, endpoint, maxRequests) {
  try {
    // Insert first (atomic — no race between check and insert)
    await neonSQL(
      `INSERT INTO api_usage (client_key, endpoint) VALUES ($1, $2)`,
      [clientKey, endpoint]
    );
    // Then count (includes the row we just inserted)
    const result = await neonSQL(
      `SELECT COUNT(*)::int AS cnt FROM api_usage WHERE client_key = $1 AND endpoint = $2 AND created_at > NOW() - INTERVAL '1 hour'`,
      [clientKey, endpoint]
    );
    return (result[0]?.cnt || 0) <= maxRequests;
  } catch (e) {
    return false; // fail closed
  }
}
