/* ─────────────────────────────────────────────────────────
   SCTR Investment Dashboard — app.js
   Replaces the Streamlit dashboard with a fully browser-side
   implementation backed by Supabase + Netlify Functions.
   ───────────────────────────────────────────────────────── */

// ── State ──────────────────────────────────────────────────
let _supabase = null;
let allData   = [];   // raw rows from Supabase
let scores    = [];   // computed composite scores
let filtered  = [];   // scores after sidebar filters
let latestDate = '';  // 'YYYY-MM-DD'
let totalDays  = 0;
let activeTab  = 'top-picks';
let sidebarCollapsed = false;

const CACHE_KEY = 'sctr_data_v2';
const CACHE_TTL = 5 * 60 * 1000; // 5 min

// ── Boot ───────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Wire tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Wire sidebar filter listeners
  wireFilters();

  // Start
  init().catch(e => showOverlayError(e.message));
});

async function init() {
  setLoadingText('Fetching configuration…');
  const cfg = await fetchConfig();

  setLoadingText('Connecting to Supabase…');
  _supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

  setLoadingText('Loading SCTR data…');
  allData = await loadAllData();

  if (!allData.length) throw new Error('No data found in Supabase.');

  setLoadingText('Computing scores…');
  scores = computeScores(allData);

  // Derive state
  latestDate = allData.reduce((m, r) => r.DATE > m ? r.DATE : m, '');
  totalDays  = new Set(allData.map(r => r.DATE)).size;

  // Populate sidebar sectors
  buildSectorCheckboxes();

  // Update filters → filtered
  applyFilters();

  // KPIs
  updateKPIs();

  // Populate selects
  populateDDSymbols();
  populateHistDates();

  // Load spec inline
  loadSpec();

  // Show app
  document.getElementById('loading-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  // Render first visible tab
  renderTopPicks();
  renderSectors();
}

// ── Config ─────────────────────────────────────────────────
async function fetchConfig() {
  // 1. Try Netlify function (production)
  try {
    const r = await fetch('/api/config', { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.supabaseUrl && cfg.supabaseKey) return cfg;
    }
  } catch {}

  // 2. Try window global (e.g. injected via a local script tag)
  if (window.SCTR_CONFIG?.supabaseUrl) return window.SCTR_CONFIG;

  // 3. Try localStorage (saved from the config prompt)
  const saved = getSavedConfig();
  if (saved) return saved;

  // 4. Show config prompt and wait for the user to submit
  return waitForConfigPrompt();
}

function getSavedConfig() {
  try {
    const s = localStorage.getItem('sctr_cfg');
    if (!s) return null;
    const c = JSON.parse(s);
    return (c.supabaseUrl && c.supabaseKey) ? c : null;
  } catch { return null; }
}

function waitForConfigPrompt() {
  document.getElementById('loading-overlay').style.display = 'none';
  document.getElementById('config-overlay').style.display = 'flex';

  return new Promise((resolve) => {
    window._resolveConfig = resolve;
  });
}

function submitConfig() {
  const url = document.getElementById('cfg-url').value.trim();
  const key = document.getElementById('cfg-key').value.trim();
  const err = document.getElementById('cfg-error');

  if (!url || !url.startsWith('https://')) {
    err.style.display = 'block';
    err.textContent = 'Enter a valid Supabase URL (starts with https://)';
    return;
  }
  if (!key || key.length < 20) {
    err.style.display = 'block';
    err.textContent = 'Enter a valid Supabase anon key';
    return;
  }

  err.style.display = 'none';
  const cfg = { supabaseUrl: url, supabaseKey: key };
  try { localStorage.setItem('sctr_cfg', JSON.stringify(cfg)); } catch {}

  document.getElementById('config-overlay').style.display = 'none';
  document.getElementById('loading-overlay').style.display = 'flex';

  if (window._resolveConfig) window._resolveConfig(cfg);
}

// ── Data Loading ───────────────────────────────────────────
async function loadAllData() {
  const cached = getCachedData();
  if (cached) return cached;

  const chunk = 1000;
  let start = 0;
  const rows = [];

  while (true) {
    const { data, error } = await _supabase
      .from('sctr_daily')
      .select('*')
      .range(start, start + chunk - 1);

    if (error) throw new Error(error.message);
    if (!data || !data.length) break;

    rows.push(...data);
    if (data.length < chunk) break;
    start += chunk;
    setLoadingText(`Loading data… ${rows.length} rows`);
  }

  const normalized = rows.map(normalizeRow).filter(r => r.SYMBOL);
  normalized.sort((a, b) => a.DATE.localeCompare(b.DATE));

  setCachedData(normalized);
  return normalized;
}

function normalizeRow(r) {
  const MAP = {
    run_date:'DATE', rank:'RANK', symbol:'SYMBOL', sctr:'SCTR', sctr_chg:'SCTR_CHG',
    name:'NAME', sector:'SECTOR', industry:'INDUSTRY', market_cap:'MARKET CAP',
    volume:'VOLUME', vlast1d:'VLAST1D', vlast2d:'VLAST2D',
    rsi:'RSI', atr:'ATR', vwap:'VWAP', avwap:'AVWAP',
    last:'LAST', chg:'CHG', chg_pct:'CHG%',
    last1d:'LAST1D', last2d:'LAST2D',
    ma10:'MA10', ma20:'MA20', ma50:'MA50', ma150:'MA150',
    earn_date:'EARN_DATE', earn_days:'EARN_DAYS',
  };
  const out = {};
  for (const [from, to] of Object.entries(MAP)) {
    if (r[from] !== undefined) out[to] = r[from];
    else if (r[to] !== undefined) out[to] = r[to]; // already mapped
  }
  // Carry through any cols not in map
  for (const k of Object.keys(r)) {
    if (k !== 'id' && !MAP[k] && out[k] === undefined) out[k] = r[k];
  }

  // Normalise DATE to YYYY-MM-DD
  if (out.DATE) out.DATE = out.DATE.substring(0, 10);

  // Numeric coercions
  for (const col of ['VOLUME','VLAST1D','VLAST2D']) {
    if (out[col] != null) out[col] = parseNum(String(out[col]).replace(/,/g,''));
  }
  for (const col of ['SCTR','SCTR_CHG','RSI','ATR','VWAP','AVWAP','LAST','CHG','CHG%',
                      'LAST1D','LAST2D','MA10','MA20','MA50','MA150','EARN_DAYS','RANK']) {
    if (out[col] != null) out[col] = parseNum(out[col]);
  }

  out.SYMBOL = String(out.SYMBOL || '').trim().toUpperCase();
  return out;
}

function parseNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// ── Cache ──────────────────────────────────────────────────
function getCachedData() {
  try {
    const s = localStorage.getItem(CACHE_KEY);
    if (!s) return null;
    const { ts, data } = JSON.parse(s);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}
function setCachedData(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

// ── Scoring ────────────────────────────────────────────────
function computeScores(data) {
  const days    = new Set(data.map(r => r.DATE));
  const nDays   = days.size;
  const latest  = [...days].sort().at(-1);

  // Group by symbol
  const bySymbol = {};
  for (const row of data) {
    (bySymbol[row.SYMBOL] = bySymbol[row.SYMBOL] || []).push(row);
  }

  const d21 = offsetDate(latest, -21);

  const rows = [];
  for (const [sym, arr] of Object.entries(bySymbol)) {
    arr.sort((a, b) => a.DATE.localeCompare(b.DATE));
    const last = arr.at(-1);

    const recent = arr.filter(r => r.DATE >= d21);
    const older  = arr.filter(r => r.DATE < d21);

    const avgArr  = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;
    const pickNum = (a, col) => a.map(r => r[col]).filter(v => v != null);

    const sctrArr   = pickNum(arr, 'SCTR');
    const latestSctr = last.SCTR;
    const recentSctr = avgArr(pickNum(recent, 'SCTR'));
    const olderSctr  = avgArr(pickNum(older,  'SCTR'));
    const sctrMom    = (recentSctr != null && olderSctr != null) ? recentSctr - olderSctr : 0;

    const recentVol = avgArr(pickNum(recent, 'VOLUME'));
    const olderVol  = avgArr(pickNum(older,  'VOLUME'));
    const volTrend  = (recentVol && olderVol && olderVol > 0)
                      ? (recentVol - olderVol) / olderVol * 100 : 0;

    rows.push({
      SYMBOL: sym,
      TOTAL_APPEARANCES: arr.length,
      CONSISTENCY_PCT: arr.length / nDays * 100,
      IN_LATEST: last.DATE === latest,
      AVG_SCTR: avgArr(sctrArr),
      LATEST_SCTR: latestSctr,
      SCTR_MOMENTUM: sctrMom,
      LATEST_RSI: last.RSI,
      VOLUME_TREND: volTrend,
      AVG_VOLUME: avgArr(pickNum(arr, 'VOLUME')),
      EARN_DAYS: last.EARN_DAYS,
      NAME: last.NAME, SECTOR: last.SECTOR, INDUSTRY: last.INDUSTRY,
      'MARKET CAP': last['MARKET CAP'], LAST: last.LAST, ATR: last.ATR,
    });
  }

  // Normalise
  const norm = vals => {
    const mn = Math.min(...vals), mx = Math.max(...vals);
    if (mx === mn) return vals.map(() => 50);
    return vals.map(v => Math.max(0, Math.min(100, (v - mn) / (mx - mn) * 100)));
  };

  const cCons = norm(rows.map(r => r.CONSISTENCY_PCT));
  const cSctr = norm(rows.map(r => r.LATEST_SCTR ?? 90));
  const cMom  = norm(rows.map(r => r.SCTR_MOMENTUM ?? 0));
  const cVol  = norm(rows.map(r => r.VOLUME_TREND  ?? 0));

  rows.forEach((r, i) => {
    const rsi  = r.LATEST_RSI ?? 60;
    const cRsi = Math.max(0, Math.min(100, 100 - Math.abs(rsi - 62) * 2));
    const earn = r.EARN_DAYS  ?? 30;
    const cEar = Math.max(0, Math.min(100, Math.min(earn, 30) / 30 * 100));
    const cLat = r.IN_LATEST ? 20 : 0;

    r.SCORE = round1(
      cCons[i] * 0.25 + cSctr[i] * 0.20 + cMom[i] * 0.20 +
      cVol[i]  * 0.15 + cRsi    * 0.10 + cEar   * 0.05 + cLat * 0.05
    );
  });

  rows.sort((a, b) => b.SCORE - a.SCORE);
  return rows;
}

// ── Swing Score ────────────────────────────────────────────
function computeSwingScores(todayRows) {
  const norm = vals => {
    const mn = Math.min(...vals), mx = Math.max(...vals);
    if (mx === mn) return vals.map(() => 50);
    return vals.map(v => Math.max(0, Math.min(100, (v - mn) / (mx - mn) * 100)));
  };

  const swing = todayRows.map(r => ({ ...r }));

  swing.forEach(r => {
    const prev = ((r.VLAST1D ?? r.VOLUME) + (r.VLAST2D ?? r.VOLUME)) / 2;
    r.VOL_EXPANSION = prev > 0 ? ((r.VOLUME / prev) - 1) * 100 : 0;
    r.ATR_PCT = (r.ATR && r.LAST > 0) ? r.ATR / r.LAST * 100 : 0;
    r.AVWAP_PREMIUM = (r.AVWAP && r.AVWAP > 0) ? (r.LAST - r.AVWAP) / r.AVWAP * 100 : 0;
  });

  const cSctr = norm(swing.map(r => r.SCTR ?? 90));
  const cVol  = norm(swing.map(r => r.VOL_EXPANSION ?? 0));
  const cChg  = norm(swing.map(r => r['CHG%'] ?? 0));
  const cAtr  = norm(swing.map(r => r.ATR_PCT ?? 0));

  swing.forEach((r, i) => {
    const rsi  = r.RSI ?? 62;
    const cRsi = Math.max(0, Math.min(100, 100 - Math.abs(rsi - 62) * 2.5));
    r.SWING_SCORE = round1(
      cSctr[i] * 0.30 + cVol[i] * 0.25 + cRsi * 0.20 + cChg[i] * 0.15 + cAtr[i] * 0.10
    );
    if (r.ATR && r.LAST) {
      r.ENTRY_LIMIT    = round2(r.LAST);
      r.ENTRY_BREAKOUT = round2(r.LAST * 1.005);
      r.STOP           = round2(r.LAST - 1.5 * r.ATR);
      r.TP1            = round2(r.LAST + 3.0 * r.ATR);
      r.TP2            = round2(r.LAST + 4.5 * r.ATR);
      r.RISK_PCT       = round2(1.5 * r.ATR / r.LAST * 100);
    }
  });

  swing.sort((a, b) => b.SWING_SCORE - a.SWING_SCORE);
  return swing;
}

// ── Filters ────────────────────────────────────────────────
function wireFilters() {
  const update = () => { applyFilters(); renderActiveTab(); };

  const link = (id, valId, fmt) => {
    const el = document.getElementById(id);
    const vEl = document.getElementById(valId);
    el.addEventListener('input', () => {
      if (vEl) vEl.textContent = fmt(el.value);
      update();
    });
  };

  link('f-consistency', 'f-consistency-val', v => `${v}%`);
  link('f-sctr',        'f-sctr-val',        v => v);
  link('top-n',         'top-n-val',         v => `${v} stocks`);
  link('swing-n',       'swing-n-val',       v => `${v} stocks`);
  link('pb-drop',       'pb-drop-val',       v => `${v}%`);
  link('pb-drop-max',   'pb-drop-max-val',   v => `${v}%`);

  document.getElementById('f-only-today').addEventListener('change', update);
  document.getElementById('f-earn-days').addEventListener('change', update);
}

function applyFilters() {
  const minCons   = +document.getElementById('f-consistency').value;
  const minSctr   = +document.getElementById('f-sctr').value;
  const onlyToday = document.getElementById('f-only-today').checked;
  const earnDays  = +document.getElementById('f-earn-days').value;

  const checkedSectors = [...document.querySelectorAll('#sector-checkboxes input:checked')]
                          .map(el => el.value);

  filtered = scores.filter(r => {
    if (r.CONSISTENCY_PCT < minCons) return false;
    if ((r.LATEST_SCTR ?? 0) < minSctr) return false;
    if (onlyToday && !r.IN_LATEST) return false;
    if (earnDays > 0 && r.EARN_DAYS != null && r.EARN_DAYS < earnDays) return false;
    if (checkedSectors.length > 0 && !checkedSectors.includes(r.SECTOR)) return false;
    return true;
  });
}

function buildSectorCheckboxes() {
  const sectors = [...new Set(allData.map(r => r.SECTOR).filter(Boolean))].sort();
  const container = document.getElementById('sector-checkboxes');
  container.innerHTML = sectors.map(s =>
    `<label><input type="checkbox" value="${esc(s)}" checked onchange="applyFilters();renderActiveTab()"> ${esc(s)}</label>`
  ).join('');
}

// ── KPIs ───────────────────────────────────────────────────
function updateKPIs() {
  const dates  = [...new Set(allData.map(r => r.DATE))].sort();
  const minDate = fmtDateDisplay(dates[0]);
  const maxDate = fmtDateDisplay(dates.at(-1));
  const todayCt = allData.filter(r => r.DATE === latestDate).length;

  document.getElementById('kpi-days').textContent   = totalDays;
  document.getElementById('kpi-stocks').textContent = new Set(allData.map(r => r.SYMBOL)).size;
  document.getElementById('kpi-range').textContent  = `${minDate} → ${maxDate}`;
  document.getElementById('kpi-today').textContent  = todayCt;
  document.getElementById('last-updated-text').textContent = `Updated ${maxDate}`;
}

// ── Tab Routing ────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  document.getElementById(`tab-${tab}`).style.display = 'block';
  renderActiveTab(true);
}

function renderActiveTab(force = false) {
  switch (activeTab) {
    case 'top-picks': renderTopPicks(); break;
    case 'swing':     renderSwing(); break;
    case 'pullback':  break; // on-demand
    case 'social':    break; // on-demand
    case 'sectors':   renderSectors(); break;
    case 'deep-dive': renderDeepDive(); break;
    case 'history':   renderHistory(); break;
  }
}

// ── Tab: Top Picks ─────────────────────────────────────────
function renderTopPicks() {
  const n   = +document.getElementById('top-n').value;
  const top = filtered.slice(0, n);

  if (!top.length) {
    document.getElementById('chart-top-picks').innerHTML = '<div class="info-msg warn-msg">No stocks match current filters.</div>';
    document.getElementById('cards-top-picks').innerHTML = '';
    return;
  }

  // Bar chart
  const colors = top.map(r => scoreColor(r.SCORE));
  Plotly.newPlot('chart-top-picks', [{
    type: 'bar', orientation: 'h',
    x: top.map(r => r.SCORE),
    y: top.map(r => r.SYMBOL),
    marker: { color: colors },
    hovertemplate: '<b>%{y}</b><br>Score: %{x:.1f}<extra></extra>',
    text: top.map(r => r.SCORE.toFixed(1)),
    textposition: 'outside',
    textfont: { color: '#8ab4cf', size: 11 },
  }], {
    ...plotlyBase(),
    title: { text: 'Composite Investment Score', font: { color: '#d4e8f4', size: 15 } },
    height: Math.max(320, top.length * 32),
    yaxis: { categoryorder: 'total ascending', tickfont: { color: '#7aadcc', family: 'JetBrains Mono' } },
    xaxis: { range: [0, 100] },
    margin: { t: 50, r: 60, b: 40, l: 90 },
  }, plotlyConfig());

  // Cards
  document.getElementById('cards-top-picks').innerHTML = top.map(r => stockCard(r)).join('');
}

// ── Tab: Swing ─────────────────────────────────────────────
function renderSwing() {
  const todayRows = allData.filter(r => r.DATE === latestDate);
  if (!todayRows.length) {
    document.getElementById('chart-swing').innerHTML  = '<div class="info-msg warn-msg">No data for today.</div>';
    document.getElementById('cards-swing').innerHTML  = '';
    return;
  }

  const swing = computeSwingScores(todayRows);
  const n     = Math.min(+document.getElementById('swing-n').value, swing.length);
  document.getElementById('swing-n').max = swing.length;

  const top = swing.slice(0, n);
  const colors = top.map(r => scoreColor(r.SWING_SCORE));

  Plotly.newPlot('chart-swing', [{
    type: 'bar', orientation: 'h',
    x: top.map(r => r.SWING_SCORE),
    y: top.map(r => r.SYMBOL),
    marker: { color: colors },
    hovertemplate: '<b>%{y}</b><br>Swing Score: %{x:.1f}<extra></extra>',
    text: top.map(r => r.SWING_SCORE.toFixed(1)),
    textposition: 'outside',
    textfont: { color: '#8ab4cf', size: 11 },
  }], {
    ...plotlyBase(),
    title: { text: 'Short-Term Swing Score (Today\'s Stocks Only)', font: { color: '#d4e8f4', size: 15 } },
    height: Math.max(320, n * 32),
    yaxis: { categoryorder: 'total ascending', tickfont: { color: '#7aadcc', family: 'JetBrains Mono' } },
    xaxis: { range: [0, 100] },
    margin: { t: 50, r: 60, b: 40, l: 90 },
  }, plotlyConfig());

  document.getElementById('cards-swing').innerHTML = top.map(r => swingCard(r)).join('');

  // Full table
  document.getElementById('table-swing').innerHTML = buildTable(swing, [
    'SYMBOL','NAME','SECTOR','SWING_SCORE','SCTR','RSI','CHG%',
    'VOL_EXPANSION','ATR','ENTRY_LIMIT','ENTRY_BREAKOUT','STOP','TP1','TP2','RISK_PCT',
  ], {
    SWING_SCORE: v => fmtNum(v, 1),
    'CHG%': v => fmtPct(v),
    VOL_EXPANSION: v => fmtPct(v),
    ENTRY_LIMIT: v => fmtDollar(v),
    ENTRY_BREAKOUT: v => fmtDollar(v),
    STOP: v => fmtDollar(v),
    TP1: v => fmtDollar(v),
    TP2: v => fmtDollar(v),
    RISK_PCT: v => fmtNum(v, 1) + '%',
  });
}

// ── Yahoo Finance browser fallback ────────────────────────
async function fetchSymbolYahoo(sym) {
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d&includePrePost=false`;

  // Try direct fetch first
  try {
    const r = await fetch(chartUrl, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
    if (r.ok) return await r.json();
  } catch {}

  // CORS proxy fallback (for local dev)
  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(chartUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(chartUrl)}`,
  ];
  for (const proxy of proxies) {
    try {
      const r = await fetch(proxy, { signal: AbortSignal.timeout(10000) });
      if (r.ok) return await r.json();
    } catch {}
  }
  return null;
}

async function fetchPullbacksFromYahoo(symbols, onProgress) {
  const results = [];
  const CONCURRENCY = 6;
  let done = 0;

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async sym => {
      try {
        const data   = await fetchSymbolYahoo(sym);
        const result = data?.chart?.result?.[0];
        if (!result) return;

        const q      = result.indicators.quote[0];
        const highs  = (q.high  || []).filter(v => v != null);
        const lows   = (q.low   || []).filter(v => v != null);
        const closes = (q.close || []).filter(v => v != null);
        if (!highs.length || !lows.length || !closes.length) return;

        const weekHigh   = Math.max(...highs);
        const weekLow    = Math.min(...lows);
        const current    = closes[closes.length - 1];
        const priceRange = weekHigh - weekLow;

        results.push({
          SYMBOL:        sym,
          WEEK_HIGH:     round2(weekHigh),
          WEEK_LOW:      round2(weekLow),
          CURRENT:       round2(current),
          DROP_PCT:      Math.round(priceRange / weekHigh * 1000) / 10,
          FROM_HIGH_PCT: Math.round((current - weekHigh) / weekHigh * 1000) / 10,
          RECOVERY_PCT:  priceRange > 0 ? Math.round((current - weekLow) / priceRange * 1000) / 10 : 50,
        });
      } catch { /* skip symbol */ }
      done++;
      if (onProgress) onProgress(done, symbols.length, results.length);
    }));
  }

  return results.sort((a, b) => b.DROP_PCT - a.DROP_PCT);
}

// ── Tab: Weekly Pullback ───────────────────────────────────
async function loadPullbacks() {
  const d7      = offsetDate(latestDate, -7);
  const syms    = [...new Set(allData.filter(r => r.DATE >= d7).map(r => r.SYMBOL))];
  const minDrop = +document.getElementById('pb-drop').value;
  const maxDrop = +document.getElementById('pb-drop-max').value;

  if (!syms.length) {
    showInfoMsg('pb-status', 'No symbols in the past week.', 'warn');
    return;
  }

  showInfoMsg('pb-status', `Fetching price data for ${syms.length} symbols…`, '');
  document.getElementById('chart-pb-drop').style.display  = 'none';
  document.getElementById('chart-pb-range').style.display = 'none';

  try {
    let raw;

    // Try Netlify function first (production)
    const res = await fetch(`/api/pullbacks?symbols=${syms.join(',')}`);
    if (res.ok) {
      raw = await res.json();
    } else {
      // Fallback: fetch Yahoo Finance chart API directly from the browser
      showInfoMsg('pb-status', `Fetching from Yahoo Finance (0 / ${syms.length} symbols)…`, '');
      raw = await fetchPullbacksFromYahoo(syms, (done, total, found) => {
        showInfoMsg('pb-status', `Fetching from Yahoo Finance (${done} / ${total} symbols, ${found} with data)…`, '');
      });
      if (!raw.length) {
        showInfoMsg('pb-status', 'Yahoo Finance returned no data — possibly CORS-blocked in this browser. Try deploying to Netlify.', 'warn');
        return;
      }
    }

    const pb = raw
      .filter(r => r.DROP_PCT >= minDrop && r.DROP_PCT <= maxDrop)
      .map(r => {
        const sc = scores.find(s => s.SYMBOL === r.SYMBOL) || {};
        // Flag stocks where earnings likely just happened (low EARN_DAYS = post-earnings drop risk)
        const earnDays = sc.EARN_DAYS;
        const earningsFlag = earnDays != null && earnDays <= 14;
        return { ...r, LATEST_SCTR: sc.LATEST_SCTR, SECTOR: sc.SECTOR, NAME: sc.NAME,
                 SCORE: sc.SCORE, SCTR_MOMENTUM: sc.SCTR_MOMENTUM, EARN_DAYS: earnDays,
                 EARNINGS_FLAG: earningsFlag };
      });

    const excluded = raw.filter(r => r.DROP_PCT > maxDrop).length;

    if (!pb.length) {
      const allDrops = raw.map(r => r.DROP_PCT).filter(Boolean).sort((a,b) => b - a);
      const topDrop  = allDrops[0] ? allDrops[0].toFixed(1) : '?';
      showInfoMsg('pb-status',
        `0 stocks in the ${minDrop}–${maxDrop}% range out of ${raw.length} fetched. ` +
        `Largest drop: ${topDrop}%${excluded ? ` (${excluded} excluded above ${maxDrop}% — likely earnings)` : ''}. Try adjusting the sliders.`, 'warn');
      document.getElementById('table-pullback').innerHTML = '';
      return;
    }

    const earningsFlagged = pb.filter(r => r.EARNINGS_FLAG).length;
    showInfoMsg('pb-status',
      `${pb.length} stocks with ${minDrop}–${maxDrop}% pullback` +
      (excluded ? ` · ${excluded} excluded >${ maxDrop}% (likely earnings reactions)` : '') +
      (earningsFlagged ? ` · ⚠ ${earningsFlagged} have earnings within 14 days` : ''), '');

    // Drop % bar
    document.getElementById('chart-pb-drop').style.display = 'block';
    Plotly.newPlot('chart-pb-drop', [{
      type: 'bar', orientation: 'h',
      x: pb.map(r => r.DROP_PCT),
      y: pb.map(r => r.SYMBOL),
      // Green = clean technical pullback, gold = earnings nearby, color fades with recovery
      marker: {
        color: pb.map(r => {
          const recovered = (r.RECOVERY_PCT ?? 0) / 100;
          if (r.EARNINGS_FLAG) return `rgba(255,${Math.round(165 + 90 * recovered)},0,0.85)`;
          return `rgba(${Math.round(0 + 60 * recovered)},${Math.round(200 - 80 * recovered)},255,0.8)`;
        }),
      },
      hovertemplate: pb.map(r =>
        `<b>${r.SYMBOL}</b>${r.EARNINGS_FLAG ? ' ⚠ earnings nearby' : ''}<br>` +
        `Drop: ${r.DROP_PCT.toFixed(1)}%<br>` +
        `Recovery: ${(r.RECOVERY_PCT ?? 0).toFixed(0)}%` +
        (r.RECOVERY_PCT < 30 ? ' — still near low ✓' : r.RECOVERY_PCT > 70 ? ' — mostly recovered' : '') +
        `<extra></extra>`
      ),
      text: pb.map(r => `${r.DROP_PCT.toFixed(1)}%  ${(r.RECOVERY_PCT ?? 0).toFixed(0)}% rec.`),
      textposition: 'outside',
      textfont: { color: '#8ab4cf', size: 10 },
    }], {
      ...plotlyBase(),
      title: { text: `Technical Pullbacks ${minDrop}–${maxDrop}%  ·  Blue = near low (buy zone) · Gold = earnings risk`, font: { color: '#d4e8f4', size: 14 } },
      height: Math.max(320, pb.length * 36),
      yaxis: { categoryorder: 'total ascending', tickfont: { color: '#7aadcc', family: 'JetBrains Mono' } },
      margin: { t: 50, r: 140, b: 40, l: 90 },
    }, plotlyConfig());

    // Range chart
    document.getElementById('chart-pb-range').style.display = 'block';
    const rangeTraces = [];
    for (const r of pb) {
      rangeTraces.push({
        type: 'scatter', mode: 'lines+markers',
        x: [r.WEEK_LOW, r.CURRENT, r.WEEK_HIGH],
        y: [r.SYMBOL, r.SYMBOL, r.SYMBOL],
        marker: { color: ['#ff4757','#ffd700','#00ff88'], size: [8,13,8], symbol: ['circle','diamond','circle'] },
        line: { color: 'rgba(100,150,200,0.4)', width: 2 },
        name: r.SYMBOL, showlegend: false,
        hovertemplate: `<b>${r.SYMBOL}</b><br>Low: $${r.WEEK_LOW}<br>Current: $${r.CURRENT}<br>High: $${r.WEEK_HIGH}<extra></extra>`,
      });
    }
    Plotly.newPlot('chart-pb-range', rangeTraces, {
      ...plotlyBase(),
      title: { text: 'Weekly Price Range — Low (red) · Current (gold) · High (green)', font: { color: '#d4e8f4', size: 14 } },
      height: Math.max(320, pb.length * 32),
      xaxis: { title: 'Price ($)', tickfont: { color: '#7aadcc' } },
      yaxis: { tickfont: { color: '#7aadcc', family: 'JetBrains Mono' } },
      margin: { t: 50, r: 30, b: 50, l: 90 },
    }, plotlyConfig());

    document.getElementById('table-pullback').innerHTML = buildTable(pb, [
      'SYMBOL','NAME','SECTOR','WEEK_HIGH','WEEK_LOW','CURRENT',
      'DROP_PCT','FROM_HIGH_PCT','RECOVERY_PCT','LATEST_SCTR','SCTR_MOMENTUM','EARN_DAYS',
    ], {
      WEEK_HIGH: v => fmtDollar(v),
      WEEK_LOW: v => fmtDollar(v),
      CURRENT: v => fmtDollar(v),
      DROP_PCT: v => fmtPct(v),
      FROM_HIGH_PCT: v => fmtPct(v),
      RECOVERY_PCT: v => fmtNum(v, 1) + '%',
    });

  } catch (e) {
    showInfoMsg('pb-status', `Error: ${e.message}`, 'error');
  }
}

// ── Tab: Social Buzz ───────────────────────────────────────
async function loadSocial() {
  const cards = document.getElementById('cards-social');
  cards.innerHTML = '<div class="info-msg">Fetching StockTwits trending…</div>';
  document.getElementById('social-kpis').style.display = 'none';
  document.getElementById('chart-social').style.display = 'none';
  document.getElementById('social-table-expander').style.display = 'none';

  try {
    const ST_URL = 'https://api.stocktwits.com/api/2/trending/symbols.json';
    const parseStockTwits = async r => {
      const json = await r.json();
      return (json.symbols || []).map(s => ({
        SYMBOL: s.symbol, ST_NAME: s.title || '', WATCHLIST_COUNT: s.watchlist_count || 0,
      }));
    };

    let trending;

    // 1. Netlify function (production)
    try {
      const r = await fetch('/api/stocktwits', { signal: AbortSignal.timeout(5000) });
      if (r.ok) trending = await parseStockTwits(r);
    } catch {}

    // 2. Direct fetch (sometimes works locally)
    if (!trending) {
      try {
        const r = await fetch(ST_URL, { signal: AbortSignal.timeout(5000) });
        if (r.ok) trending = await parseStockTwits(r);
      } catch {}
    }

    // 3. CORS proxy fallback (for local dev where StockTwits blocks direct requests)
    if (!trending) {
      const proxies = [
        `https://corsproxy.io/?${encodeURIComponent(ST_URL)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(ST_URL)}`,
      ];
      for (const proxyUrl of proxies) {
        try {
          const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
          if (r.ok) { trending = await parseStockTwits(r); break; }
        } catch {}
      }
    }

    if (!trending) throw new Error('All StockTwits fetch attempts failed (CORS restriction in local dev).');

    if (!Array.isArray(trending) || !trending.length) {
      cards.innerHTML = '<div class="info-msg warn-msg">No trending data available.</div>';
      return;
    }

    const merged = trending.map(t => {
      const sc = scores.find(s => s.SYMBOL === t.SYMBOL) || {};
      return { ...t, ...sc, NAME: sc.NAME || t.ST_NAME, IN_SCTR: sc.SCORE != null };
    });

    const inBoth = merged.filter(m => m.IN_SCTR).length;
    const pct    = Math.round(inBoth / merged.length * 100);

    const kpis = document.getElementById('social-kpis');
    kpis.style.display = 'flex';
    kpis.innerHTML = `
      <div class="kpi-mini"><div class="kpi-mini-label">Trending on StockTwits</div><div class="kpi-mini-value">${merged.length}</div></div>
      <div class="kpi-mini"><div class="kpi-mini-label">Also in SCTR</div><div class="kpi-mini-value" style="color:var(--green)">${inBoth}</div></div>
      <div class="kpi-mini"><div class="kpi-mini-label">Overlap</div><div class="kpi-mini-value" style="color:var(--gold)">${pct}%</div></div>
    `;

    // Bar chart
    const sorted = [...merged].sort((a, b) => b.WATCHLIST_COUNT - a.WATCHLIST_COUNT);
    document.getElementById('chart-social').style.display = 'block';
    Plotly.newPlot('chart-social', [{
      type: 'bar',
      x: sorted.map(r => r.SYMBOL),
      y: sorted.map(r => r.WATCHLIST_COUNT),
      marker: { color: sorted.map(r => r.IN_SCTR ? 'rgba(0,255,136,0.7)' : 'rgba(74,122,155,0.4)') },
      hovertemplate: '<b>%{x}</b><br>Watchlist: %{y:,}<extra></extra>',
    }], {
      ...plotlyBase(),
      title: { text: 'StockTwits Watchlist Count (green = also in SCTR scanner)', font: { color: '#d4e8f4', size: 14 } },
      height: 340,
      xaxis: { tickangle: 45, tickfont: { color: '#7aadcc', family: 'JetBrains Mono', size: 11 } },
      yaxis: { title: 'Watchlist Count' },
      margin: { t: 50, r: 20, b: 80, l: 70 },
    }, plotlyConfig());

    // Intersection cards
    const intersection = merged.filter(m => m.IN_SCTR).sort((a, b) => (b.SCORE ?? 0) - (a.SCORE ?? 0));
    if (intersection.length) {
      cards.innerHTML = `<h3 style="color:var(--cyan);margin-bottom:10px;">🎯 SCTR + Social Intersection (${intersection.length})</h3>` +
        intersection.map(r => socialCard(r)).join('');
    } else {
      cards.innerHTML = '<div class="info-msg">No overlap between trending symbols and SCTR scanner right now.</div>';
    }

    // Full table
    document.getElementById('social-table-expander').style.display = 'block';
    document.getElementById('table-social').innerHTML = buildTable(merged, [
      'SYMBOL','NAME','WATCHLIST_COUNT','IN_SCTR','LATEST_SCTR','SCORE','SECTOR','LATEST_RSI','CONSISTENCY_PCT',
    ], {
      IN_SCTR: v => v ? '✓' : '—',
      SCORE: v => fmtNum(v, 1),
      LATEST_SCTR: v => fmtNum(v, 1),
      CONSISTENCY_PCT: v => fmtNum(v, 0) + '%',
    });

  } catch (e) {
    cards.innerHTML = `<div class="info-msg error-msg">Error: ${e.message}</div>`;
  }
}

// ── Tab: Sectors ───────────────────────────────────────────
function renderSectors() {
  if (!allData.some(r => r.SECTOR)) return;

  const d90 = offsetDate(latestDate, -90);
  const d30 = offsetDate(latestDate, -30);

  // Area chart — stocks per sector per week
  const weekData = {};
  allData.filter(r => r.DATE >= d90 && r.SECTOR).forEach(r => {
    const wk = weekStart(r.DATE);
    const key = `${wk}||${r.SECTOR}`;
    if (!weekData[key]) weekData[key] = new Set();
    weekData[key].add(r.SYMBOL);
  });

  const weeks   = [...new Set(Object.keys(weekData).map(k => k.split('||')[0]))].sort();
  const sectors = [...new Set(allData.map(r => r.SECTOR).filter(Boolean))].sort();

  const SECTOR_COLORS = [
    '#00d4ff','#00ff88','#ffd700','#ff4757','#a78bfa',
    '#ff8c42','#4ecdc4','#ff6b9d','#c9f547','#6baeee',
  ];

  const areaTraces = sectors.map((s, i) => ({
    type: 'scatter', mode: 'lines', stackgroup: 'one',
    name: s,
    x: weeks,
    y: weeks.map(w => weekData[`${w}||${s}`]?.size ?? 0),
    line: { width: 0.5 },
    fillcolor: SECTOR_COLORS[i % SECTOR_COLORS.length].replace(')', ',0.6)').replace('rgb(', 'rgba(').replace('#', ''),
  }));

  // Fix fillcolor for hex
  areaTraces.forEach((t, i) => {
    const hex = SECTOR_COLORS[i % SECTOR_COLORS.length];
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    t.fillcolor = `rgba(${r},${g},${b},0.55)`;
    t.line = { color: `rgba(${r},${g},${b},0.9)`, width: 1 };
  });

  Plotly.newPlot('chart-sector-time', areaTraces, {
    ...plotlyBase(),
    title: { text: 'Stocks per Sector in SCTR Scanner (Last 90 Days)', font: { color: '#d4e8f4', size: 15 } },
    height: 340,
    xaxis: { tickformat: '%b %d', tickfont: { color: '#7aadcc' } },
    yaxis: { title: 'Stock Count', tickfont: { color: '#7aadcc' } },
    legend: { font: { color: '#8ab4cf', size: 11 }, bgcolor: 'rgba(0,0,0,0.3)' },
    margin: { t: 50, r: 20, b: 50, l: 60 },
  }, plotlyConfig());

  // Avg SCTR by sector bar
  const sectorSctr = {};
  allData.filter(r => r.SECTOR && r.SCTR).forEach(r => {
    (sectorSctr[r.SECTOR] = sectorSctr[r.SECTOR] || []).push(r.SCTR);
  });
  const sAvg = Object.entries(sectorSctr)
    .map(([s, vals]) => ({ s, avg: vals.reduce((a,b)=>a+b,0)/vals.length }))
    .sort((a, b) => b.avg - a.avg);

  Plotly.newPlot('chart-sector-sctr', [{
    type: 'bar',
    x: sAvg.map(r => r.s),
    y: sAvg.map(r => round2(r.avg)),
    marker: { color: sAvg.map((r,i) => SECTOR_COLORS[i % SECTOR_COLORS.length]) },
    hovertemplate: '<b>%{x}</b><br>Avg SCTR: %{y:.1f}<extra></extra>',
  }], {
    ...plotlyBase(),
    title: { text: 'Avg SCTR by Sector', font: { color: '#d4e8f4', size: 14 } },
    height: 300,
    xaxis: { tickangle: 35, tickfont: { color: '#7aadcc', size: 10 } },
    yaxis: { range: [88, 100], tickfont: { color: '#7aadcc' } },
    margin: { t: 45, r: 10, b: 90, l: 55 },
  }, plotlyConfig());

  // Pie
  const sFreq = {};
  allData.filter(r => r.SECTOR).forEach(r => { sFreq[r.SECTOR] = (sFreq[r.SECTOR] || 0) + 1; });
  Plotly.newPlot('chart-sector-pie', [{
    type: 'pie',
    labels: Object.keys(sFreq),
    values: Object.values(sFreq),
    marker: { colors: Object.keys(sFreq).map((_, i) => SECTOR_COLORS[i % SECTOR_COLORS.length]) },
    textinfo: 'label+percent',
    textfont: { color: '#d4e8f4', size: 11 },
    hole: 0.3,
  }], {
    ...plotlyBase(),
    title: { text: 'Scanner Appearances by Sector', font: { color: '#d4e8f4', size: 14 } },
    height: 300,
    showlegend: false,
    margin: { t: 45, r: 10, b: 20, l: 10 },
  }, plotlyConfig());

  // Momentum bar
  const sRecent = {}, sOlder = {};
  allData.filter(r => r.SECTOR).forEach(r => {
    const bucket = r.DATE >= d30 ? sRecent : sOlder;
    (bucket[r.SECTOR] = bucket[r.SECTOR] || new Set()).add(r.SYMBOL);
  });

  const sectors2 = [...new Set([...Object.keys(sRecent), ...Object.keys(sOlder)])].sort();
  const changes  = sectors2.map(s => (sRecent[s]?.size ?? 0) - (sOlder[s]?.size ?? 0));
  const momColors = changes.map(v => v >= 0 ? 'rgba(0,255,136,0.7)' : 'rgba(255,71,87,0.7)');

  Plotly.newPlot('chart-sector-momentum', [{
    type: 'bar',
    x: sectors2,
    y: changes,
    marker: { color: momColors },
    hovertemplate: '<b>%{x}</b><br>Change: %{y:+d}<extra></extra>',
    text: changes.map(v => (v >= 0 ? '+' : '') + v),
    textposition: 'outside',
    textfont: { color: '#8ab4cf', size: 11 },
  }], {
    ...plotlyBase(),
    title: { text: 'Sector Momentum: Recent 30d vs Prior (Unique Stocks Delta)', font: { color: '#d4e8f4', size: 14 } },
    height: 300,
    xaxis: { tickangle: 35, tickfont: { color: '#7aadcc', size: 10 } },
    yaxis: { tickfont: { color: '#7aadcc' }, zeroline: true, zerolinecolor: 'rgba(100,150,200,0.3)' },
    margin: { t: 45, r: 10, b: 90, l: 55 },
  }, plotlyConfig());
}

// ── Tab: Deep Dive ─────────────────────────────────────────
function populateDDSymbols() {
  const syms = [...new Set(allData.map(r => r.SYMBOL))].sort();
  const sel  = document.getElementById('dd-symbol');
  sel.innerHTML = syms.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

function renderDeepDive() {
  const sym  = document.getElementById('dd-symbol').value;
  const rows = allData.filter(r => r.SYMBOL === sym).sort((a, b) => a.DATE.localeCompare(b.DATE));
  if (!rows.length) return;

  const last = rows.at(-1);

  // Summary KPIs
  const kpisEl = document.getElementById('dd-summary-row');
  kpisEl.innerHTML = `
    <div class="kpi-mini"><div class="kpi-mini-label">SCTR (Latest)</div><div class="kpi-mini-value">${fmtNum(last.SCTR,1)}</div></div>
    <div class="kpi-mini"><div class="kpi-mini-label">Days on List</div><div class="kpi-mini-value">${rows.length}</div></div>
    <div class="kpi-mini"><div class="kpi-mini-label">Consistency</div><div class="kpi-mini-value">${Math.round(rows.length/totalDays*100)}%</div></div>
    ${last.RSI != null ? `<div class="kpi-mini"><div class="kpi-mini-label">RSI</div><div class="kpi-mini-value" style="color:${rsiColor(last.RSI)}">${fmtNum(last.RSI,1)}</div></div>` : ''}
    ${last.EARN_DAYS != null ? `<div class="kpi-mini"><div class="kpi-mini-label">Earnings In</div><div class="kpi-mini-value" style="color:${earnColor(last.EARN_DAYS)}">${Math.round(last.EARN_DAYS)}d</div></div>` : ''}
  `;
  document.getElementById('dd-meta').textContent =
    `${last.NAME || sym}  ·  ${last.SECTOR || ''}  ·  ${last.INDUSTRY || ''}`;

  const dates = rows.map(r => r.DATE);

  // SCTR over time
  Plotly.newPlot('chart-dd-sctr', [
    { type:'scatter', mode:'lines+markers', name:'SCTR',
      x: dates, y: rows.map(r => r.SCTR),
      line: { color:'#00d4ff', width:2 }, marker:{size:4} },
    { type:'scatter', mode:'lines', name:'90 threshold',
      x: [dates[0], dates.at(-1)], y: [90,90],
      line: { color:'#ffd700', width:1, dash:'dash' } },
  ], { ...plotlyBase(), height:280,
       title:{ text:`${sym} — SCTR Over Time`, font:{color:'#d4e8f4',size:14} },
       showlegend:false, margin:{t:45,r:20,b:40,l:55} }, plotlyConfig());

  // Price vs MAs
  const priceCols = [
    ['LAST',  '#00ff88', 2.5], ['MA10', '#00d4ff', 1],
    ['MA20',  '#a78bfa', 1],   ['MA50',  '#ffd700', 1.5],
    ['MA150', '#ff4757', 2],
  ];
  const priceTraces = priceCols
    .filter(([col]) => rows.some(r => r[col] != null))
    .map(([col, color, width]) => ({
      type:'scatter', mode:'lines', name:col,
      x: rows.filter(r => r[col] != null).map(r => r.DATE),
      y: rows.filter(r => r[col] != null).map(r => r[col]),
      line: { color, width },
    }));

  if (priceTraces.length) {
    Plotly.newPlot('chart-dd-price', priceTraces, {
      ...plotlyBase(), height:300,
      title:{ text:`${sym} — Price vs Moving Averages`, font:{color:'#d4e8f4',size:14} },
      legend:{ font:{color:'#8ab4cf',size:11}, bgcolor:'rgba(0,0,0,0.3)' },
      margin:{t:45,r:20,b:40,l:65},
    }, plotlyConfig());
  }

  // Volume
  const volRows = rows.filter(r => r.VOLUME != null);
  if (volRows.length) {
    Plotly.newPlot('chart-dd-volume', [{
      type:'bar', name:'Volume',
      x: volRows.map(r => r.DATE),
      y: volRows.map(r => r.VOLUME),
      marker: { color:'rgba(0,212,255,0.5)' },
    }], { ...plotlyBase(), height:220,
         title:{ text:`${sym} — Volume History`, font:{color:'#d4e8f4',size:14} },
         yaxis:{ tickformat:'~s', tickfont:{color:'#7aadcc'} },
         margin:{t:45,r:20,b:40,l:65} }, plotlyConfig());
  }

  // RSI
  const rsiRows = rows.filter(r => r.RSI != null);
  if (rsiRows.length) {
    Plotly.newPlot('chart-dd-rsi', [
      { type:'scatter', mode:'lines', fill:'tozeroy', name:'RSI',
        x: rsiRows.map(r => r.DATE), y: rsiRows.map(r => r.RSI),
        line:{ color:'#a78bfa', width:1.5 }, fillcolor:'rgba(167,139,250,0.12)' },
      { type:'scatter', mode:'lines', name:'Overbought 70',
        x:[rsiRows[0].DATE, rsiRows.at(-1).DATE], y:[70,70],
        line:{color:'#ff4757',width:1,dash:'dash'}, showlegend:false },
      { type:'scatter', mode:'lines', name:'Neutral 50',
        x:[rsiRows[0].DATE, rsiRows.at(-1).DATE], y:[50,50],
        line:{color:'#00ff88',width:1,dash:'dash'}, showlegend:false },
    ], { ...plotlyBase(), height:220,
         title:{ text:`${sym} — RSI History`, font:{color:'#d4e8f4',size:14} },
         yaxis:{ range:[0,100], tickfont:{color:'#7aadcc'} },
         showlegend:false,
         margin:{t:45,r:20,b:40,l:55} }, plotlyConfig());
  }

  // Raw table
  document.getElementById('table-deep-dive').innerHTML = buildTable(
    [...rows].reverse(),
    ['DATE','SCTR','LAST','CHG%','RSI','ATR','VOLUME','MA10','MA20','MA50','MA150','EARN_DAYS'],
    { 'CHG%': v => fmtPct(v), LAST: v => fmtDollar(v), ATR: v => fmtDollar(v),
      VOLUME: v => v ? Number(v).toLocaleString() : '—',
      MA10: v => fmtDollar(v), MA20: v => fmtDollar(v), MA50: v => fmtDollar(v), MA150: v => fmtDollar(v) }
  );
}

// ── Tab: History ───────────────────────────────────────────
function populateHistDates() {
  const dates = [...new Set(allData.map(r => r.DATE))].sort().reverse();
  const sel   = document.getElementById('hist-date');
  sel.innerHTML = dates.map(d => `<option value="${esc(d)}">${fmtDateDisplay(d)}</option>`).join('');
  renderHistory();
}

function renderHistory() {
  const date = document.getElementById('hist-date').value;
  const rows = allData.filter(r => r.DATE === date).sort((a, b) => (b.SCTR ?? 0) - (a.SCTR ?? 0));

  const msgEl = document.getElementById('hist-count');
  msgEl.style.display = 'block';
  msgEl.textContent   = `${rows.length} stocks on ${fmtDateDisplay(date)}`;

  if (!rows.length) {
    document.getElementById('chart-hist-sector').style.display = 'none';
    document.getElementById('table-history').innerHTML = '';
    return;
  }

  // Sector pie
  const sFreq = {};
  rows.filter(r => r.SECTOR).forEach(r => { sFreq[r.SECTOR] = (sFreq[r.SECTOR] || 0) + 1; });
  if (Object.keys(sFreq).length > 1) {
    document.getElementById('chart-hist-sector').style.display = 'block';
    const colors = ['#00d4ff','#00ff88','#ffd700','#ff4757','#a78bfa','#ff8c42','#4ecdc4','#ff6b9d','#c9f547','#6baeee'];
    Plotly.newPlot('chart-hist-sector', [{
      type:'pie', labels:Object.keys(sFreq), values:Object.values(sFreq),
      marker:{ colors: Object.keys(sFreq).map((_, i) => colors[i % colors.length]) },
      textinfo:'label+percent', textfont:{ color:'#d4e8f4', size:11 }, hole:0.3,
    }], { ...plotlyBase(), height:280,
         title:{ text:`Sector Distribution — ${fmtDateDisplay(date)}`, font:{color:'#d4e8f4',size:14} },
         showlegend:false, margin:{t:45,r:10,b:10,l:10} }, plotlyConfig());
  }

  const HIST_COLS = ['RANK','SYMBOL','NAME','SECTOR','SCTR','SCTR_CHG','LAST','CHG%',
                     'RSI','ATR','VOLUME','MA10','MA20','MA50','MA150','EARN_DATE','EARN_DAYS'];
  document.getElementById('table-history').innerHTML = buildTable(
    rows,
    HIST_COLS.filter(c => rows[0][c] !== undefined),
    { SCTR: v => fmtNum(v,1), 'CHG%': v => fmtPct(v),
      LAST:  v => fmtDollar(v), ATR: v => fmtDollar(v),
      VOLUME: v => v ? Number(v).toLocaleString() : '—',
      MA10: v => fmtDollar(v), MA20: v => fmtDollar(v),
      MA50: v => fmtDollar(v), MA150: v => fmtDollar(v) }
  );
}

// ── Spec ───────────────────────────────────────────────────
function loadSpec() {
  document.getElementById('spec-content').innerHTML = `
    <h1>SCTR Investment Dashboard — Technical Specification</h1>

    <h2>What is SCTR?</h2>
    <p>The SCTR (StockCharts Technical Rank) is a numerical score from <strong>0–99.99</strong> that ranks a stock
    relative to all other stocks in its peer group (large-cap, mid-cap, small-cap) based purely on technical
    indicators across multiple timeframes.</p>
    <p>A score of <strong>≥ 90</strong> means the stock is in the top 10% of its peer group technically.</p>

    <h2>Data Pipeline</h2>
    <ul>
      <li>GitHub Actions runs <code>scraper/scrape_sctr.py</code> daily (or manually).</li>
      <li>The scraper uses Playwright to extract the StockCharts SCTR table, enriches it with yfinance OHLCV data,
          validates strict uptrend conditions, and uploads to Supabase.</li>
      <li>This dashboard reads from Supabase and computes scores entirely in the browser.</li>
    </ul>

    <h2>Scraper Validation Criteria</h2>
    <p>A stock must pass <em>all</em> of the following to be included:</p>
    <ul>
      <li>SCTR ≥ 90 and Volume &gt; 1M shares</li>
      <li>MA10 ≥ MA20 (short-term momentum above medium)</li>
      <li>Last price ≥ MA10, MA20, MA50, MA150 (above all MAs)</li>
      <li>Last ≥ Last1D ≥ Last2D (consecutive uptrend)</li>
      <li>Last price is a 52-week high</li>
      <li>Earnings &gt; 7 days away</li>
    </ul>

    <h2>Composite Score (0–100)</h2>
    <table>
      <thead><tr><th>Component</th><th>Weight</th><th>Formula</th></tr></thead>
      <tbody>
        <tr><td>Consistency</td><td>25%</td><td>% of scanner days the stock appeared</td></tr>
        <tr><td>SCTR Level</td><td>20%</td><td>Latest SCTR score (normalised)</td></tr>
        <tr><td>SCTR Momentum</td><td>20%</td><td>Recent 21d avg − older avg</td></tr>
        <tr><td>Volume Trend</td><td>15%</td><td>Recent vol avg vs prior avg</td></tr>
        <tr><td>RSI Health</td><td>10%</td><td><code>100 − |RSI − 62| × 2</code> — sweet spot at 62</td></tr>
        <tr><td>Earnings Safety</td><td>5%</td><td><code>min(days,30)/30 × 100</code></td></tr>
        <tr><td>In Today's List</td><td>5%</td><td>+20 bonus if in latest scan</td></tr>
      </tbody>
    </table>

    <h2>Swing Score (Short-Term Swing Tab)</h2>
    <p>Only ranks stocks in the <em>latest</em> scan date. Uses different weights optimised for 1–5 day trades:</p>
    <table>
      <thead><tr><th>Component</th><th>Weight</th></tr></thead>
      <tbody>
        <tr><td>SCTR</td><td>30%</td></tr>
        <tr><td>Volume expansion vs prior 2 days</td><td>25%</td></tr>
        <tr><td>RSI health (sweet spot 62)</td><td>20%</td></tr>
        <tr><td>Daily % change</td><td>15%</td></tr>
        <tr><td>ATR-to-price ratio</td><td>10%</td></tr>
      </tbody>
    </table>

    <h2>ATR-Based Trade Levels</h2>
    <ul>
      <li><strong>Limit Entry</strong> — last close (buy the pullback)</li>
      <li><strong>Breakout Entry</strong> — last close × 1.005 (momentum entry)</li>
      <li><strong>Stop</strong> — entry − 1.5 × ATR</li>
      <li><strong>TP1 (2:1 R/R)</strong> — entry + 3.0 × ATR</li>
      <li><strong>TP2 (3:1 R/R)</strong> — entry + 4.5 × ATR</li>
    </ul>

    <h2>Data Columns</h2>
    <table>
      <thead><tr><th>Column</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td>DATE</td><td>Scan date (YYYY-MM-DD)</td></tr>
        <tr><td>SYMBOL</td><td>Ticker symbol</td></tr>
        <tr><td>SCTR</td><td>StockCharts Technical Rank (0–99.99)</td></tr>
        <tr><td>LAST</td><td>Closing price on scan date</td></tr>
        <tr><td>RSI</td><td>14-day Relative Strength Index</td></tr>
        <tr><td>ATR</td><td>14-day Average True Range</td></tr>
        <tr><td>VWAP</td><td>Volume-Weighted Average Price (daily)</td></tr>
        <tr><td>AVWAP</td><td>Anchored VWAP (year start)</td></tr>
        <tr><td>MA10/20/50/150</td><td>Simple Moving Averages</td></tr>
        <tr><td>EARN_DATE</td><td>Next earnings announcement date</td></tr>
        <tr><td>EARN_DAYS</td><td>Days until next earnings</td></tr>
      </tbody>
    </table>
  `;
}

// ── Card Builders ──────────────────────────────────────────
function stockCard(r) {
  const sc = r.SCORE ?? 0;
  const cls = sc >= 70 ? 'score-high' : sc >= 50 ? 'score-med' : 'score-low';
  const color = scoreColor(sc);
  return `
    <div class="stock-card ${cls}">
      <div class="card-top">
        <div>
          <div class="card-symbol">${esc(r.SYMBOL)}</div>
          <div class="card-name">${esc(r.NAME || '')}</div>
          <div class="card-sector">${esc(r.SECTOR || '')} ${r.INDUSTRY ? '· ' + esc(r.INDUSTRY) : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:var(--text-muted)">Score</div>
          <div style="font-size:22px;font-weight:700;color:${color};font-family:var(--font-mono);text-shadow:0 0 12px ${color}40">${sc.toFixed(1)}</div>
        </div>
      </div>
      <div class="card-metrics">
        <div class="metric"><div class="metric-label">SCTR</div><div class="metric-value cyan">${fmtNum(r.LATEST_SCTR,1)}</div></div>
        <div class="metric"><div class="metric-label">Consistency</div><div class="metric-value gold">${fmtNum(r.CONSISTENCY_PCT,0)}%</div></div>
        <div class="metric"><div class="metric-label">SCTR Mom.</div><div class="metric-value ${(r.SCTR_MOMENTUM??0)>=0?'green':'red'}">${r.SCTR_MOMENTUM!=null?(r.SCTR_MOMENTUM>=0?'+':'')+fmtNum(r.SCTR_MOMENTUM,1):'—'}</div></div>
        ${r.LAST != null ? `<div class="metric"><div class="metric-label">Last Price</div><div class="metric-value">${fmtDollar(r.LAST)}</div></div>` : ''}
        ${r.ATR  != null ? `<div class="metric"><div class="metric-label">ATR</div><div class="metric-value">${fmtDollar(r.ATR)}</div></div>` : ''}
      </div>
      <div class="card-badges">
        ${r.LATEST_RSI != null ? rsiBadge(r.LATEST_RSI) : ''}
        ${r.EARN_DAYS  != null ? earnBadge(r.EARN_DAYS)  : ''}
        ${r.VOLUME_TREND != null ? `<span class="badge ${r.VOLUME_TREND>=0?'badge-green':'badge-red'}">Vol ${r.VOLUME_TREND>=0?'+':''}${fmtNum(r.VOLUME_TREND,0)}%</span>` : ''}
        ${r.IN_LATEST ? '<span class="badge badge-cyan">✓ In Today\'s List</span>' : ''}
        <span class="badge badge-gray">${r.TOTAL_APPEARANCES} / ${totalDays} days</span>
      </div>
    </div>`;
}

function swingCard(r) {
  const color = scoreColor(r.SWING_SCORE);
  const hasLevels = r.ENTRY_LIMIT != null;
  return `
    <div class="stock-card" style="border-left-color:${color}">
      <div class="card-top">
        <div>
          <div class="card-symbol">${esc(r.SYMBOL)}</div>
          <div class="card-name">${esc(r.NAME || '')}</div>
          <div class="card-sector">${esc(r.SECTOR || '')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:var(--text-muted)">Swing Score</div>
          <div style="font-size:22px;font-weight:700;color:${color};font-family:var(--font-mono)">${r.SWING_SCORE.toFixed(1)}</div>
        </div>
      </div>
      <div class="card-metrics">
        <div class="metric"><div class="metric-label">SCTR</div><div class="metric-value cyan">${fmtNum(r.SCTR,1)}</div></div>
        <div class="metric"><div class="metric-label">RSI</div><div class="metric-value" style="color:${rsiColor(r.RSI)}">${fmtNum(r.RSI,1)}</div></div>
        <div class="metric"><div class="metric-label">CHG%</div><div class="metric-value ${(r['CHG%']??0)>=0?'green':'red'}">${r['CHG%']!=null?(r['CHG%']>=0?'+':'')+fmtNum(r['CHG%'],2)+'%':'—'}</div></div>
        <div class="metric"><div class="metric-label">Vol Exp.</div><div class="metric-value ${(r.VOL_EXPANSION??0)>=0?'gold':'red'}">${r.VOL_EXPANSION!=null?(r.VOL_EXPANSION>=0?'+':'')+fmtNum(r.VOL_EXPANSION,0)+'%':'—'}</div></div>
      </div>
      ${hasLevels ? `
      <div class="trade-levels">
        <span class="lv-entry">🎯 Limit</span> <span class="lv-strong">${fmtDollar(r.ENTRY_LIMIT)}</span>
        &nbsp;&nbsp;
        <span class="lv-bo">🚀 Breakout</span> <span class="lv-strong">${fmtDollar(r.ENTRY_BREAKOUT)}</span>
        <br>
        <span class="lv-stop">✕ Stop</span> <span class="lv-strong">${fmtDollar(r.STOP)}</span>
        <span class="lv-risk"> (${fmtNum(r.RISK_PCT,1)}% risk)</span>
        <br>
        <span class="lv-tp1">✔ TP1 (2:1)</span> <span class="lv-strong">${fmtDollar(r.TP1)}</span>
        &nbsp;&nbsp;
        <span class="lv-tp2">✔ TP2 (3:1)</span> <span class="lv-strong">${fmtDollar(r.TP2)}</span>
      </div>` : ''}
      <div class="card-badges" style="margin-top:6px">
        ${r.EARN_DAYS != null ? earnBadge(r.EARN_DAYS) : ''}
        ${r.ATR != null ? `<span class="badge badge-gray">ATR $${fmtNum(r.ATR,2)}</span>` : ''}
        ${r.AVWAP_PREMIUM != null ? `<span class="badge ${r.AVWAP_PREMIUM>=0?'badge-green':'badge-red'}">AVWAP ${r.AVWAP_PREMIUM>=0?'+':''}${fmtNum(r.AVWAP_PREMIUM,1)}%</span>` : ''}
      </div>
    </div>`;
}

function socialCard(r) {
  return `
    <div class="stock-card" style="border-left-color:var(--green)">
      <div class="card-top">
        <div>
          <div class="card-symbol">${esc(r.SYMBOL)}</div>
          <div class="card-name">${esc(r.NAME || '')}</div>
          <div class="card-sector">${esc(r.SECTOR || '')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:var(--text-muted)">Watchlist</div>
          <div style="font-size:20px;font-weight:700;color:var(--cyan);font-family:var(--font-mono)">${Number(r.WATCHLIST_COUNT||0).toLocaleString()}</div>
        </div>
      </div>
      <div class="card-metrics">
        ${r.SCORE      != null ? `<div class="metric"><div class="metric-label">SCTR Score</div><div class="metric-value cyan">${fmtNum(r.SCORE,1)}</div></div>` : ''}
        ${r.LATEST_SCTR!= null ? `<div class="metric"><div class="metric-label">SCTR</div><div class="metric-value gold">${fmtNum(r.LATEST_SCTR,1)}</div></div>` : ''}
        ${r.CONSISTENCY_PCT!=null ? `<div class="metric"><div class="metric-label">Consistency</div><div class="metric-value">${fmtNum(r.CONSISTENCY_PCT,0)}%</div></div>` : ''}
      </div>
      <div class="card-badges">
        ${r.LATEST_RSI != null ? rsiBadge(r.LATEST_RSI) : ''}
        ${r.EARN_DAYS  != null ? earnBadge(r.EARN_DAYS)  : ''}
        ${r.IN_LATEST  ? '<span class="badge badge-cyan">✓ In Today\'s List</span>' : ''}
      </div>
    </div>`;
}

// ── Table Builder ──────────────────────────────────────────
function buildTable(rows, cols, formatters = {}) {
  if (!rows.length) return '<div class="info-msg">No data.</div>';

  const availCols = cols.filter(c => rows.some(r => r[c] != null && r[c] !== undefined));

  const header = availCols.map(c =>
    `<th onclick="sortTable(this)">${esc(c.replace('_', ' '))}</th>`
  ).join('');

  const body = rows.map(r => {
    const cells = availCols.map(c => {
      const val = r[c];
      const fmt = formatters[c];
      const display = (val == null) ? '—' : fmt ? fmt(val) : (typeof val === 'number' ? fmtNum(val, 2) : esc(String(val)));
      let cls = '';
      if (c === 'SYMBOL') cls = 'td-symbol';
      else if (typeof val === 'number' && (c.includes('CHG') || c.includes('MOMENTUM') || c.includes('TREND') || c.includes('EXPANSION'))) {
        cls = val >= 0 ? 'td-positive' : 'td-negative';
      }
      else if (c === 'SCTR' || c === 'SCORE' || c === 'SWING_SCORE') cls = 'td-gold';
      return `<td class="${cls}">${display}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return `<table class="data-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function sortTable(th) {
  const table = th.closest('table');
  const idx   = [...th.parentElement.children].indexOf(th);
  const tbody = table.tBodies[0];
  const rows  = [...tbody.rows];
  const asc   = th.dataset.sort !== 'asc';
  th.dataset.sort = asc ? 'asc' : 'desc';

  rows.sort((a, b) => {
    const av = a.cells[idx].textContent.replace(/[$,%+]/g,'');
    const bv = b.cells[idx].textContent.replace(/[$,%+]/g,'');
    const an = parseFloat(av), bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;
    return asc ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  rows.forEach(r => tbody.appendChild(r));
}

// ── Badge Helpers ──────────────────────────────────────────
function rsiBadge(rsi) {
  if (rsi == null) return '';
  if (rsi > 80)  return '<span class="badge badge-red">Overbought</span>';
  if (rsi >= 50) return '<span class="badge badge-green">Healthy RSI</span>';
  return '<span class="badge badge-gold">Weak RSI</span>';
}

function earnBadge(days) {
  if (days == null) return '';
  if (days <= 7)  return '<span class="badge badge-red">⚠ Earnings Soon</span>';
  if (days <= 14) return '<span class="badge badge-gold">Earnings 2w</span>';
  return '<span class="badge badge-green">Earnings Safe</span>';
}

// ── Color Helpers ──────────────────────────────────────────
function scoreColor(score, min = 40, max = 85) {
  const t = Math.max(0, Math.min(1, (score - min) / (max - min)));
  if (t < 0.5) {
    const g = Math.round(t * 2 * 215);
    return `rgb(255,${g},0)`;
  }
  const r = Math.round((1 - (t - 0.5) * 2) * 255);
  return `rgb(${r},215,0)`;
}

function rsiColor(rsi) {
  if (rsi == null) return 'var(--text-secondary)';
  if (rsi > 80)  return 'var(--red)';
  if (rsi >= 50) return 'var(--green)';
  return 'var(--gold)';
}

function earnColor(days) {
  if (days == null) return 'var(--text-secondary)';
  if (days <= 7)  return 'var(--red)';
  if (days <= 14) return 'var(--gold)';
  return 'var(--green)';
}

// ── Plotly Config ──────────────────────────────────────────
function plotlyBase() {
  return {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'rgba(6,13,30,0.6)',
    font: { color: '#8ab4cf', family: 'Inter, sans-serif', size: 12 },
    xaxis: { gridcolor: 'rgba(26,58,92,0.4)', linecolor: '#1a3a5c', tickcolor: '#3d6a8a', zerolinecolor: 'rgba(26,58,92,0.4)' },
    yaxis: { gridcolor: 'rgba(26,58,92,0.4)', linecolor: '#1a3a5c', tickcolor: '#3d6a8a', zerolinecolor: 'rgba(26,58,92,0.4)' },
  };
}

function plotlyConfig() {
  return { displayModeBar: false, responsive: true };
}

// ── Formatters ─────────────────────────────────────────────
function fmtNum(v, dp = 2) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(dp);
}
function fmtDollar(v) {
  if (v == null || isNaN(v)) return '—';
  return `$${Number(v).toFixed(2)}`;
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%';
}
function fmtDateDisplay(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m,10)-1]} ${parseInt(day,10)}, ${y}`;
}
function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
function esc(s)    { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Date Utilities ─────────────────────────────────────────
function offsetDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
}

function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().substring(0, 10);
}

// ── UI Helpers ─────────────────────────────────────────────
function setLoadingText(msg) {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = msg;
}

function showOverlayError(msg) {
  const el = document.getElementById('loading-text');
  if (el) {
    el.textContent = `Error: ${msg}`;
    el.style.color = 'var(--red)';
  }
}

function showInfoMsg(id, msg, type = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.className = `info-msg${type === 'warn' ? ' warn-msg' : type === 'error' ? ' error-msg' : ''}`;
  el.textContent = msg;
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed', sidebarCollapsed);
}

function toggleGuide() {
  const el  = document.getElementById('guide-content');
  const arr = document.getElementById('guide-arrow');
  const open = el.style.display === 'block';
  el.style.display  = open ? 'none' : 'block';
  arr.textContent   = open ? '▼' : '▲';
}

function toggleExpander(id, btn) {
  const el   = document.getElementById(id);
  const open = el.style.display === 'block';
  el.style.display = open ? 'none' : 'block';
  btn.textContent  = btn.textContent.replace(open ? '▲' : '▼', open ? '▼' : '▲');
}
