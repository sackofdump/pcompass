import { neonSQL } from './neon.js';

export async function checkRateLimit(clientKey, endpoint, maxRequests) {
  try {
    // Single atomic CTE: insert + count in one statement (no race condition)
    const result = await neonSQL(
      `WITH ins AS (
        INSERT INTO api_usage (client_key, endpoint) VALUES ($1, $2)
        RETURNING created_at
      )
      SELECT COUNT(*)::int AS cnt FROM api_usage
      WHERE client_key = $1 AND endpoint = $2 AND created_at > NOW() - INTERVAL '1 hour'`,
      [clientKey, endpoint]
    );

    // Probabilistic cleanup: ~2% of requests prune old entries (all endpoints)
    if (Math.random() < 0.02) {
      neonSQL(`DELETE FROM api_usage WHERE created_at < NOW() - INTERVAL '48 hours'`, []).catch(() => {});
    }

    return (result[0]?.cnt || 0) <= maxRequests;
  } catch (e) {
    return false; // fail closed
  }
}
