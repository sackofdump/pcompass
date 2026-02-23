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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { credential, userInfo } = req.body;

  let googleId, email, name, picture;

  try {
    if (credential) {
      // Verify Google ID token
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
      const payload = await verifyRes.json();
      if (payload.error) {
        return res.status(401).json({ error: 'Invalid token: ' + (payload.error_description || payload.error) });
      }
      // Accept token if it has a valid sub (user ID) and email
      if (!payload.sub || !payload.email) {
        return res.status(401).json({ error: 'Token missing user info' });
      }
      googleId = payload.sub;
      email = payload.email;
      name = payload.name || payload.email;
      picture = payload.picture || '';
    } else if (userInfo) {
      if (!userInfo.id || !userInfo.email) {
        return res.status(400).json({ error: 'Missing user info' });
      }
      googleId = userInfo.id;
      email = userInfo.email;
      name = userInfo.name || userInfo.email;
      picture = userInfo.picture || '';
    } else {
      return res.status(400).json({ error: 'No credential or userInfo' });
    }

    const users = await neonSQL(
      `INSERT INTO users (google_id, email, name, picture, last_login)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (google_id) DO UPDATE SET last_login = NOW(), name = $3, picture = $4
       RETURNING id, email, name, picture`,
      [googleId, email, name, picture]
    );

    const user = users[0];
    res.status(200).json({ success: true, user: { id: user.id, email: user.email, name: user.name, picture: user.picture } });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Authentication failed: ' + err.message });
  }
}
