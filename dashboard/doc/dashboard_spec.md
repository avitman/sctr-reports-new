# SCTR Investment Dashboard — Specification

**File:** `SCTR/dashboard.py`
**Run command:** `streamlit run dashboard.py`
**URL:** http://localhost:8501

---

## What is SCTR?

**StockCharts Technical Rank (SCTR)** is a score from **0 to 99.99** that ranks a stock's technical strength relative to other stocks in the same market-cap group. A score of 50 means average performance; scores above 60 indicate above-average technical strength; scores in the 90s place the stock in the top tier of its peer group.

The score combines **six technical indicators across three timeframes**:

| Timeframe | Weight | Indicators |
|---|---|---|
| Long-term | 60% | % above/below 200-day EMA · 125-day Rate of Change |
| Medium-term | 30% | % above/below 50-day EMA · 20-day Rate of Change |
| Short-term | 10% | 14-day RSI · 3-day slope of PPO histogram |

Because SCTR is a *relative* rank, a stock's score can rise or fall based on what other stocks in its group are doing — even if its own price barely moves.

📊 **Live SCTR Report:** [stockcharts.com/freecharts/sctr.html](https://stockcharts.com/freecharts/sctr.html)
📖 **Full methodology:** [StockCharts ChartSchool — SCTR](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/stockcharts-technical-rank)

---

## Business Specification: SCTR Daily Scanner Report

### 1. Background

The **StockCharts Technical Rank (SCTR)** ranks stocks based on multiple technical indicators.
This report automatically extracts the **SCTR table** from StockCharts, applies liquidity and performance filters, and enriches the dataset with additional technical metrics such as moving averages, RSI, ATR, VWAP, and AVWAP.

### 2. Purpose

The purpose of the report is to generate a **pre-filtered list of technically strong and liquid stocks** that meet strict trend-validation rules.

The report is intended for:
- **Traders** looking for breakout opportunities.
- **Portfolio managers** screening for technically sound, liquid names.
- **Analysts** requiring a structured dataset for further research or algorithmic trading.

### 3. Data Source

- **Primary Source:** StockCharts SCTR Table (web scraping via Playwright).
- **Enrichment Source:** Yahoo Finance (daily OHLCV data for moving averages, ATR, RSI, VWAP/AVWAP, and earnings dates).

### 4. Business Logic

#### 4.1 Initial Filters (applied from StockCharts table)

- SCTR Score ≥ 90 → only technically strong stocks.
- VOLUME > 1,000,000 shares → ensures liquidity.

#### 4.2 Enrichment (via Yahoo Finance OHLCV data)

For each stock symbol:
- `LAST` = Most recent closing price.
- `LAST1D` = Closing price 1 trading day ago.
- `LAST2D` = Closing price 2 trading days ago.
- `MA10` = 10-day simple moving average (Close).
- `MA20` = 20-day simple moving average (Close).
- `MA50` = 50-day simple moving average (Close).
- `MA150` = 150-day simple moving average (Close).
- `RSI` = 14-day Relative Strength Index. Measures momentum on a 0–100 scale. Values above 70 indicate overbought conditions; below 30 indicate oversold. Sweet spot for trend-following entries is 50–70.
- `ATR` = 14-day Average True Range. Measures average daily price volatility in dollar terms. Used to size positions and set stop-loss distances — higher ATR means wider expected swings.
- `VWAP` = Volume-Weighted Average Price for the latest trading day. Represents the average price weighted by volume. Stocks trading above VWAP are considered bullish intraday; it is commonly used as a benchmark by institutional traders.
- `AVWAP` = Anchored VWAP calculated from the beginning of the 1-year data history. Unlike daily VWAP, it accumulates over time and shows whether the stock is trading above or below the long-term average cost of all shares traded. Price above AVWAP signals that the majority of market participants are in profit.
- `EARN_DATE` = Next scheduled earnings report date (if available).
- `EARN_DAYS` = Days remaining until earnings date.

#### 4.3 Validation Rule (IS_VALID)

A stock is considered valid only if **all** conditions are satisfied:

1. MA10 ≥ MA20 (short-term stronger than medium-term).
2. LAST ≥ MA10, MA20, MA50, MA150.
3. LAST ≥ LAST1D and LAST ≥ LAST2D (confirming upward momentum – 1X2).
4. LAST is a new 52-week high.
5. Earnings date not within the next 7 days (excludes near-report volatility).

Only rows that satisfy all criteria are kept in the final output.

### 5. Report Output

#### 5.1 Format

- **Output file:** CSV format.
- **File name:** `sctr_daily_scanner_YYYY-MM-DD.csv` (date = report run date).

#### 5.2 Columns (in order)

| # | Column | Description |
|---|---|---|
| 1 | RANK | Sequential rank by descending VOLUME |
| 2 | SYMBOL | Stock ticker |
| 3 | SCTR | StockCharts Technical Rank |
| 4 | SCTR CHG | Daily % SCTR change |
| 5 | NAME | Company name |
| 6 | SECTOR | Sector classification |
| 7 | INDUSTRY | Industry classification |
| 8 | MARKET CAP | Market capitalization |
| 9 | VOLUME | Trading volume |
| 10 | RSI | 14-day Relative Strength Index |
| 11 | ATR | 14-day Average True Range |
| 12 | VWAP | Latest day VWAP |
| 13 | AVWAP | Anchored VWAP (1-year) |
| 14 | LAST | Most recent close price |
| 15 | CHG | Price change from previous close (absolute) |
| 16 | CHG% | Price change from previous close (percentage) |
| 17 | LAST1D | Close price 1 day ago |
| 18 | LAST2D | Close price 2 days ago |
| 19 | MA10 | 10-day SMA |
| 20 | MA20 | 20-day SMA |
| 21 | MA50 | 50-day SMA |
| 22 | MA150 | 150-day SMA |
| 23 | EARN_DATE | Next earnings date |
| 24 | EARN_DAYS | Days until earnings date |

---

## 1. Purpose

The dashboard aggregates all historical SCTR daily scanner CSVs and produces ranked investment recommendations. It answers three questions:

1. Which stocks have shown *persistent* strength over time?
2. Which sectors are currently rotating in?
3. Which individual stocks are the best buy candidates today?

---

## 2. Data Source

### Input files
- Pattern: `SCTR/YYYY-MM/sctr_daily_scanner_YYYY-MM-DD.csv`
- Only files matching the exact regex `sctr_daily_scanner_(\d{4}-\d{2}-\d{2})\.csv$` are loaded (ignores ATR files, `-A` suffix variants, etc.)
- Cache TTL: 5 minutes (Streamlit `@st.cache_data`)

### CSV formats supported

Two formats exist across the date range:

| Field | Old format (≤ 2025-12) | New format (≥ 2026-01) |
|---|---|---|
| SCTR change column | `CHG` | `SCTR CHG` |
| RSI | absent | present |
| ATR | absent | present |
| VWAP / AVWAP | absent | present |
| Volume prev days | absent | `VLAST1D`, `VLAST2D` |
| `CHG%` | absent | present |

The loader normalizes both formats into a unified schema. The `CHG` column in the old format is mapped to `SCTR_CHG`.

### Full unified schema

| Column | Type | Description |
|---|---|---|
| DATE | datetime | Parsed from filename |
| SYMBOL | string | Ticker, uppercased |
| NAME | string | Company name |
| SECTOR | string | e.g. Technology, Healthcare |
| INDUSTRY | string | Sub-sector |
| RANK | float | Daily rank within scanner |
| SCTR | float | StockCharts Technical Rank (90–99.9) |
| SCTR_CHG | float | Day-over-day SCTR change |
| LAST | float | Closing price |
| LAST1D | float | Prior day close |
| LAST2D | float | Two days prior close |
| MA10 | float | 10-day moving average |
| MA20 | float | 20-day moving average |
| MA50 | float | 50-day moving average |
| MA150 | float | 150-day moving average |
| RSI | float | 14-day RSI (new format only) |
| ATR | float | 14-day ATR (new format only) |
| VWAP | float | Daily VWAP (new format only) |
| AVWAP | float | Anchored VWAP (new format only) |
| VOLUME | float | Current day volume |
| VLAST1D | float | Prior day volume (new format only) |
| VLAST2D | float | Two days prior volume (new format only) |
| CHG% | float | Daily price change % (new format only) |
| MARKET CAP | string | e.g. "1.234 T" |
| EARN_DATE | string | Next earnings date |
| EARN_DAYS | float | Days until next earnings |

### Pre-filtering (done by `scrape_sctr.py`, not the dashboard)
The CSVs already contain only stocks that passed all of these gates:
- SCTR ≥ 90
- Volume > 1,000,000
- `LAST ≥ MA10 ≥ MA20`, `LAST ≥ MA50`, `LAST ≥ MA150`
- `LAST ≥ LAST1D ≥ LAST2D` (3-day price trend up)
- At or near 52-week high
- Earnings > 7 days away

The dashboard does **not** re-apply these filters; it treats all rows in CSVs as valid.

---

## 3. Composite Scoring Engine

### Function: `compute_scores(df)`

Runs once per filtered dataset (cached). Produces one row per symbol with a `SCORE` in the range 0–100.

#### Intermediate metrics

| Metric | Derivation |
|---|---|
| `TOTAL_APPEARANCES` | Count of days the symbol appeared across all CSVs |
| `CONSISTENCY_PCT` | `TOTAL_APPEARANCES / total_trading_days * 100` |
| `IN_LATEST` | Boolean — did the stock appear on the most recent date? |
| `AVG_SCTR` | Mean SCTR across all dates |
| `LATEST_SCTR` | SCTR on the most recent date the stock appeared |
| `SCTR_MOMENTUM` | Avg SCTR in last 21 days minus avg SCTR before that |
| `LATEST_RSI` | RSI on the most recent date |
| `AVG_VOLUME` | Mean volume across all dates |
| `VOLUME_TREND` | `(recent_avg_vol - older_avg_vol) / older_avg_vol * 100` — recent = last 21 days |
| `EARN_DAYS` | Days to earnings from the most recent CSV row |

#### Score components

Each component is normalized 0–100 using min-max scaling across the current filtered population, except RSI and earnings which use fixed formulas.

| Component | Formula | Weight |
|---|---|---|
| Consistency | min-max of `CONSISTENCY_PCT` | **25%** |
| SCTR level | min-max of `LATEST_SCTR` | **20%** |
| SCTR momentum | min-max of `SCTR_MOMENTUM` (fillna 0) | **20%** |
| Volume trend | min-max of `VOLUME_TREND` (fillna 0) | **15%** |
| RSI health | `(100 - abs(RSI - 62) * 2).clip(0, 100)` — peaks at RSI=62, penalizes overbought/weak | **10%** |
| Earnings safety | `(EARN_DAYS.clip(0,30) / 30 * 100)` — full score at ≥30 days, zero at 0 days | **5%** |
| In today's list | Boolean × 20 | **5%** |

**SCORE** = weighted sum, rounded to 1 decimal.

#### Score interpretation

| Range | Interpretation |
|---|---|
| 70–100 | Strong conviction — consistent, trending, healthy technicals |
| 50–70 | Watch list — strong but some risk factors present |
| < 50 | Weak — inconsistent, overbought, or near earnings |

---

## 4. Sidebar Filters

All filters are applied to the scored table before rendering any tab.

| Filter | Default | Description |
|---|---|---|
| Min Consistency % | 20 | Exclude stocks appearing on fewer than N% of all trading days |
| Min Latest SCTR | 90 | Exclude stocks below this SCTR threshold |
| Sectors | All | Multi-select; restrict to chosen sectors |
| Only stocks in today's list | Off | Toggle to show only stocks present in the latest CSV |
| Exclude if earnings within N days | 10 | Removes stocks with imminent earnings |

---

## 5. Views (Tabs)

### Tab 1 — Top Picks
- Horizontal bar chart: symbols ranked by SCORE, colored green→red (RdYlGn scale, anchored 40–85)
- Card view per stock showing:
  - Symbol, name, sector, industry
  - Score, SCTR, Consistency %, SCTR Momentum
  - RSI badge (Healthy / Overbought / Weak)
  - Earnings badge (Safe / 2w / ⚠️ Earnings Soon)
  - Volume trend %, last price, ATR, total appearances
- Slider to control how many stocks to show (5–50, default 15)

#### RSI badge thresholds
| Condition | Badge | Color |
|---|---|---|
| RSI > 80 | Overbought | Red `#e74c3c` |
| RSI 50–80 | Healthy RSI | Green `#27ae60` |
| RSI < 50 | Weak RSI | Orange `#f39c12` |

#### Earnings badge thresholds
| Condition | Badge | Color |
|---|---|---|
| ≤ 7 days | ⚠️ Earnings Soon | Red `#e74c3c` |
| 8–14 days | Earnings 2w | Orange `#f39c12` |
| > 14 days | Earnings Safe | Green `#27ae60` |

---

### Tab 2 — Sector Analysis
1. **Stacked area chart** — unique stocks per sector per week, last 90 days
2. **Bar chart** — average SCTR by sector (all time), colored by SCTR value
3. **Pie chart** — total scanner appearances by sector
4. **Momentum bar chart** — unique stocks in last 30 days minus unique stocks prior (sector rotation signal)

---

### Tab 3 — Stock Deep Dive
- Symbol dropdown (all 247 symbols ever seen)
- KPI row: latest SCTR, days on list, consistency %, RSI, days to earnings
- Charts (Plotly):
  1. SCTR over time (line + markers, with 90-threshold reference line)
  2. Price vs MA10 / MA20 / MA50 / MA150 (multi-line)
  3. Volume history (bar chart)
  4. RSI history (filled area, with 50 and 70 reference lines)
- Raw data expander (full history for the stock, newest first)

---

### Tab 4 — Daily History
- Date picker (dropdown of all available dates, newest first)
- Sector pie for selected day
- Sortable table: RANK, SYMBOL, NAME, SECTOR, SCTR, RSI, LAST, ATR, VOLUME, EARN_DAYS

---

### Tab 5 — Full Rankings
- Full filtered+scored table with Streamlit column configs:
  - SCORE as a progress bar
  - Consistency % formatted as percentage
  - SCTR momentum and volume trend as signed numbers
  - IN_LATEST as checkbox
- Download button → exports filtered table as `sctr_rankings.csv`

---

## 6. KPI Header (always visible)

| Metric | Source |
|---|---|
| Trading Days Analyzed | Distinct dates in combined dataset |
| Unique Stocks Ever | Distinct symbols across all CSVs |
| Date Range | Min date → Max date |
| Today's List Size | Row count for the latest date |

---

## 7. Dependencies

```
streamlit
pandas
plotly
```

All already present in the project's `.venv`.

---

## 8. File Layout

```
SCTR/
├── dashboard.py          # This dashboard
├── scrape_sctr.py        # Data collector (Playwright + yfinance)
├── doc/
│   └── dashboard_spec.md # This document
├── 2025-10/
│   └── sctr_daily_scanner_YYYY-MM-DD.csv
├── 2025-11/
│   └── ...
├── 2026-04/
│   └── ...
```

---

## 9. Known Limitations & Future Work

| # | Item |
|---|---|
| 1 | RSI, ATR, VWAP columns absent from pre-2026 CSVs — these symbols will have `NaN` RSI in scoring |
| 2 | Scoring is relative (min-max) — scores shift as the filtered population changes |
| 3 | No real-time price data — all prices sourced from CSV snapshots |
| 4 | EARN_DAYS is from last appearance date; may be stale for infrequent stocks |
| 5 | No position sizing, risk/reward, or portfolio correlation analysis |
| 6 | Volume trend comparison uses 21-day window — short history stocks may have noisy results |
