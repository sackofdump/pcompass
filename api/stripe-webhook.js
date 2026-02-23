async function kvSet(key, value) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;
  const r = await fetch(`${kvUrl}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, JSON.stringify(value)]),
  });
  return r.json();
}

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

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await getRawBody(req);
  
  // Simple webhook handling - for production, verify signature with Stripe
  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    const customerId = session.customer;

    if (email) {
      await kvSet(`pro:${email.toLowerCase()}`, {
        active: true,
        plan: session.mode === 'subscription' ? 'monthly' : 'lifetime',
        customerId,
        purchasedAt: new Date().toISOString(),
        sessionId: session.id,
      });
      if (customerId) await kvSet(`stripe:${customerId}`, email.toLowerCase());
      console.log(`Pro activated for ${email}`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const customerId = event.data.object.customer;
    const email = await kvGet(`stripe:${customerId}`);
    if (email) {
      const license = await kvGet(`pro:${email}`);
      if (license && license.plan !== 'lifetime') {
        await kvSet(`pro:${email}`, { ...license, active: false, cancelledAt: new Date().toISOString() });
      }
    }
  }

  if (event.type === 'invoice.payment_failed') {
    const customerId = event.data.object.customer;
    const email = await kvGet(`stripe:${customerId}`);
    if (email) {
      const license = await kvGet(`pro:${email}`);
      if (license && license.plan !== 'lifetime') {
        await kvSet(`pro:${email}`, { ...license, active: false, failedAt: new Date().toISOString() });
      }
    }
  }

  res.status(200).json({ received: true });
}
