export default async function handler(req, res) {
  const { email, token, timestamp } = req.query;
  if (!email || !token || !timestamp) return res.status(400).json({ valid: false });

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (now - ts > 86400) return res.status(200).json({ valid: false, reason: 'expired' });

  const secret = process.env.PRO_TOKEN_SECRET || 'fallback-secret';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${email.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);

  return res.status(200).json({ valid: token === expected });
}
