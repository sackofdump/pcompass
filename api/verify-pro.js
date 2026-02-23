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
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return res.status(400).json({ pro: false, error: 'Valid email required' });

  try {
    const rows = await neonSQL(
      `SELECT active, plan FROM pro_licenses WHERE email = $1`,
      [email]
    );

    if (rows.length === 0 || !rows[0].active) {
      return res.status(200).json({ pro: false });
    }

    const license = rows[0];

    // Generate signed token
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = process.env.PRO_TOKEN_SECRET || 'fallback-secret';
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${email}:${timestamp}`));
    const token = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);

    return res.status(200).json({ pro: true, plan: license.plan, token, timestamp, expiresIn: 86400 });
  } catch (err) {
    console.error('verify-pro error:', err);
    return res.status(500).json({ pro: false, error: 'Server error' });
  }
}
