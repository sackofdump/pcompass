async function neonSQL(sql) {
  const connStr = process.env.POSTGRES_URL;
  if (!connStr) throw new Error('POSTGRES_URL not set');
  const host = new URL(connStr).hostname;
  const r = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connStr },
    body: JSON.stringify({ query: sql, params: [] }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── TIMING-SAFE COMPARISON ──────────────────────────────
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Pad to equal lengths to avoid length-based timing leaks
  const maxLen = Math.max(a.length, b.length);
  const aPad = a.padEnd(maxLen, '\0');
  const bPad = b.padEnd(maxLen, '\0');
  let mismatch = a.length ^ b.length; // also check actual length
  for (let i = 0; i < maxLen; i++) {
    mismatch |= aPad.charCodeAt(i) ^ bPad.charCodeAt(i);
  }
  return mismatch === 0;
}

export default async function handler(req, res) {
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
    results.push('users table ✓');

    // ── MIGRATIONS (safe to re-run) ──
    // Add apple_id column if missing (existing DBs)
    await neonSQL(`ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id VARCHAR(255) UNIQUE`);
    // Make google_id nullable (was NOT NULL, now optional since Apple users don't have one)
    await neonSQL(`ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL`);
    results.push('users migrations ✓');

    // ── PORTFOLIOS ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS portfolios (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      holdings JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('portfolios table ✓');

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
    results.push('pro_licenses table ✓');

    // ── API USAGE (DB-backed rate limiting) ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS api_usage (
      id SERIAL PRIMARY KEY,
      client_key VARCHAR(255) NOT NULL,
      endpoint VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('api_usage table ✓');

    // ── PUSH TOKENS (push notification device tokens) ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS push_tokens (
      id SERIAL PRIMARY KEY,
      token VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255),
      platform VARCHAR(20) DEFAULT 'ios',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('push_tokens table ✓');

    // ── INDEXES (all IF NOT EXISTS — safe to re-run) ──
    // portfolios.user_id — speeds up GET /api/portfolios?userId=X
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios(user_id)`);

    // pro_licenses.email — speeds up verify-pro (called on every AI explanation)
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_pro_licenses_email ON pro_licenses(email)`);

    // pro_licenses.customer_id — speeds up stripe-webhook subscription/payment events
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_pro_licenses_customer_id ON pro_licenses(customer_id)`);

    // users.email — speeds up email auth login and portfolio auth check
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

    // api_usage — speeds up rate limit lookups
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_api_usage_lookup ON api_usage(client_key, endpoint, created_at)`);

    // push_tokens.updated_at — speeds up active token queries for notifications
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_push_tokens_updated ON push_tokens(updated_at)`);

    // users.apple_id — speeds up Apple auth lookups
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_users_apple_id ON users(apple_id)`);

    results.push('all indexes ✓');

    res.status(200).json({ success: true, results });
  } catch (err) {
    console.error('[db-setup] error:', err.message);
    res.status(500).json({ error: 'Database setup failed', results });
  }
}
