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
  try {
    await neonSQL(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      picture VARCHAR(500),
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP DEFAULT NOW()
    )`);

    await neonSQL(`CREATE TABLE IF NOT EXISTS portfolios (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      holdings JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await neonSQL(`CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios(user_id)`);

    res.status(200).json({ success: true, message: 'Database tables created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
