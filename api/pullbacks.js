const TV_COLUMNS = ['close', 'High.5D', 'Low.5D', 'change', 'volume', 'RSI', 'Recommend.All'];
const EXCHANGES  = ['NASDAQ', 'NYSE', 'AMEX'];
const BATCH_SIZE = 500; // TradingView handles large batches fine

function buildTickers(symbols) {
  return symbols.flatMap(s => EXCHANGES.map(ex => `${ex}:${s}`));
}

async function scanTV(tickers) {
  const resp = await fetch('https://scanner.tradingview.com/america/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://www.tradingview.com',
      'Referer': 'https://www.tradingview.com/',
    },
    body: JSON.stringify({ symbols: { tickers }, columns: TV_COLUMNS }),
  });

  if (!resp.ok) throw new Error(`TradingView scanner returned ${resp.status}`);
  return (await resp.json()).data || [];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbols = (req.query.symbols || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 300);

  if (!symbols.length) return res.status(400).json({ error: 'No symbols' });

  try {
    const tickers = buildTickers(symbols);

    // Fetch in batches if needed
    let rows = [];
    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = await scanTV(tickers.slice(i, i + BATCH_SIZE));
      rows.push(...batch);
    }

    // Deduplicate: one result per base symbol, first valid wins
    const seen    = new Set();
    const results = [];

    for (const item of rows) {
      const d       = item.d;
      const close   = d?.[0];
      const wkHigh  = d?.[1];
      const wkLow   = d?.[2];
      const change  = d?.[3];
      const rsi     = d?.[5];
      const recRaw  = d?.[6];

      if (!close || !wkHigh || !wkLow) continue;

      const baseSym = item.s.split(':')[1];
      if (seen.has(baseSym)) continue;
      seen.add(baseSym);

      const priceRange = wkHigh - wkLow;

      let tvSignal = null;
      if (recRaw !== null && recRaw !== undefined) {
        if (recRaw >= 0.5)       tvSignal = 'Strong Buy';
        else if (recRaw >= 0.1)  tvSignal = 'Buy';
        else if (recRaw > -0.1)  tvSignal = 'Neutral';
        else if (recRaw > -0.5)  tvSignal = 'Sell';
        else                     tvSignal = 'Strong Sell';
      }

      results.push({
        SYMBOL:        baseSym,
        WEEK_HIGH:     Math.round(wkHigh  * 100) / 100,
        WEEK_LOW:      Math.round(wkLow   * 100) / 100,
        CURRENT:       Math.round(close   * 100) / 100,
        CHANGE_PCT:    change !== null ? Math.round(change * 10) / 10 : null,
        DROP_PCT:      Math.round((priceRange / wkHigh) * 1000) / 10,
        FROM_HIGH_PCT: Math.round(((close - wkHigh) / wkHigh) * 1000) / 10,
        RECOVERY_PCT:  priceRange > 0
          ? Math.round(((close - wkLow) / priceRange) * 1000) / 10
          : 50,
        TV_RSI:        rsi !== null ? Math.round(rsi * 10) / 10 : null,
        TV_SIGNAL:     tvSignal,
      });
    }

    results.sort((a, b) => b.DROP_PCT - a.DROP_PCT);
    res.status(200).json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
