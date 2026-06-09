# SCTR Daily Scanner

Automated stock scanner that filters stocks by SCTR ≥ 90 and strict technical criteria. Runs every weekday via GitHub Actions, stores results in Supabase, and serves a live dashboard on Vercel.

## What it does

Every weekday the scraper:
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
| Dashboard | Vercel (static site + serverless functions) |
| Alerts | Telegram Bot |

## Project structure

```
├── .github/workflows/daily_scan.yml   # Cron scheduler (Tue–Sat, 07:00 UTC)
├── scraper/scrape_sctr.py             # Main scraper
├── site/                              # Frontend static files
│   ├── index.html
│   ├── style.css
│   └── app.js
├── api/                               # Vercel serverless functions
│   ├── config.js                      # Serves Supabase credentials to browser
│   ├── pullbacks.js                   # Yahoo Finance weekly price proxy
│   └── stocktwits.js                  # StockTwits trending proxy
├── package.json                       # API dependencies (yahoo-finance2)
├── vercel.json                        # Vercel build config
└── .gitignore
```

## Dashboard tabs

| Tab | Purpose |
|---|---|
| 🏆 Top Picks | Composite-scored stocks ranked by SCTR, consistency, momentum, volume, RSI, earnings safety |
| ⚡ Short-Term Swing | Today's stocks ranked for 1–5 day trades with ATR-based entry, stop, and take-profit levels |
| 📉 Weekly Pullback | Strong SCTR stocks that dropped significantly this week — mean-reversion entries |
| 📣 Social Buzz | StockTwits trending symbols cross-referenced with the SCTR scanner |
| 📊 Sector Analysis | Sector rotation over time, avg SCTR by sector, momentum signals |
| 🔍 Stock Deep Dive | Per-stock SCTR history, price vs MAs, volume, RSI |
| 📅 Daily History | Browse the full scanner list for any past date |
| 📄 Spec | Technical documentation of the scoring model |

## Setup

### 1. Supabase

Create a project at [supabase.com](https://supabase.com) and run the schema in `dashboard/doc/dashboard_spec.md`.

### 2. GitHub Secrets (for the scraper)

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | Your Supabase anon key |
| `TELEGRAM_TOKEN` | Your Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |

### 3. Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new) → import the repo
3. Leave the framework preset as **Other** — Vercel auto-detects `vercel.json` (output: `site`, functions: `api/`)
4. Go to **Settings → Environment Variables** and add for Production, Preview, and Development:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | Your Supabase anon key |

5. Trigger a redeploy — your dashboard is live at `https://your-site.vercel.app`

### 4. Run locally

```bash
npm install
vercel dev
```

Open [http://localhost:3000](http://localhost:3000). The `vercel dev` command serves the static site and runs the API functions locally, matching production behavior exactly.

### 5. Manual scraper trigger

Trigger the scraper anytime from **Actions → Daily SCTR Scan → Run workflow**.
