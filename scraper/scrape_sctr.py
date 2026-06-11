from playwright.sync_api import sync_playwright
import yfinance as yf
import os
import json
from datetime import datetime, timedelta
import re
import pandas as pd

# Ensure cache file is created in the same directory as this script
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yfinance_cache.json")

def load_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_cache(cache):
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2)

def compute_metrics(ohlc):
    """Compute LAST, LAST1D, LAST2D, MAs, 52WH, RSI, ATR, VWAP, AVWAP, VLAST1D, VLAST2D."""
    last = last1d = last2d = ma10 = ma20 = ma50 = ma150 = rsi = atr = vwap = avwap = "N/A"
    vlast1d = vlast2d = "N/A"
    is_52wh = False

    try:
        closes = ohlc["Close"]
        volumes = ohlc["Volume"] if "Volume" in ohlc.columns else None

        def safe_mean(series, n):
            if len(series) >= n:
                val = series.tail(n).mean()
                if hasattr(val, "item"):
                    val = val.item()
                return round(float(val), 2)
            return "N/A"

        if len(closes) >= 1:
            last = round(closes.iloc[-1].item(), 2)
        if len(closes) >= 2:
            last1d = round(closes.iloc[-2].item(), 2)
            if volumes is not None and len(volumes) >= 2:
                vlast1d = f"{int(volumes.iloc[-2].item()):,}"
        if len(closes) >= 3:
            last2d = round(closes.iloc[-3].item(), 2)
            if volumes is not None and len(volumes) >= 3:
                vlast2d = f"{int(volumes.iloc[-3].item()):,}"

        ma10 = safe_mean(closes, 10)
        ma20 = safe_mean(closes, 20)
        ma50 = safe_mean(closes, 50)
        ma150 = safe_mean(closes, 150)

        if last != "N/A":
            max_52w = closes.max().item()
            is_52wh = last >= round(max_52w, 2)

        # RSI (14-day)
        if len(closes) >= 15:
            delta = closes.diff()
            gain = delta.where(delta > 0, 0.0)
            loss = -delta.where(delta < 0, 0.0)
            avg_gain = gain.rolling(14).mean().iloc[-1]
            avg_loss = loss.rolling(14).mean().iloc[-1]
            if avg_loss == 0:
                rsi = 100.0
            else:
                rs = avg_gain / avg_loss
                rsi = round(100 - (100 / (1 + rs)), 2)

        # ATR (14-day)
        if len(ohlc) >= 15:
            high = ohlc["High"]
            low = ohlc["Low"]
            prev_close = closes.shift(1)

            tr = pd.concat([
                (high - low),
                (high - prev_close).abs(),
                (low - prev_close).abs()
            ], axis=1).max(axis=1)

            atr = round(tr.rolling(14).mean().iloc[-1], 2)

        # VWAP (latest day)
        if len(ohlc) > 0:
            latest = ohlc.iloc[-1]
            typical_price = (latest["High"] + latest["Low"] + latest["Close"]) / 3
            vwap = round(typical_price, 2)

        # AVWAP (anchored VWAP across dataset)
        if "Volume" in ohlc.columns and len(ohlc) > 0:
            typical_price = (ohlc["High"] + ohlc["Low"] + ohlc["Close"]) / 3
            avwap_val = (typical_price * ohlc["Volume"]).sum() / ohlc["Volume"].sum()
            avwap = round(avwap_val, 2)

    except Exception as e:
        print(f"⚠️ Metric computation failed: {e}")

    return last, last1d, last2d, ma10, ma20, ma50, ma150, is_52wh, rsi, atr, vwap, avwap, vlast1d, vlast2d

def get_earnings(symbol):
    """Fetch next earnings date and days until earnings."""
    earn_date, earn_days = "N/A", "N/A"
    try:
        ticker = yf.Ticker(symbol)

        # Preferred: earnings_dates
        ed = getattr(ticker, "earnings_dates", None)
        if ed is not None and not ed.empty:
            idx = ed.index.tz_convert(None)
            future_dates = ed[idx >= pd.Timestamp(datetime.today())]
            if not future_dates.empty:
                earn_dt = future_dates.index[0].to_pydatetime()
                earn_date = earn_dt.strftime("%Y-%m-%d")
                earn_days = (earn_dt.date() - datetime.today().date()).days

        # Fallback: calendar
        if earn_date == "N/A":
            cal = ticker.calendar
            earn_val = None
            if hasattr(cal, "index") and "Earnings Date" in cal.index:
                vals = cal.loc["Earnings Date"].values
                if len(vals) > 0:
                    earn_val = vals[0]
            elif isinstance(cal, dict) and "Earnings Date" in cal:
                earn_val = cal["Earnings Date"]
                if isinstance(earn_val, (list, tuple, pd.Series)):
                    if len(earn_val) > 0:
                        earn_val = earn_val[0]
                    else:
                        earn_val = None

            if earn_val is not None:
                if hasattr(earn_val, "item"):
                    earn_val = earn_val.item()
                try:
                    earn_dt = pd.to_datetime(earn_val).to_pydatetime()
                    earn_date = earn_dt.strftime("%Y-%m-%d")
                    earn_days = (earn_dt.date() - datetime.today().date()).days
                except Exception as e:
                    print(f"⚠️ Could not parse earnings date for {symbol}: {e}")
    except Exception as e:
        print(f"⚠️ Could not fetch earnings for {symbol}: {e}")

    return earn_date, earn_days

def _send_telegram(token, chat_id, text):
    try:
        import urllib.request, urllib.parse
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        data = urllib.parse.urlencode({"chat_id": chat_id, "text": text, "parse_mode": "HTML"}).encode()
        urllib.request.urlopen(url, data, timeout=10)
    except Exception as e:
        print(f"⚠️ Telegram error: {e}")


def run_pullback_telegram(token, chat_id, supabase_url, supabase_key, anthropic_api_key):
    """Fetch recent SCTR stocks, detect pullbacks, analyze with Claude, send to Telegram."""
    try:
        import anthropic
        from supabase import create_client

        db = create_client(supabase_url, supabase_key)

        # Query last 10 calendar days (covers ~7 trading days)
        since = (datetime.today() - timedelta(days=10)).strftime("%Y-%m-%d")
        result = db.table("sctr_daily").select(
            "symbol,sctr,rsi,earn_days,name,sector,run_date"
        ).gte("run_date", since).execute()

        if not result.data:
            print("No recent SCTR data for pullback analysis.")
            return

        # Keep latest row per symbol
        by_symbol = {}
        for row in result.data:
            sym = row["symbol"]
            if sym not in by_symbol or row["run_date"] > by_symbol[sym]["run_date"]:
                by_symbol[sym] = row

        symbols = list(by_symbol.keys())
        if not symbols:
            return

        print(f"📉 Running pullback analysis for {len(symbols)} symbols…")

        # Download recent price data
        hist = yf.download(
            symbols, period="10d", interval="1d",
            group_by="ticker", auto_adjust=False, progress=False
        )

        # Detect pullbacks
        pullbacks = []
        for sym in symbols:
            try:
                ohlc = hist[sym].dropna() if len(symbols) > 1 else hist.dropna()
                if len(ohlc) < 3:
                    continue

                week_high = float(ohlc["High"].max())
                week_low  = float(ohlc["Low"].min())
                current   = float(ohlc["Close"].iloc[-1])
                price_range = week_high - week_low

                if price_range <= 0 or week_high <= 0:
                    continue

                drop_pct     = round(price_range / week_high * 100, 1)
                recovery_pct = round((current - week_low) / price_range * 100, 1)
                from_high_pct = round((current - week_high) / week_high * 100, 1)

                if not (3 <= drop_pct <= 20 and recovery_pct <= 50):
                    continue

                row = by_symbol[sym]
                raw_earn = row.get("earn_days")
                try:
                    earn_days = int(raw_earn) if raw_earn not in (None, "N/A", "") else None
                except (ValueError, TypeError):
                    earn_days = None
                pullbacks.append({
                    "SYMBOL":       sym,
                    "NAME":         row.get("name", sym),
                    "SECTOR":       row.get("sector", ""),
                    "LATEST_SCTR":  row.get("sctr"),
                    "LATEST_RSI":   row.get("rsi"),
                    "DROP_PCT":     drop_pct,
                    "RECOVERY_PCT": recovery_pct,
                    "FROM_HIGH_PCT": from_high_pct,
                    "EARN_DAYS":    earn_days,
                    "EARNINGS_FLAG": earn_days is not None and earn_days <= 14,
                })
            except Exception as e:
                print(f"⚠️ Pullback calc error for {sym}: {e}")

        if not pullbacks:
            print("No pullback candidates (3-20% drop, recovery ≤ 50%).")
            return

        print(f"Found {len(pullbacks)} pullback candidates, calling Claude…")

        # Call Claude for analysis
        stripped = [{
            "symbol":        p["SYMBOL"],
            "sctr":          p["LATEST_SCTR"],
            "rsi":           p["LATEST_RSI"],
            "drop_pct":      p["DROP_PCT"],
            "recovery_pct":  p["RECOVERY_PCT"],
            "earn_days":     p["EARN_DAYS"],
            "earnings_flag": p["EARNINGS_FLAG"],
        } for p in pullbacks]

        prompt = (
            "You are a technical analyst reviewing weekly pullback setups.\n\n"
            "Metrics: drop_pct=weekly range%, recovery_pct=% of drop already recovered "
            "(0%=still at low), sctr=technical rank≥90, rsi=14d RSI (50-70 healthy), "
            "earnings_flag=true means earnings within 14 days.\n\n"
            "Verdicts: BUYABLE_DIP (sctr strong, rsi 45-75, recovery<50%, no earnings), "
            "ALREADY_BOUNCED (recovery>70%), RISKY (sctr weakening or rsi extreme), "
            "EARNINGS_RISK (earnings_flag true).\n\n"
            "Return ONLY a JSON array:\n"
            '[{"symbol":"X","verdict":"BUYABLE_DIP","reason":"1 sentence.","confidence":"HIGH"}]\n\n'
            f"Stocks:\n{json.dumps(stripped, indent=2)}"
        )

        client = anthropic.Anthropic(api_key=anthropic_api_key)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )

        text = (response.content[0].text or "").strip()
        match = re.search(r"\[[\s\S]*\]", text)
        if not match:
            print("⚠️ Claude did not return a JSON array.")
            return

        analyses = json.loads(match.group(0))

        # Build Telegram message
        EMOJI = {
            "BUYABLE_DIP":     "✅",
            "ALREADY_BOUNCED": "⏭",
            "RISKY":           "🚫",
            "EARNINGS_RISK":   "⚠️",
        }

        buyable = [a for a in analyses if a["verdict"] == "BUYABLE_DIP"]
        today_str = datetime.today().strftime("%Y-%m-%d")

        lines = [
            f"🤖 <b>AI Pullback Analysis</b>",
            f"📅 {today_str}  ·  {len(pullbacks)} candidates  ·  {len(buyable)} buyable dip{'s' if len(buyable) != 1 else ''}",
            "",
        ]

        pb_by_sym = {p["SYMBOL"]: p for p in pullbacks}

        for a in analyses:
            sym     = a["symbol"]
            verdict = a["verdict"]
            emoji   = EMOJI.get(verdict, "❓")
            conf    = a.get("confidence", "")
            reason  = a.get("reason", "")
            pb      = pb_by_sym.get(sym, {})
            sctr    = pb.get("LATEST_SCTR")
            drop    = pb.get("DROP_PCT")
            rec     = pb.get("RECOVERY_PCT")

            meta_parts = []
            if sctr is not None: meta_parts.append(f"SCTR {sctr:.0f}")
            if drop  is not None: meta_parts.append(f"Drop {drop:.1f}%")
            if rec   is not None: meta_parts.append(f"Rec {rec:.0f}%")
            meta = " · ".join(meta_parts)

            if verdict == "BUYABLE_DIP":
                lines.append(f"{emoji} <b>{sym}</b>  <i>({meta})</i>")
                lines.append(f"{reason}")
                lines.append("")
            else:
                verdict_label = verdict.replace("_", " ").title()
                lines.append(f"{emoji} <b>{sym}</b> — {verdict_label}  <i>({meta})</i>")

        message = "\n".join(lines)
        if len(message) > 4000:
            message = message[:4000] + "\n…"

        _send_telegram(token, chat_id, message)
        print(f"✅ Sent AI pullback analysis to Telegram ({len(buyable)} buyable dips)")

    except Exception as e:
        print(f"⚠️ Pullback Telegram analysis failed: {e}")


def scrape_sctr_table(exclude_earnings_days=7):
    cache = load_cache()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            page.goto("https://stockcharts.com/freecharts/sctr.html",
                      wait_until="networkidle", timeout=120000)
            page.wait_for_selector("table tbody tr", timeout=60000)
            print("✅ Page loaded, extracting table...")
        except Exception:
            print("⚠️ First attempt failed, retrying...")
            page.reload(wait_until="networkidle", timeout=120000)
            page.wait_for_selector("table tbody tr", timeout=60000)

        data = page.evaluate("""
            () => {
                const table = document.querySelector("table");
                const rows = Array.from(table.querySelectorAll("tr"));
                return rows.map(r => {
                    const cells = Array.from(r.querySelectorAll("th, td"));
                    return cells.map(c => c.innerText.trim());
                });
            }
        """)

        page.close()
        context.close()
        browser.close()

        headers = data[0][1:]
        rows = [row[1:] for row in data[1:]]

        sym_index = headers.index("SYMBOL")
        name_index = headers.index("NAME")
        sector_index = headers.index("SECTOR")
        industry_index = headers.index("INDUSTRY")
        sctr_index = headers.index("SCTR")
        vol_index = headers.index("VOLUME")
        mcap_index = headers.index("MARKET CAP")
        chg_index = headers.index("CHG")

        filtered_rows = []
        for row in rows:
            try:
                sctr_value = float(row[sctr_index]) if row[sctr_index] else 0
                vol_value = int(row[vol_index].replace(",", "")) if row[vol_index] else 0
                if sctr_value >= 90 and vol_value > 1_000_000:
                    filtered_rows.append(row)
            except ValueError:
                continue

        def parse_volume(v):
            try:
                return int(v.replace(",", ""))
            except:
                return 0

        filtered_rows.sort(key=lambda r: parse_volume(r[vol_index]), reverse=True)
        symbols = [row[sym_index] for row in filtered_rows]

        print(f"⬇️ Downloading bulk price data for {len(symbols)} symbols...")
        hist = yf.download(symbols, period="1y", interval="1d",
                           group_by="ticker", auto_adjust=False, progress=False)

        headers_out = [
            "RANK","SYMBOL","SCTR","SCTR CHG",
            "NAME","SECTOR","INDUSTRY",
            "MARKET CAP","VOLUME","VLAST1D","VLAST2D","RSI","ATR","VWAP","AVWAP",
            "LAST","CHG","CHG%",
            "LAST1D","LAST2D",
            "MA10","MA20","MA50","MA150",
            "EARN_DATE","EARN_DAYS"
        ]

        ranked_rows = []
        rank = 1
        for row in filtered_rows:
            symbol = row[sym_index]

            try:
                if len(symbols) > 1:
                    ohlc = hist[symbol].dropna()
                else:
                    ohlc = hist.dropna()
            except Exception:
                ohlc = pd.DataFrame()

            last, last1d, last2d, ma10, ma20, ma50, ma150, is_52wh, rsi, atr, vwap, avwap, vlast1d, vlast2d = compute_metrics(ohlc)
            earn_date, earn_days = get_earnings(symbol)

            chg = "N/A"
            chg_pct = "N/A"
            if last != "N/A" and last1d != "N/A" and last1d != 0:
                chg = round(last - last1d, 2)
                chg_pct = round((last - last1d) / last1d * 100, 2)

            is_valid = (
                last != "N/A"
                and last1d != "N/A"
                and last2d != "N/A"
                and ma10 != "N/A"
                and ma20 != "N/A"
                and ma50 != "N/A"
                and ma150 != "N/A"
                and ma10 >= ma20
                and last >= ma10
                and last >= ma20
                and last >= ma50
                and last >= ma150
                and last >= last1d
                and last >= last2d
                and is_52wh
            )

            if is_valid:
                if earn_days == "N/A" or int(earn_days) > exclude_earnings_days:
                    ranked_rows.append([
                        rank,
                        symbol,
                        row[sctr_index], row[chg_index],
                        row[name_index], row[sector_index], row[industry_index],
                        row[mcap_index], row[vol_index], vlast1d, vlast2d, rsi, atr, vwap, avwap,
                        last, chg, chg_pct,
                        last1d, last2d,
                        ma10, ma20, ma50, ma150,
                        earn_date, earn_days
                    ])
                    rank += 1

        df_stocks = pd.DataFrame(ranked_rows, columns=headers_out)

        today = datetime.today()
        today_str = today.strftime("%Y-%m-%d")

        save_cache(cache)

        # Upload to Supabase
        supabase_url = os.environ.get("SUPABASE_URL", "")
        supabase_key = os.environ.get("SUPABASE_KEY", "")
        if supabase_url and supabase_key:
            from supabase import create_client
            db = create_client(supabase_url, supabase_key)
            records = df_stocks.copy()
            records.columns = (
                records.columns
                       .str.strip()
                       .str.lower()
                       .str.replace(" ", "_", regex=False)
                       .str.replace("%", "_pct", regex=False)
            )
            records["run_date"] = today_str
            records = records.where(pd.notnull(records), None)
            db.table("sctr_daily").upsert(records.to_dict(orient="records")).execute()
            print(f"✅ Uploaded {len(records)} rows to Supabase for {today_str}")
        else:
            print("⚠️ SUPABASE_URL/KEY not set — skipping Supabase upload")

        # Send Telegram notification
        token = os.environ.get("TELEGRAM_TOKEN", "")
        chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
        if token and chat_id:
            count = len(df_stocks)
            top5 = " ".join(df_stocks["SYMBOL"].head(5).tolist())
            _send_telegram(token, chat_id,
                f"✅ <b>SCTR Scraper Done</b>\n"
                f"📅 {today_str}\n"
                f"📊 <b>{count} stocks</b> passed all filters\n"
                f"🏆 Top 5: <code>{top5}</code>"
            )

            anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
            if anthropic_key and supabase_url and supabase_key:
                run_pullback_telegram(token, chat_id, supabase_url, supabase_key, anthropic_key)

if __name__ == "__main__":
    try:
        scrape_sctr_table()
    except KeyboardInterrupt:
        print("\n⚠️ Script interrupted by user. Closing gracefully.")
    except Exception as e:
        print(f"❌ Script failed: {e}")
        token = os.environ.get("TELEGRAM_TOKEN", "")
        chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
        if token and chat_id:
            _send_telegram(token, chat_id,
                f"❌ <b>SCTR Scraper FAILED</b>\n"
                f"📅 {datetime.today().strftime('%Y-%m-%d')}\n"
                f"Error: {e}"
            )
        raise
