import { kv } from '@vercel/kv';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

export const config = {
  api: {
    bodyParser: false, // Stripe needs raw body for signature verification
  },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Handle successful payments
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    const customerId = session.customer;

    if (email) {
      // Store pro license keyed by email
      await kv.set(`pro:${email.toLowerCase()}`, {
        active: true,
        plan: session.mode === 'subscription' ? 'monthly' : 'lifetime',
        customerId,
        purchasedAt: new Date().toISOString(),
        sessionId: session.id,
      });

      // Also store a lookup by Stripe customer ID
      if (customerId) {
        await kv.set(`stripe:${customerId}`, email.toLowerCase());
      }

      console.log(`Pro activated for ${email} (${session.mode})`);
    }
  }

  // Handle subscription cancellations
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    // Look up email by customer ID
    const email = await kv.get(`stripe:${customerId}`);
    if (email) {
      const license = await kv.get(`pro:${email}`);
      // Only deactivate if it's a subscription (not lifetime)
      if (license && license.plan !== 'lifetime') {
        await kv.set(`pro:${email}`, { ...license, active: false, cancelledAt: new Date().toISOString() });
        console.log(`Pro deactivated for ${email} (subscription cancelled)`);
      }
    }
  }

  // Handle failed payments
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    const email = await kv.get(`stripe:${customerId}`);
    if (email) {
      const license = await kv.get(`pro:${email}`);
      if (license && license.plan !== 'lifetime') {
        await kv.set(`pro:${email}`, { ...license, active: false, failedAt: new Date().toISOString() });
        console.log(`Pro deactivated for ${email} (payment failed)`);
      }
    }
  }

  res.status(200).json({ received: true });
}
