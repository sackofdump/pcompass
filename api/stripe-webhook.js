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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await getRawBody(req);

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = (session.customer_email || session.customer_details?.email || '').toLowerCase();
      const customerId = session.customer || '';
      const plan = session.mode === 'subscription' ? 'monthly' : 'lifetime';

      if (email) {
        await neonSQL(
          `INSERT INTO pro_licenses (email, active, plan, customer_id, session_id, purchased_at)
           VALUES ($1, true, $2, $3, $4, NOW())
           ON CONFLICT (email) DO UPDATE SET active = true, plan = $2, customer_id = $3, session_id = $4, purchased_at = NOW(), cancelled_at = NULL, failed_at = NULL`,
          [email, plan, customerId, session.id]
        );
        console.log('Pro activated for ' + email);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const customerId = event.data.object.customer;
      if (customerId) {
        await neonSQL(
          `UPDATE pro_licenses SET active = false, cancelled_at = NOW() WHERE customer_id = $1 AND plan != 'lifetime'`,
          [customerId]
        );
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const customerId = event.data.object.customer;
      if (customerId) {
        await neonSQL(
          `UPDATE pro_licenses SET active = false, failed_at = NOW() WHERE customer_id = $1 AND plan != 'lifetime'`,
          [customerId]
        );
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }

  res.status(200).json({ received: true });
}
