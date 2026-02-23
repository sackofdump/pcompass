import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  const sql = neon(process.env.POSTGRES_URL);

  // GET — load all portfolios for a user
  if (req.method === 'GET') {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
      const portfolios = await sql`
        SELECT id, name, holdings, updated_at
        FROM portfolios
        WHERE user_id = ${parseInt(userId)}
        ORDER BY updated_at DESC
      `;
      return res.status(200).json({ portfolios });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — save a new portfolio or update existing
  if (req.method === 'POST') {
    const { userId, name, holdings, portfolioId } = req.body;
    if (!userId || !name || !holdings) {
      return res.status(400).json({ error: 'userId, name, and holdings required' });
    }

    try {
      if (portfolioId) {
        // Update existing
        const result = await sql`
          UPDATE portfolios
          SET name = ${name}, holdings = ${JSON.stringify(holdings)}, updated_at = NOW()
          WHERE id = ${parseInt(portfolioId)} AND user_id = ${parseInt(userId)}
          RETURNING id, name, holdings, updated_at
        `;
        if (result.length === 0) return res.status(404).json({ error: 'Portfolio not found' });
        return res.status(200).json({ portfolio: result[0] });
      } else {
        // Create new
        const result = await sql`
          INSERT INTO portfolios (user_id, name, holdings)
          VALUES (${parseInt(userId)}, ${name}, ${JSON.stringify(holdings)})
          RETURNING id, name, holdings, updated_at
        `;
        return res.status(201).json({ portfolio: result[0] });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove a portfolio
  if (req.method === 'DELETE') {
    const { userId, portfolioId } = req.query;
    if (!userId || !portfolioId) {
      return res.status(400).json({ error: 'userId and portfolioId required' });
    }

    try {
      await sql`
        DELETE FROM portfolios
        WHERE id = ${parseInt(portfolioId)} AND user_id = ${parseInt(userId)}
      `;
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
