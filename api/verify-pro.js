async function kvGet(key) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;
  const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });
  const data = await r.json();
  if (data.result === null || data.result === undefined) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
}

export default async function handler(req, res) {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return res.status(400).json({ pro: false, error: 'Valid email required' });

  try {
    const license = await kvGet(`pro:${email}`);
    if (!license || !license.active) return res.status(200).json({ pro: false });

    // Generate simple signed token
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
