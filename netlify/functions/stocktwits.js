const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

exports.handler = async () => {
  try {
    const raw = await get('https://api.stocktwits.com/api/2/trending/symbols.json');
    const json = JSON.parse(raw);
    const symbols = (json.symbols || []).map((s) => ({
      SYMBOL: s.symbol,
      ST_NAME: s.title || '',
      WATCHLIST_COUNT: s.watchlist_count || 0,
    }));
    return { statusCode: 200, headers: CORS, body: JSON.stringify(symbols) };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
