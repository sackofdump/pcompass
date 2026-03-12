import { neon } from '@neondatabase/serverless';

export async function neonSQL(sql, params = []) {
  const connStr = process.env.POSTGRES_URL;
  if (!connStr) throw new Error('POSTGRES_URL not set');
  const query = neon(connStr);
  return await query.query(sql, params);
}
