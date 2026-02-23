import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // use service role, not anon key
)

export default async function handler(req, res) {
  const { email, token, timestamp } = req.query;
  if (!email || !token || !timestamp) return res.status(400).json({ valid: false });

  const secret = process.env.PRO_TOKEN_SECRET;
  if (!secret) throw new Error('PRO_TOKEN_SECRET is not set');

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (now - ts > 86400) return res.status(200).json({ valid: false, reason: 'expired' });

  // 1. Verify HMAC
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${email.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);

  if (token !== expected) return res.status(200).json({ valid: false, reason: 'invalid_token' });

  // 2. Confirm still subscribed in Supabase
  const { data } = await supabase
    .from('subscribers')
    .select('subscribed')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (!data?.subscribed) return res.status(200).json({ valid: false, reason: 'not_subscribed' });

  return res.status(200).json({ valid: true });
}
