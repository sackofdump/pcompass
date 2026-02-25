import { timingSafeEqual } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';

export default async function handler(req, res) {
  // Block in production — schema mutations should not be exposed
  if (process.env.VERCEL_ENV === 'production') {
    return res.status(403).json({ error: 'Disabled in production' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Admin-only: require secret to run schema setup ──
  const secret = process.env.DB_SETUP_SECRET;
  const provided = req.headers['x-db-setup-secret'] || '';
  if (!secret || !provided || !timingSafeEqual(provided, secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const results = [];

  try {
    // ── USERS ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id VARCHAR(255) UNIQUE,
      apple_id VARCHAR(255) UNIQUE,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      picture VARCHAR(500),
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP DEFAULT NOW()
    )`);
    results.push('users table done');

    // ── MIGRATIONS (safe to re-run) ──
    await neonSQL(`ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id VARCHAR(255) UNIQUE`);
    await neonSQL(`ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL`);
    results.push('users migrations done');

    // ── PORTFOLIOS ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS portfolios (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      holdings JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('portfolios table done');

    // ── PRO LICENSES ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS pro_licenses (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      active BOOLEAN DEFAULT true,
      plan VARCHAR(50) NOT NULL,
      customer_id VARCHAR(255),
      session_id VARCHAR(255),
      purchased_at TIMESTAMP DEFAULT NOW(),
      cancelled_at TIMESTAMP,
      failed_at TIMESTAMP
    )`);
    results.push('pro_licenses table done');

    // ── API USAGE (DB-backed rate limiting) ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS api_usage (
      id SERIAL PRIMARY KEY,
      client_key VARCHAR(255) NOT NULL,
      endpoint VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('api_usage table done');

    // ── PUSH TOKENS (push notification device tokens) ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS push_tokens (
      id SERIAL PRIMARY KEY,
      token VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255),
      platform VARCHAR(20) DEFAULT 'ios',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('push_tokens table done');

    // ── STOCK DATA (cached betas + picks from daily cron) ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS stock_data (
      key VARCHAR(50) PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('stock_data table done');

    // ── INDEXES (all IF NOT EXISTS — safe to re-run) ──
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios(user_id)`);
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_pro_licenses_email ON pro_licenses(email)`);
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_pro_licenses_customer_id ON pro_licenses(customer_id)`);
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_api_usage_lookup ON api_usage(client_key, endpoint, created_at)`);
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_push_tokens_updated ON push_tokens(updated_at)`);
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_users_apple_id ON users(apple_id)`);
    results.push('all indexes done');

    res.status(200).json({ success: true, results });
  } catch (err) {
    console.error('[db-setup] error:', err.message);
    res.status(500).json({ error: 'Database setup failed', results });
  }
}
