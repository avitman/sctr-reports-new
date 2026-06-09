const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // 1. Try StockTwits
  try {
    const { status, body } = await get('https://api.stocktwits.com/api/2/trending/symbols.json');
    if (status === 200) {
      const json = JSON.parse(body);
      const symbols = (json.symbols || []).map((s) => ({
        SYMBOL: s.symbol,
        ST_NAME: s.title || '',
        WATCHLIST_COUNT: s.watchlist_count || 0,
        SOURCE: 'stocktwits',
      }));
      if (symbols.length > 0) return res.status(200).json(symbols);
    }
  } catch { /* fall through */ }

  // 2. Fallback: Yahoo Finance trending (US market)
  try {
    const { status, body } = await get(
      'https://query1.finance.yahoo.com/v1/finance/trending/US?count=30&useQuotes=true'
    );
    if (status === 200) {
      const json = JSON.parse(body);
      const quotes = json?.finance?.result?.[0]?.quotes || [];
      const symbols = quotes
        .filter((q) => q.symbol && !q.symbol.includes('^') && !q.symbol.includes('='))
        .map((q) => ({
          SYMBOL: q.symbol,
          ST_NAME: q.shortName || q.longName || q.symbol,
          WATCHLIST_COUNT: 0,
          SOURCE: 'yahoo',
        }));
      if (symbols.length > 0) return res.status(200).json(symbols);
    }
  } catch { /* fall through */ }

  res.status(502).json({ error: 'Both StockTwits and Yahoo Finance trending are unavailable.' });
};
