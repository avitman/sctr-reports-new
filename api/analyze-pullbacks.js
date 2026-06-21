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
    // Price levels (use for concrete entry/stop/target calculations)
    current:       s.CURRENT,
    week_high:     s.WEEK_HIGH,
    week_low:      s.WEEK_LOW,
    change_pct:    s.CHANGE_PCT,    // today's % move
    // Pullback metrics
    drop_pct:      s.DROP_PCT,
    recovery_pct:  s.RECOVERY_PCT,
    from_high_pct: s.FROM_HIGH_PCT,
    // SCTR (StockCharts Technical Rank)
    sctr:          s.LATEST_SCTR,
    sctr_momentum: s.SCTR_MOMENTUM,
    // Live TradingView data
    tv_rsi:        s.TV_RSI,
    tv_signal:     s.TV_SIGNAL,
    // Earnings
    earn_days:     s.EARN_DAYS,
    earnings_flag: s.EARNINGS_FLAG,
  }));

  const client = new Anthropic({ apiKey });

  const prompt = `You are a senior swing trader analyzing weekly pullback setups in high-SCTR stocks.

DATA FIELDS:
- current / week_high / week_low: actual dollar prices — use these to calculate entry, stop, target
- drop_pct: weekly high-to-low range % (the size of the pullback)
- recovery_pct: how much of the drop has already been recovered (0% = still at low, 100% = fully bounced)
- from_high_pct: % below the weekly high (negative number)
- sctr: StockCharts Technical Rank (≥90 = strong, 95+ = very strong)
- sctr_momentum: 21-day SCTR trend (positive = improving, negative = weakening)
- tv_rsi: live RSI-14 from TradingView
- tv_signal: TradingView overall recommendation (Strong Buy / Buy / Neutral / Sell / Strong Sell)
- earn_days: days to next earnings (null = unknown)
- earnings_flag: true if earnings within 14 days
- change_pct: today's price change %

VERDICT OPTIONS:
- BUYABLE_DIP: Clean pullback, SCTR strong (≥92), RSI healthy (45–75), recovery_pct < 55%, no earnings flag
- ALREADY_BOUNCED: Setup was good but recovery_pct > 70% — entry window likely closed
- RISKY: sctr_momentum negative + rsi < 50, or tv_signal Sell/Strong Sell, or sctr < 91, or rsi > 78 — avoid
- EARNINGS_RISK: earnings_flag true — defer until after announcement

For EACH stock return a JSON object with:
- symbol (string)
- verdict (one of the 4 above)
- confidence: HIGH / MEDIUM / LOW
- entry: specific $ price or tight range (e.g. "$147–150") — base it on current and week_low
- stop: specific $ stop-loss price — typically 2–4% below entry or just below week_low
- target: specific $ price target — based on week_high or prior resistance
- reason: 3–4 sentences. Be specific: reference actual numbers (RSI value, recovery %, SCTR score, today's move). Explain what makes this setup compelling or concerning. Mention the TradingView signal. Give a clear trading rationale, not just a checklist.

Return ONLY a valid JSON array, no markdown, no extra text:
[{"symbol":"X","verdict":"BUYABLE_DIP","confidence":"HIGH","entry":"$147–150","stop":"$142","target":"$162","reason":"..."}]

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
