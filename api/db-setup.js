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

export default async function handler(req, res) {
  const results = [];

  try {
    // ── USERS ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      picture VARCHAR(500),
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP DEFAULT NOW()
    )`);
    results.push('users table ✓');

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

    // ── EMAIL AUTH ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS email_auth (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(512) NOT NULL,
      salt VARCHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('email_auth table ✓');

    // ── API USAGE (DB-backed rate limiting) ──
    await neonSQL(`CREATE TABLE IF NOT EXISTS api_usage (
      id SERIAL PRIMARY KEY,
      client_key VARCHAR(255) NOT NULL,
      endpoint VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('api_usage table ✓');

    // ── INDEXES (all IF NOT EXISTS — safe to re-run) ──
    // portfolios.user_id — speeds up GET /api/portfolios?userId=X
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios(user_id)`);

    // pro_licenses.email — speeds up verify-pro (called on every AI explanation)
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_pro_licenses_email ON pro_licenses(email)`);

    // pro_licenses.customer_id — speeds up stripe-webhook subscription/payment events
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_pro_licenses_customer_id ON pro_licenses(customer_id)`);

    // users.email — speeds up email auth login and portfolio auth check
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

    // email_auth.email — speeds up login lookup
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_email_auth_email ON email_auth(email)`);

    // api_usage — speeds up rate limit lookups
    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_api_usage_lookup ON api_usage(client_key, endpoint, created_at)`);

    results.push('all indexes ✓');

    res.status(200).json({ success: true, results });
  } catch (err) {
    console.error('[db-setup] error:', err.message);
    res.status(500).json({ error: err.message, results });
  }
}
