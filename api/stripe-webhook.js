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

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// ── STRIPE SIGNATURE VERIFICATION ────────────────────────
// Prevents anyone from faking a checkout.session.completed event
// and getting free Pro access. This is critical.
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) {
    // In dev without webhook secret, skip verification
    if (process.env.NODE_ENV !== 'production') return true;
    throw new Error('Missing Stripe webhook secret');
  }

  // Parse Stripe-Signature header: t=timestamp,v1=signature
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) throw new Error('Invalid Stripe-Signature header');

  const timestamp = tPart.slice(2);
  const receivedSig = v1Part.slice(3);

  // Reject webhooks older than 5 minutes (replay attack prevention)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    throw new Error('Webhook timestamp too old — possible replay attack');
  }

  // Compute expected signature: HMAC-SHA256(timestamp.rawBody, secret)
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const payload = `${timestamp}.${rawBody.toString()}`;
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time comparison to prevent timing attacks
  if (receivedSig.length !== expected.length) throw new Error('Signature mismatch');
  let mismatch = 0;
  for (let i = 0; i < receivedSig.length; i++) {
    mismatch |= receivedSig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (mismatch !== 0) throw new Error('Signature mismatch');

  return true;
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await getRawBody(req);

  // Verify signature BEFORE processing anything
  const sigHeader = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature invalid: ' + err.message });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    // ── Payment succeeded → activate Pro ──
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = (session.customer_email || session.customer_details?.email || '').toLowerCase().trim();
      const customerId = session.customer || '';
      // subscription = monthly/annual, payment = lifetime (one-time)
      const plan = session.mode === 'subscription' ? 'monthly' : 'lifetime';

      if (email) {
        await neonSQL(
          `INSERT INTO pro_licenses (email, active, plan, customer_id, session_id, purchased_at)
           VALUES ($1, true, $2, $3, $4, NOW())
           ON CONFLICT (email) DO UPDATE
             SET active = true, plan = $2, customer_id = $3, session_id = $4,
                 purchased_at = NOW(), cancelled_at = NULL, failed_at = NULL`,
          [email, plan, customerId, session.id]
        );
        console.log(`[stripe] Pro activated: ${email} (${plan})`);
      }
    }

    // ── Subscription cancelled ──
    if (event.type === 'customer.subscription.deleted') {
      const customerId = event.data.object.customer;
      if (customerId) {
        await neonSQL(
          `UPDATE pro_licenses SET active = false, cancelled_at = NOW()
           WHERE customer_id = $1 AND plan != 'lifetime'`,
          [customerId]
        );
        console.log(`[stripe] Subscription cancelled for customer: ${customerId}`);
      }
    }

    // ── Payment failed ──
    if (event.type === 'invoice.payment_failed') {
      const customerId = event.data.object.customer;
      // Only deactivate after multiple failures (Stripe retries 3–4 times)
      const attemptCount = event.data.object.attempt_count || 1;
      if (customerId && attemptCount >= 3) {
        await neonSQL(
          `UPDATE pro_licenses SET active = false, failed_at = NOW()
           WHERE customer_id = $1 AND plan != 'lifetime'`,
          [customerId]
        );
        console.log(`[stripe] Pro deactivated after ${attemptCount} failed payments: ${customerId}`);
      }
    }

    // ── Subscription reactivated (e.g. after payment method update) ──
    if (event.type === 'invoice.paid') {
      const customerId = event.data.object.customer;
      if (customerId) {
        await neonSQL(
          `UPDATE pro_licenses SET active = true, failed_at = NULL
           WHERE customer_id = $1 AND plan != 'lifetime'`,
          [customerId]
        );
      }
    }

  } catch (err) {
    console.error('[stripe] Webhook processing error:', err);
    // Still return 200 — Stripe will retry on non-2xx
  }

  return res.status(200).json({ received: true });
}
