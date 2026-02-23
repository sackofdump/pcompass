async function neonSQL(sql, params = []) {
  const connStr = process.env.POSTGRES_URL;
  const host = new URL(connStr).hostname;
  const r = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connStr },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  return data.rows || [];
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, mode } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    // Ensure email_auth table exists
    await neonSQL(`CREATE TABLE IF NOT EXISTS email_auth (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(512) NOT NULL,
      salt VARCHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    if (mode === 'signup') {
      // Check if email exists
      const existing = await neonSQL('SELECT id FROM email_auth WHERE email = $1', [email]);
      if (existing.length > 0) {
        return res.status(400).json({ error: 'An account with this email already exists. Try signing in.' });
      }

      const salt = generateSalt();
      const hash = await hashPassword(password, salt);

      await neonSQL(
        'INSERT INTO email_auth (email, password_hash, salt) VALUES ($1, $2, $3)',
        [email, hash, salt]
      );

      // Also create user in users table
      const users = await neonSQL(
        `INSERT INTO users (google_id, email, name, picture, last_login)
         VALUES ($1, $2, $3, '', NOW())
         ON CONFLICT (email) DO UPDATE SET last_login = NOW()
         RETURNING id, email, name, picture`,
        ['email:' + email, email, email.split('@')[0]]
      );

      const user = users[0];
      return res.status(200).json({ success: true, user: { id: user.id, email: user.email, name: user.name, picture: '' } });

    } else {
      // Login
      const rows = await neonSQL('SELECT password_hash, salt FROM email_auth WHERE email = $1', [email]);
      if (rows.length === 0) {
        return res.status(400).json({ error: 'No account found with this email. Try signing up.' });
      }

      const { password_hash, salt } = rows[0];
      const hash = await hashPassword(password, salt);

      if (hash !== password_hash) {
        return res.status(401).json({ error: 'Incorrect password.' });
      }

      // Get user record
      const users = await neonSQL(
        `SELECT id, email, name, picture FROM users WHERE email = $1`,
        [email]
      );

      if (users.length === 0) {
        // Create user if missing
        const newUsers = await neonSQL(
          `INSERT INTO users (google_id, email, name, picture, last_login)
           VALUES ($1, $2, $3, '', NOW())
           ON CONFLICT (email) DO UPDATE SET last_login = NOW()
           RETURNING id, email, name, picture`,
          ['email:' + email, email, email.split('@')[0]]
        );
        return res.status(200).json({ success: true, user: { id: newUsers[0].id, email: newUsers[0].email, name: newUsers[0].name, picture: '' } });
      }

      await neonSQL('UPDATE users SET last_login = NOW() WHERE email = $1', [email]);

      const user = users[0];
      return res.status(200).json({ success: true, user: { id: user.id, email: user.email, name: user.name, picture: user.picture || '' } });
    }
  } catch (err) {
    console.error('Email auth error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
