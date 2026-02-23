import crypto from 'crypto';

export default async function handler(req, res) {
  const { email, token, timestamp } = req.query;

  if (!email || !token || !timestamp) {
    return res.status(400).json({ valid: false });
  }

  // Check if token has expired (24 hours)
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (now - ts > 86400) {
    return res.status(200).json({ valid: false, reason: 'expired' });
  }

  // Recreate the token and compare
  const secret = process.env.PRO_TOKEN_SECRET || process.env.STRIPE_SECRET_KEY;
  const payload = `${email.toLowerCase().trim()}:${ts}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .substring(0, 32);

  if (token === expected) {
    return res.status(200).json({ valid: true });
  }

  return res.status(200).json({ valid: false, reason: 'invalid' });
}
