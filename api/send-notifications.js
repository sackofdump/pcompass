import { timingSafeEqual } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';

export default async function handler(req, res) {
  // Auth via CRON_SECRET (Vercel sets this for cron jobs) — timing-safe
  const authHeader = req.headers.authorization || '';
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !timingSafeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Skip weekends (UTC day check)
  const day = new Date().getUTCDay();
  if (day === 0 || day === 6) {
    return res.status(200).json({ skipped: true, reason: 'weekend' });
  }

  try {
    // Fetch tokens updated in last 30 days
    const result = await neonSQL(
      `SELECT token FROM push_tokens WHERE updated_at > NOW() - INTERVAL '30 days'`
    );
    const tokens = result.map(r => r.token).filter(Boolean);

    if (tokens.length === 0) {
      return res.status(200).json({ sent: 0, reason: 'no tokens' });
    }

    // Build messages
    const messages = tokens.map(token => ({
      to: token,
      sound: 'default',
      title: 'Markets are open!',
      body: 'Check your portfolio and see today\u2019s picks.',
    }));

    // Send in batches of 100
    const tokensToRemove = [];
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      const pushData = await pushRes.json();

      // Check for DeviceNotRegistered errors and collect tokens to prune
      const tickets = pushData.data || pushData || [];
      tickets.forEach((ticket, idx) => {
        if (ticket.details && ticket.details.error === 'DeviceNotRegistered') {
          tokensToRemove.push(batch[idx].to);
        }
      });
    }

    // Auto-prune invalid tokens
    if (tokensToRemove.length > 0) {
      const placeholders = tokensToRemove.map((_, i) => `$${i + 1}`).join(',');
      await neonSQL(
        `DELETE FROM push_tokens WHERE token IN (${placeholders})`,
        tokensToRemove
      );
    }

    return res.status(200).json({
      sent: tokens.length,
      pruned: tokensToRemove.length,
    });
  } catch (err) {
    console.error('[send-notifications] error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
