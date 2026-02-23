import { kv } from '@vercel/kv';
import crypto from 'crypto';

export default async function handler(req, res) {
  // Allow both GET and POST
  const email = (req.query.email || req.body?.email || '').toLowerCase().trim();

  if (!email || !email.includes('@')) {
    return res.status(400).json({ pro: false, error: 'Valid email required' });
  }

  try {
    const license = await kv.get(`pro:${email}`);

    if (!license || !license.active) {
      return res.status(200).json({ pro: false });
    }

    // Generate a signed token so the client can't fake it
    // Token = HMAC(email + timestamp, secret) — valid for 24 hours
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = `${email}:${timestamp}`;
    const secret = process.env.PRO_TOKEN_SECRET || process.env.STRIPE_SECRET_KEY;
    const token = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')
      .substring(0, 32);

    return res.status(200).json({
      pro: true,
      plan: license.plan,
      token,
      timestamp,
      expiresIn: 86400, // 24 hours
    });
  } catch (err) {
    console.error('verify-pro error:', err);
    return res.status(500).json({ pro: false, error: 'Server error' });
  }
}
