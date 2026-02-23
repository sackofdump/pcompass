import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'No credential provided' });
  }

  try {
    // Verify the Google ID token
    const verifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`
    );
    const payload = await verifyRes.json();

    if (payload.error || payload.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { sub: googleId, email, name, picture } = payload;

    const sql = neon(process.env.POSTGRES_URL);

    // Upsert user — create if new, update last_login if existing
    const users = await sql`
      INSERT INTO users (google_id, email, name, picture, last_login)
      VALUES (${googleId}, ${email}, ${name}, ${picture || ''}, NOW())
      ON CONFLICT (google_id) DO UPDATE SET
        last_login = NOW(),
        name = ${name},
        picture = ${picture || ''}
      RETURNING id, email, name, picture
    `;

    const user = users[0];

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
    });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}
