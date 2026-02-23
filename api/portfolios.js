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

// ── VERIFY USER IS WHO THEY CLAIM ─────────────────────────
// Without this, any user could pass userId=1 and read/write anyone's portfolios
async function verifyUser(req, claimedUserId) {
  const proToken = req.headers['x-pro-token'] || '';
  const proEmail = req.headers['x-pro-email'] || '';
  const proTs    = req.headers['x-pro-ts']    || '';

  if (!proEmail || !proToken || !proTs) return false;

  // Verify the HMAC token matches the email
  const secret = process.env.PRO_TOKEN_SECRET;
  if (!secret) return false;

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(proTs);
  if (now - ts > 86400) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${proEmail.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);

  if (proToken !== expected) return false;

  // Confirm this token's email matches the claimed userId
  const rows = await neonSQL(
    `SELECT id FROM users WHERE id = $1 AND email = $2 LIMIT 1`,
    [parseInt(claimedUserId), proEmail.toLowerCase().trim()]
  );
  return rows.length > 0;
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {

  if (req.method === 'GET') {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const authorized = await verifyUser(req, userId);
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const portfolios = await neonSQL(
        `SELECT id, name, holdings, updated_at FROM portfolios
         WHERE user_id = $1 ORDER BY updated_at DESC`,
        [parseInt(userId)]
      );
      return res.status(200).json({ portfolios });
    } catch (err) {
      console.error('[portfolios GET]', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method === 'POST') {
    const { userId, name, holdings, portfolioId } = req.body;
    if (!userId || !name || !holdings) {
      return res.status(400).json({ error: 'userId, name, and holdings required' });
    }

    const authorized = await verifyUser(req, userId);
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

    // Validate holdings is an array, not arbitrary JSON
    if (!Array.isArray(holdings)) {
      return res.status(400).json({ error: 'holdings must be an array' });
    }

    try {
      if (portfolioId) {
        const result = await neonSQL(
          `UPDATE portfolios SET name = $1, holdings = $2, updated_at = NOW()
           WHERE id = $3 AND user_id = $4
           RETURNING id, name, holdings, updated_at`,
          [name, JSON.stringify(holdings), parseInt(portfolioId), parseInt(userId)]
        );
        if (result.length === 0) return res.status(404).json({ error: 'Portfolio not found' });
        return res.status(200).json({ portfolio: result[0] });
      } else {
        const result = await neonSQL(
          `INSERT INTO portfolios (user_id, name, holdings)
           VALUES ($1, $2, $3)
           RETURNING id, name, holdings, updated_at`,
          [parseInt(userId), name, JSON.stringify(holdings)]
        );
        return res.status(201).json({ portfolio: result[0] });
      }
    } catch (err) {
      console.error('[portfolios POST]', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method === 'DELETE') {
    const { userId, portfolioId } = req.query;
    if (!userId || !portfolioId) {
      return res.status(400).json({ error: 'userId and portfolioId required' });
    }

    const authorized = await verifyUser(req, userId);
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

    try {
      await neonSQL(
        `DELETE FROM portfolios WHERE id = $1 AND user_id = $2`,
        [parseInt(portfolioId), parseInt(userId)]
      );
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[portfolios DELETE]', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
