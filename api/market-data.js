export default async function handler(req, res) {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'No tickers provided' });

  const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
  
  try {
    const results = {};
    await Promise.all(tickerList.map(async (ticker) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await r.json();
        const quote = data?.chart?.result?.[0]?.meta;
        const price = quote?.regularMarketPrice;
        const prev = quote?.chartPreviousClose;
        if (quote && price && prev) {
          results[ticker] = {
            price,
            change: ((price - prev) / prev * 100).toFixed(2),
            name: quote.shortName || ticker
          };
        } else {
          results[ticker] = null;
        }
      } catch {
        results[ticker] = null;
      }
    }));
    res.status(200).json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
