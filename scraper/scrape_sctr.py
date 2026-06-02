from playwright.sync_api import sync_playwright
import yfinance as yf
import os
import json
from datetime import datetime
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


def scrape_sctr_table(exclude_earnings_days=7):
    cache = load_cache()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()

        try:
            page.goto("https://stockcharts.com/freecharts/sctr.html",
                      wait_until="domcontentloaded", timeout=90000)
            page.wait_for_selector("table tbody tr", timeout=90000)
            print("✅ Page loaded, extracting table...")
        except Exception:
            print("⚠️ First attempt failed, retrying...")
            page.reload()
            page.wait_for_selector("table tbody tr", timeout=90000)

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
                chg_value = float(row[chg_index].replace("%", "")) if row[chg_index] else 0
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
