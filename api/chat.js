const Anthropic = require('@anthropic-ai/sdk');

const TV_COLUMNS = [
  'close', 'volume', 'change',
  'RSI', 'MACD.macd', 'MACD.signal', 'MACD.hist',
  'Recommend.All', 'Recommend.MA', 'Recommend.Other',
  'SMA20', 'SMA50', 'SMA200', 'EMA20', 'EMA50',
  'Stoch.K', 'Stoch.D', 'ADX', 'ATR', 'CCI20',
  'High.1W', 'Low.1W', 'Perf.W', 'Perf.1M',
];

function tvSignal(val) {
  if (val === null || val === undefined) return 'N/A';
  if (val >= 0.5)  return 'Strong Buy';
  if (val >= 0.1)  return 'Buy';
  if (val > -0.1)  return 'Neutral';
  if (val > -0.5)  return 'Sell';
  return 'Strong Sell';
}

async function fetchTVAnalysis(rawSymbol) {
  const sym = rawSymbol.toUpperCase().replace(/[^A-Z0-9.:]/g, '');
  const tickers = sym.includes(':')
    ? [sym]
    : [`NASDAQ:${sym}`, `NYSE:${sym}`, `AMEX:${sym}`];

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

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`TradingView scanner returned ${resp.status}: ${body.slice(0, 120)}`);
  }

  const data = await resp.json();
  const item = (data.data || []).find(i => i.d && i.d.some(v => v !== null));
  if (!item) return { error: `No data found for ${sym} on US exchanges` };

  const d = item.d;
  const col = name => { const i = TV_COLUMNS.indexOf(name); return i >= 0 ? d[i] : null; };

  return {
    symbol:                   item.s,
    price:                    col('close'),
    change_pct:               col('change'),
    volume:                   col('volume'),
    rsi:                      col('RSI'),
    macd:                     col('MACD.macd'),
    macd_signal:              col('MACD.signal'),
    macd_hist:                col('MACD.hist'),
    recommendation:           tvSignal(col('Recommend.All')),
    ma_recommendation:        tvSignal(col('Recommend.MA')),
    oscillator_recommendation: tvSignal(col('Recommend.Other')),
    sma20:                    col('SMA20'),
    sma50:                    col('SMA50'),
    sma200:                   col('SMA200'),
    ema20:                    col('EMA20'),
    ema50:                    col('EMA50'),
    week_high:                col('High.1W'),
    week_low:                 col('Low.1W'),
    perf_week:                col('Perf.W'),
    perf_month:               col('Perf.1M'),
    adx:                      col('ADX'),
    stoch_k:                  col('Stoch.K'),
    stoch_d:                  col('Stoch.D'),
    cci20:                    col('CCI20'),
  };
}

const TOOLS = [
  {
    name: 'get_tradingview_analysis',
    description: 'Fetch live technical analysis data from TradingView for a US stock ticker. Returns price, RSI, MACD, moving averages, and buy/sell recommendation. Always call this before discussing a specific stock.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'US stock ticker (e.g. AAPL, NVDA, MSFT). Do not include the exchange prefix.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'embed_tradingview_chart',
    description: 'Render an interactive TradingView chart widget for a stock directly in the chat UI. Call this alongside or after get_tradingview_analysis to give the user a visual. The exchange prefix (e.g. NASDAQ) is returned by get_tradingview_analysis in the "symbol" field.',
    input_schema: {
      type: 'object',
      properties: {
        full_symbol: {
          type: 'string',
          description: 'Full symbol with exchange prefix as returned by get_tradingview_analysis (e.g. NASDAQ:AAPL, NYSE:JPM). If unknown, prefix with NASDAQ.',
        },
        interval: {
          type: 'string',
          enum: ['D', 'W', 'M', '60', '240'],
          description: 'Chart timeframe: D=daily (default), W=weekly, M=monthly, 60=1h, 240=4h',
        },
      },
      required: ['full_symbol'],
    },
  },
];

async function runTool(name, input) {
  if (name === 'get_tradingview_analysis') {
    try {
      return await fetchTVAnalysis(input.symbol);
    } catch (e) {
      return { error: e.message };
    }
  }

  if (name === 'embed_tradingview_chart') {
    const sym = input.full_symbol.includes(':')
      ? input.full_symbol.toUpperCase()
      : `NASDAQ:${input.full_symbol.toUpperCase()}`;
    const interval = input.interval || 'D';
    return { type: 'chart', symbol: sym, interval, rendered: true };
  }

  return { error: `Unknown tool: ${name}` };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { messages, context } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'Expected { messages: [...] }' });
  }

  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are an expert technical analyst for the SCTR Intelligence Dashboard, a tool tracking StockCharts Technical Rank (SCTR) scores for US equities.

You have live access to TradingView technical data and can display interactive charts inside this chat.

Rules:
- When a user asks about a specific stock, ALWAYS call get_tradingview_analysis first, then embed_tradingview_chart.
- Be concise and actionable. Lead with the key signal, then support it.
- Use **bold** for key numbers and signal words (e.g., **RSI 68**, **Strong Buy**, **above SMA50**).
- Format text in markdown (bullet lists, headers are fine).
- If multiple tickers are mentioned, analyze each one separately.
- Relate the TradingView data back to SCTR context when relevant.
- Do not embed charts without first calling get_tradingview_analysis.

${context ? `\nCurrent dashboard snapshot (top SCTR stocks):\n${JSON.stringify(context, null, 2)}` : ''}`;

  const msgs = [...messages];
  let finalText = '';
  const charts = [];

  try {
    for (let turn = 0; turn < 10; turn++) {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
        messages: msgs,
      });

      if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
        finalText = resp.content.find(b => b.type === 'text')?.text || '';
        break;
      }

      if (resp.stop_reason === 'tool_use') {
        msgs.push({ role: 'assistant', content: resp.content });

        const toolResults = [];
        for (const block of resp.content) {
          if (block.type !== 'tool_use') continue;
          const result = await runTool(block.name, block.input);
          if (result.type === 'chart') charts.push({ symbol: result.symbol, interval: result.interval });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }

        msgs.push({ role: 'user', content: toolResults });
      } else {
        finalText = resp.content.find(b => b.type === 'text')?.text || '';
        break;
      }
    }

    res.status(200).json({ text: finalText, charts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
