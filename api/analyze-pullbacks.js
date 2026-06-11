const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  let stocks;
  try {
    stocks = req.body?.stocks;
    if (!Array.isArray(stocks) || !stocks.length) throw new Error('No stocks');
    stocks = stocks.slice(0, 30);
  } catch {
    return res.status(400).json({ error: 'Expected { stocks: [...] }' });
  }

  const stripped = stocks.map(s => ({
    symbol:        s.SYMBOL,
    name:          s.NAME || s.SYMBOL,
    sector:        s.SECTOR || '',
    sctr:          s.LATEST_SCTR,
    sctr_momentum: s.SCTR_MOMENTUM,
    rsi:           s.LATEST_RSI,
    drop_pct:      s.DROP_PCT,
    recovery_pct:  s.RECOVERY_PCT,
    from_high_pct: s.FROM_HIGH_PCT,
    earn_days:     s.EARN_DAYS,
    earnings_flag: s.EARNINGS_FLAG,
  }));

  const client = new Anthropic({ apiKey });

  const prompt = `You are a technical analyst reviewing weekly pullback setups in strong SCTR stocks.

Metric guide:
- drop_pct: Weekly high-to-low range (3-20% = technical pullback, >25% often post-earnings)
- recovery_pct: % of drop already recovered (0% = still at low/entry open, 100% = fully bounced)
- from_high_pct: Distance from weekly high (negative)
- sctr: StockCharts Technical Rank ≥90 (95+ = very strong)
- sctr_momentum: 21-day SCTR trend (positive = improving, negative = weakening)
- rsi: 14-day RSI (50-70 = healthy; <45 = weakening; >80 = overbought)
- earn_days: Days to next earnings (null = unknown)
- earnings_flag: true if earnings within 14 days

Verdict rules:
- BUYABLE_DIP: SCTR holding (≥92), RSI in 45-75 range, recovery_pct < 50%, no earnings flag — clean dip to buy
- ALREADY_BOUNCED: Good setup but recovery_pct > 70% — entry window likely closed
- RISKY: sctr_momentum negative + rsi < 50, or rsi > 78 into a drop, or sctr < 91 — avoid
- EARNINGS_RISK: earnings_flag true — defer until after the announcement

Return ONLY a valid JSON array, no markdown, no extra text:
[{"symbol":"X","verdict":"BUYABLE_DIP","reason":"One or two sentences.","confidence":"HIGH"}]

Stocks to analyze:
${JSON.stringify(stripped, null, 2)}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = (response.content[0]?.text || '').trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Model did not return a JSON array');

    const analyses = JSON.parse(match[0]);
    res.status(200).json({ analyses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
