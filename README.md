# SCTR Daily Scanner

Automated stock scanner that filters S&P 500 stocks by SCTR ≥ 90 and strict technical criteria. Runs every weekday via GitHub Actions, stores results in Supabase, and serves a live Streamlit dashboard.

## What it does

Every weekday at 10:00 AM Israel time the scraper:
1. Scrapes the SCTR table from StockCharts using Playwright
2. Filters stocks where SCTR ≥ 90 and volume > 1M
3. Fetches 1-year OHLCV data via yfinance and computes RSI, ATR, VWAP, AVWAP, moving averages
4. Keeps only stocks passing all validity checks: price above MA10/20/50/150, at 52-week high, no earnings within 7 days
5. Uploads results to Supabase
6. Sends a Telegram notification with the stock count and top 5 picks

## Stack

| Layer | Tool |
|---|---|
| Automation | GitHub Actions (cron) |
| Scraping | Playwright + yfinance |
| Database | Supabase (PostgreSQL) |
| Dashboard | Streamlit Community Cloud |
| Alerts | Telegram Bot |

## Project structure

```
├── .github/workflows/daily_scan.yml   # Cron scheduler (Tue–Sat, 07:00 UTC)
├── scraper/scrape_sctr.py             # Main scraper
├── dashboard/
│   ├── app.py                         # Streamlit dashboard
│   └── doc/dashboard_spec.md
├── requirements.txt
└── .gitignore
```

## Dashboard features

- **Top Picks** — composite score ranked by consistency, SCTR, momentum, volume trend, RSI, earnings safety
- **Short-Term Swing** — today's stocks ranked by swing score with ATR-based entry, stop, and take-profit levels
- **Sector Analysis** — sector rotation charts over time
- **Stock Deep Dive** — per-symbol SCTR, price vs MAs, volume, and RSI history
- **Daily History** — browse any past scan date
- **Full Rankings** — export scored rankings to CSV

## Setup

### 1. Supabase

Create a project at [supabase.com](https://supabase.com) and run the schema in `dashboard/doc/dashboard_spec.md` (or use the SQL in the setup guide).

### 2. GitHub Secrets

In your repo go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | Your Supabase anon key |
| `TELEGRAM_TOKEN` | Your Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |

### 3. Streamlit Community Cloud

Deploy `dashboard/app.py` at [share.streamlit.io](https://share.streamlit.io) and add the Supabase secrets under **Advanced settings**:

```toml
SUPABASE_URL = "https://xxxx.supabase.co"
SUPABASE_KEY = "your-anon-key"
```

### 4. Manual trigger

You can trigger the scraper manually anytime from **Actions → Daily SCTR Scan → Run workflow**.
