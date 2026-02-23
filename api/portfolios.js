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

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const portfolios = await neonSQL(
        `SELECT id, name, holdings, updated_at FROM portfolios WHERE user_id = $1 ORDER BY updated_at DESC`,
        [parseInt(userId)]
      );
      return res.status(200).json({ portfolios });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (req.method === 'POST') {
    const { userId, name, holdings, portfolioId } = req.body;
    if (!userId || !name || !holdings) return res.status(400).json({ error: 'userId, name, and holdings required' });
    try {
      if (portfolioId) {
        const result = await neonSQL(
          `UPDATE portfolios SET name = $1, holdings = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING id, name, holdings, updated_at`,
          [name, JSON.stringify(holdings), parseInt(portfolioId), parseInt(userId)]
        );
        if (result.length === 0) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ portfolio: result[0] });
      } else {
        const result = await neonSQL(
          `INSERT INTO portfolios (user_id, name, holdings) VALUES ($1, $2, $3) RETURNING id, name, holdings, updated_at`,
          [parseInt(userId), name, JSON.stringify(holdings)]
        );
        return res.status(201).json({ portfolio: result[0] });
      }
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (req.method === 'DELETE') {
    const { userId, portfolioId } = req.query;
    if (!userId || !portfolioId) return res.status(400).json({ error: 'userId and portfolioId required' });
    try {
      await neonSQL(`DELETE FROM portfolios WHERE id = $1 AND user_id = $2`, [parseInt(portfolioId), parseInt(userId)]);
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
