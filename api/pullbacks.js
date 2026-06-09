module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const rawSymbols = req.query.symbols || '';
  const symbols = rawSymbols
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 120);

  if (!symbols.length) {
    return res.status(400).json({ error: 'No symbols' });
  }

  let yahooFinance;
  try {
    yahooFinance = require('yahoo-finance2').default;
  } catch {
    return res.status(500).json({ error: 'yahoo-finance2 not installed' });
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 9 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().split('T')[0];

  const results = [];

  await Promise.allSettled(
    symbols.map(async (sym) => {
      try {
        const hist = await yahooFinance.historical(sym, {
          period1: fmt(startDate),
          period2: fmt(endDate),
          interval: '1d',
        }, { validateResult: false });

        if (!hist || !hist.length) return;

        const highs = hist.map((h) => h.high).filter((v) => v != null && v > 0);
        const lows = hist.map((h) => h.low).filter((v) => v != null && v > 0);
        const closes = hist.map((h) => h.close).filter((v) => v != null && v > 0);

        if (!highs.length || !lows.length || !closes.length) return;

        const weekHigh = Math.max(...highs);
        const weekLow = Math.min(...lows);
        const current = closes[closes.length - 1];
        const priceRange = weekHigh - weekLow;

        results.push({
          SYMBOL: sym,
          WEEK_HIGH: Math.round(weekHigh * 100) / 100,
          WEEK_LOW: Math.round(weekLow * 100) / 100,
          CURRENT: Math.round(current * 100) / 100,
          DROP_PCT: Math.round((priceRange / weekHigh) * 1000) / 10,
          FROM_HIGH_PCT: Math.round(((current - weekHigh) / weekHigh) * 1000) / 10,
          RECOVERY_PCT:
            priceRange > 0 ? Math.round(((current - weekLow) / priceRange) * 1000) / 10 : 50,
        });
      } catch {
        // skip symbol
      }
    })
  );

  results.sort((a, b) => b.DROP_PCT - a.DROP_PCT);
  res.status(200).json(results);
};
