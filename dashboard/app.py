"""
SCTR Investment Dashboard
Analyzes all historical SCTR CSV files and surfaces investment recommendations.
Run with: streamlit run dashboard.py
"""

import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import os
from datetime import datetime, timedelta
import warnings
import yfinance as yf
warnings.filterwarnings("ignore")

# ─── Config ───────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
st.set_page_config(
    page_title="SCTR Investment Dashboard",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# ─── Data Loading ─────────────────────────────────────────────────────────────
@st.cache_data(ttl=300)
def load_all_data():
    """Load all SCTR data from Supabase."""
    from supabase import create_client
    db = create_client(st.secrets["SUPABASE_URL"], st.secrets["SUPABASE_KEY"])

    all_rows = []
    chunk = 1000
    start = 0
    while True:
        result = db.table("sctr_daily").select("*").range(start, start + chunk - 1).execute()
        all_rows.extend(result.data)
        if len(result.data) < chunk:
            break
        start += chunk

    if not all_rows:
        return pd.DataFrame()

    df = pd.DataFrame(all_rows)
    df = df.drop(columns=["id"], errors="ignore")
    df = df.rename(columns={
        "run_date": "DATE", "rank": "RANK", "symbol": "SYMBOL",
        "sctr": "SCTR", "sctr_chg": "SCTR_CHG", "name": "NAME",
        "sector": "SECTOR", "industry": "INDUSTRY", "market_cap": "MARKET CAP",
        "volume": "VOLUME", "vlast1d": "VLAST1D", "vlast2d": "VLAST2D",
        "rsi": "RSI", "atr": "ATR", "vwap": "VWAP", "avwap": "AVWAP",
        "last": "LAST", "chg": "CHG", "chg_pct": "CHG%",
        "last1d": "LAST1D", "last2d": "LAST2D",
        "ma10": "MA10", "ma20": "MA20", "ma50": "MA50", "ma150": "MA150",
        "earn_date": "EARN_DATE", "earn_days": "EARN_DAYS",
    })

    df["DATE"] = pd.to_datetime(df["DATE"])

    # Volume columns stored as text with commas in Supabase
    for col in ["VOLUME", "VLAST1D", "VLAST2D"]:
        if col in df.columns:
            df[col] = pd.to_numeric(
                df[col].astype(str).str.replace(",", "", regex=False),
                errors="coerce"
            )

    if "EARN_DAYS" in df.columns:
        df["EARN_DAYS"] = pd.to_numeric(df["EARN_DAYS"], errors="coerce")

    df["SYMBOL"] = df["SYMBOL"].astype(str).str.strip().str.upper()
    df = df[df["SYMBOL"].str.len() > 0]
    df = df.sort_values("DATE")

    return df


@st.cache_data(ttl=300)
def compute_scores(df: pd.DataFrame) -> pd.DataFrame:
    """Compute per-symbol composite investment score."""
    if df.empty:
        return pd.DataFrame()

    total_days = df["DATE"].nunique()
    latest_date = df["DATE"].max()
    recent_cutoff = latest_date - timedelta(days=21)  # last ~3 weeks

    # Recent data only for some metrics
    recent = df[df["DATE"] >= recent_cutoff]

    # ── Per-symbol aggregation ──
    grp = df.groupby("SYMBOL")
    recent_grp = recent.groupby("SYMBOL")

    scores = pd.DataFrame()
    scores["SYMBOL"] = list(grp.groups.keys())
    scores = scores.set_index("SYMBOL")

    # Appearance count & consistency
    scores["TOTAL_APPEARANCES"] = grp["DATE"].count()
    scores["CONSISTENCY_PCT"] = (scores["TOTAL_APPEARANCES"] / total_days * 100).round(1)

    # Latest day presence
    latest_df = df[df["DATE"] == latest_date]
    scores["IN_LATEST"] = scores.index.isin(latest_df["SYMBOL"])

    # Average & latest SCTR
    scores["AVG_SCTR"] = grp["SCTR"].mean().round(1)
    scores["LATEST_SCTR"] = grp["SCTR"].last().round(1)

    # SCTR momentum: difference between recent avg and older avg
    recent_avg = recent_grp["SCTR"].mean() if not recent.empty else pd.Series(dtype=float)
    older = df[df["DATE"] < recent_cutoff]
    older_avg = older.groupby("SYMBOL")["SCTR"].mean() if not older.empty else pd.Series(dtype=float)
    scores["SCTR_MOMENTUM"] = (recent_avg - older_avg).round(2)

    # RSI (latest available)
    if "RSI" in df.columns:
        scores["LATEST_RSI"] = grp["RSI"].last().round(1)
    else:
        scores["LATEST_RSI"] = float("nan")

    # Volume trend: recent vol vs prior vol
    if "VOLUME" in df.columns:
        scores["AVG_VOLUME"] = grp["VOLUME"].mean().round(0)
        recent_vol = recent_grp["VOLUME"].mean() if not recent.empty else pd.Series(dtype=float)
        older_vol = older.groupby("SYMBOL")["VOLUME"].mean() if not older.empty else pd.Series(dtype=float)
        scores["VOLUME_TREND"] = ((recent_vol - older_vol) / older_vol.replace(0, float("nan")) * 100).round(1)
    else:
        scores["AVG_VOLUME"] = float("nan")
        scores["VOLUME_TREND"] = float("nan")

    # Earnings safety (days to earnings from latest row)
    if "EARN_DAYS" in df.columns:
        scores["EARN_DAYS"] = grp["EARN_DAYS"].last()
    else:
        scores["EARN_DAYS"] = float("nan")

    # Metadata from latest appearance
    meta_cols = ["NAME", "SECTOR", "INDUSTRY", "MARKET CAP", "LAST", "ATR"]
    for col in meta_cols:
        if col in df.columns:
            scores[col] = grp[col].last()

    scores = scores.reset_index()

    # ── Composite Score (0–100) ──
    def norm(series, low=0, high=100):
        mn, mx = series.min(), series.max()
        if mx == mn:
            return pd.Series(50.0, index=series.index)
        return ((series - mn) / (mx - mn) * (high - low) + low).clip(0, 100)

    # Components
    c_consistency = norm(scores["CONSISTENCY_PCT"])              # higher = better
    c_sctr        = norm(scores["LATEST_SCTR"])                  # higher = better
    c_momentum    = norm(scores["SCTR_MOMENTUM"].fillna(0))      # rising SCTR = better
    c_volume      = norm(scores["VOLUME_TREND"].fillna(0))       # volume increasing = better

    # RSI: sweet spot 50–72; penalize overbought (>80) and weak (<40)
    rsi = scores["LATEST_RSI"].fillna(60)
    c_rsi = (100 - ((rsi - 62).abs() * 2)).clip(0, 100)

    # Earnings safety: penalize if earnings < 14 days
    earn = scores["EARN_DAYS"].fillna(30)
    c_earn = (earn.clip(0, 30) / 30 * 100).clip(0, 100)

    # Latest day bonus
    c_latest = scores["IN_LATEST"].astype(float) * 20

    scores["SCORE"] = (
        c_consistency * 0.25 +
        c_sctr        * 0.20 +
        c_momentum    * 0.20 +
        c_volume      * 0.15 +
        c_rsi         * 0.10 +
        c_earn        * 0.05 +
        c_latest      * 0.05
    ).round(1)

    scores = scores.sort_values("SCORE", ascending=False).reset_index(drop=True)
    scores.index += 1  # 1-based rank
    return scores


@st.cache_data(ttl=3600)
def fetch_weekly_pullbacks(symbols: tuple) -> pd.DataFrame:
    """Fetch 1-week OHLC from Yahoo Finance and return per-symbol range stats."""
    if not symbols:
        return pd.DataFrame()

    end = datetime.today()
    start = end - timedelta(days=8)  # buffer for weekends/holidays

    try:
        raw = yf.download(list(symbols), start=start, end=end, progress=False,
                          auto_adjust=True, threads=True)
    except Exception:
        return pd.DataFrame()

    if raw.empty:
        return pd.DataFrame()

    # Normalize to MultiIndex regardless of single vs multi-ticker download
    if not isinstance(raw.columns, pd.MultiIndex):
        sym = symbols[0]
        raw.columns = pd.MultiIndex.from_tuples([(c, sym) for c in raw.columns])

    rows = []
    for sym in symbols:
        try:
            highs = raw["High"][sym].dropna()
            lows = raw["Low"][sym].dropna()
            closes = raw["Close"][sym].dropna()
            if highs.empty or lows.empty or closes.empty:
                continue
            week_high = float(highs.max())
            week_low = float(lows.min())
            current = float(closes.iloc[-1])
            if week_high == 0 or pd.isna(week_high):
                continue
            price_range = week_high - week_low
            drop_pct = price_range / week_high * 100
            recovery_pct = (current - week_low) / price_range * 100 if price_range > 0 else 50.0
            rows.append({
                "SYMBOL": sym,
                "WEEK_HIGH": round(week_high, 2),
                "WEEK_LOW": round(week_low, 2),
                "CURRENT": round(current, 2),
                "DROP_PCT": round(drop_pct, 1),
                "FROM_HIGH_PCT": round((current - week_high) / week_high * 100, 1),
                "RECOVERY_PCT": round(recovery_pct, 1),
            })
        except Exception:
            continue

    return pd.DataFrame(rows).sort_values("DROP_PCT", ascending=False).reset_index(drop=True)


@st.cache_data(ttl=1800)
def fetch_trending_stocktwits() -> pd.DataFrame:
    """Fetch currently trending symbols from StockTwits public API."""
    import requests
    try:
        resp = requests.get(
            "https://api.stocktwits.com/api/2/trending/symbols.json",
            timeout=10,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        resp.raise_for_status()
        rows = [
            {
                "SYMBOL": s["symbol"],
                "ST_NAME": s.get("title", ""),
                "WATCHLIST_COUNT": s.get("watchlist_count", 0),
            }
            for s in resp.json().get("symbols", [])
        ]
        return pd.DataFrame(rows) if rows else pd.DataFrame()
    except Exception:
        return pd.DataFrame()


# ─── Helpers ──────────────────────────────────────────────────────────────────
def badge(value, thresholds, labels, colors):
    """Return colored HTML badge."""
    for i, t in enumerate(thresholds):
        if value >= t:
            return f'<span style="background:{colors[i]};color:white;padding:2px 8px;border-radius:10px;font-size:0.85em">{labels[i]}</span>'
    return f'<span style="background:gray;color:white;padding:2px 8px;border-radius:10px;font-size:0.85em">Weak</span>'


def rsi_badge(rsi):
    if pd.isna(rsi):
        return ""
    if rsi > 80:
        return '<span style="background:#e74c3c;color:white;padding:2px 8px;border-radius:10px;font-size:0.8em">Overbought</span>'
    if rsi >= 50:
        return '<span style="background:#27ae60;color:white;padding:2px 8px;border-radius:10px;font-size:0.8em">Healthy RSI</span>'
    return '<span style="background:#f39c12;color:white;padding:2px 8px;border-radius:10px;font-size:0.8em">Weak RSI</span>'


def earn_badge(days):
    if pd.isna(days):
        return ""
    if days <= 7:
        return '<span style="background:#e74c3c;color:white;padding:2px 8px;border-radius:10px;font-size:0.8em">⚠️ Earnings Soon</span>'
    if days <= 14:
        return '<span style="background:#f39c12;color:white;padding:2px 8px;border-radius:10px;font-size:0.8em">Earnings 2w</span>'
    return '<span style="background:#27ae60;color:white;padding:2px 8px;border-radius:10px;font-size:0.8em">Earnings Safe</span>'


# ─── Main App ─────────────────────────────────────────────────────────────────
def main():
    st.title("📈 SCTR Investment Dashboard")
    st.caption("Analyzes all historical SCTR daily scanner data to surface high-conviction investment ideas.")

    with st.spinner("Loading all SCTR data..."):
        df = load_all_data()

    if df.empty:
        st.error("No data found. Check your Supabase connection and secrets.")
        return

    total_days = df["DATE"].nunique()
    latest_date = df["DATE"].max()
    date_range = f"{df['DATE'].min().strftime('%b %d, %Y')} → {latest_date.strftime('%b %d, %Y')}"

    # ── Top KPIs ──────────────────────────────────────────────────────────────
    col1, col2 = st.columns(2)
    col1.metric("Trading Days Analyzed", total_days)
    col2.metric("Unique Stocks Ever", df["SYMBOL"].nunique())
    col3, col4 = st.columns(2)
    col3.metric("Date Range", date_range)
    col4.metric("Today's List Size", df[df["DATE"] == latest_date].shape[0])

    st.divider()

    # ── Sidebar filters ────────────────────────────────────────────────────────
    with st.sidebar:
        st.header("Filters")
        min_consistency = st.slider("Min Consistency %", 0, 100, 20,
                                    help="% of days the stock appeared in the scanner")
        min_sctr = st.slider("Min Latest SCTR", 85, 99, 90)
        sectors_available = sorted(df["SECTOR"].dropna().unique()) if "SECTOR" in df.columns else []
        selected_sectors = st.multiselect("Sectors", sectors_available, default=sectors_available)
        only_today = st.toggle("Only stocks in today's list", value=False)
        exclude_earnings_days = st.number_input("Exclude if earnings within N days", 0, 60, 10)

        st.divider()
        st.caption("Scoring weights:\n- Consistency 25%\n- SCTR level 20%\n- SCTR momentum 20%\n- Volume trend 15%\n- RSI health 10%\n- Earnings safety 5%\n- In today's list 5%")

    # ── Compute scores ─────────────────────────────────────────────────────────
    with st.spinner("Computing scores..."):
        scores = compute_scores(df)

    if scores.empty:
        st.warning("No data to score.")
        return

    # Apply filters
    filtered = scores.copy()
    if selected_sectors and "SECTOR" in filtered.columns:
        filtered = filtered[filtered["SECTOR"].isin(selected_sectors)]
    filtered = filtered[filtered["CONSISTENCY_PCT"] >= min_consistency]
    filtered = filtered[filtered["LATEST_SCTR"] >= min_sctr]
    if only_today:
        filtered = filtered[filtered["IN_LATEST"] == True]
    if "EARN_DAYS" in filtered.columns:
        filtered = filtered[
            filtered["EARN_DAYS"].isna() | (filtered["EARN_DAYS"] >= exclude_earnings_days)
        ]

    # ── Tab Guide ─────────────────────────────────────────────────────────────
    with st.expander("📖 Tab Guide"):
        st.markdown("""
| Tab | What you can do |
|---|---|
| **🏆 Top Picks** | Highest-conviction stocks ranked by a composite score (SCTR, consistency, momentum, volume, RSI, earnings safety). Best for finding long-term swing candidates. |
| **⚡ Short-Term Swing** | Today's stocks ranked for 1–5 day trades. Includes ATR-based entry, stop, and take-profit levels calculated automatically. |
| **📉 Weekly Pullback** | Strong stocks (high SCTR) that dropped significantly this week — potential mean-reversion entries at a discount. |
| **📣 Social Buzz** | Stocks trending on StockTwits right now, cross-referenced with the SCTR scanner — social hype backed by technical strength. |
| **📊 Sector Analysis** | Which sectors dominate the scanner, which are trending up or down recently, and how sector rotation is moving over time. |
| **🔍 Stock Deep Dive** | Pick any single stock and see its full history — SCTR over time, price vs moving averages, volume trend, RSI history. |
| **📅 Daily History** | Browse the full scanner list for any past date — see every stock that appeared and all its metrics on that day. |
| **📄 Spec** | Technical documentation of how the dashboard and scoring work. |
        """)

    # ── Tabs ──────────────────────────────────────────────────────────────────
    tab1, tab_swing, tab_pullback, tab_social, tab2, tab3, tab4, tab6 = st.tabs([
        "🏆 Top Picks",
        "⚡ Short-Term Swing",
        "📉 Weekly Pullback",
        "📣 Social Buzz",
        "📊 Sector Analysis",
        "🔍 Stock Deep Dive",
        "📅 Daily History",
        "📄 Spec",
    ])

    # ══════════════════════════════════════════════════════════════════════════
    # TAB 1 — TOP PICKS
    # ══════════════════════════════════════════════════════════════════════════
    with tab1:
        st.subheader("Top Investment Candidates")
        st.caption("Ranked by composite score. Green = strong conviction, yellow = watch list.")

        top_n = st.slider("Show top N stocks", 5, 50, 15, key="top_n")
        top = filtered.head(top_n).copy()

        if top.empty:
            st.warning("No stocks match current filters.")
        else:
            # Score bar chart
            fig_bar = px.bar(
                top,
                x="SCORE",
                y="SYMBOL",
                orientation="h",
                color="SCORE",
                color_continuous_scale="RdYlGn",
                range_color=[40, 85],
                hover_data=["NAME", "SECTOR", "CONSISTENCY_PCT", "LATEST_SCTR", "LATEST_RSI"],
                title="Composite Investment Score",
            )
            fig_bar.update_layout(yaxis={"categoryorder": "total ascending"}, height=max(350, len(top) * 28))
            st.plotly_chart(fig_bar, use_container_width=True)

            st.divider()

            # Card view
            for _, row in top.iterrows():
                with st.container():
                    c1, c2, c3 = st.columns([3, 1, 1])
                    c1.markdown(f"**{row['SYMBOL']}** — {row.get('NAME', '')}")
                    c1.caption(f"{row.get('SECTOR', '')} | {row.get('INDUSTRY', '')}")
                    c2.metric("Score", f"{row['SCORE']:.1f}")
                    c2.metric("SCTR", f"{row['LATEST_SCTR']:.1f}")
                    mom = row.get("SCTR_MOMENTUM", 0) or 0
                    c3.metric("Consistency", f"{row['CONSISTENCY_PCT']:.0f}%")
                    c3.metric("SCTR Mom.", f"{mom:+.1f}", delta_color="normal")

                    c4, c5 = st.columns([1, 2])
                    rsi = row.get("LATEST_RSI")
                    c4.markdown(rsi_badge(rsi), unsafe_allow_html=True)
                    earn = row.get("EARN_DAYS")
                    c4.markdown(earn_badge(earn), unsafe_allow_html=True)
                    vol_trend = row.get("VOLUME_TREND")
                    if pd.notna(vol_trend):
                        c4.caption(f"Vol trend: {vol_trend:+.0f}%")
                    last = row.get("LAST")
                    atr = row.get("ATR")
                    if pd.notna(last):
                        c5.caption(f"Last price: **${last:.2f}**" + (f"  |  ATR: ${atr:.2f}" if pd.notna(atr) else ""))
                    c5.caption(f"Appeared {int(row['TOTAL_APPEARANCES'])} / {total_days} days")

                    st.markdown("---")

    # ══════════════════════════════════════════════════════════════════════════
    # TAB — SHORT-TERM SWING
    # ══════════════════════════════════════════════════════════════════════════
    with tab_swing:
        st.subheader("⚡ Short-Term Swing Candidates")
        st.caption(
            "Ranks **today's** stocks only, using momentum signals suited for 1–5 day swings. "
            "Independent of historical consistency — a stock like MRVL can rank #1 here."
        )

        today_df = df[df["DATE"] == latest_date].copy()

        if today_df.empty:
            st.warning("No data for today.")
        else:
            def norm_series(s):
                mn, mx = s.min(), s.max()
                if mx == mn:
                    return pd.Series(50.0, index=s.index)
                return ((s - mn) / (mx - mn) * 100).clip(0, 100)

            swing = today_df.copy().reset_index(drop=True)

            # ── Volume expansion vs prior 2 days ──
            if all(c in swing.columns for c in ["VOLUME", "VLAST1D", "VLAST2D"]):
                prior_avg = (swing["VLAST1D"].fillna(swing["VOLUME"]) +
                             swing["VLAST2D"].fillna(swing["VOLUME"])) / 2
                swing["VOL_EXPANSION"] = ((swing["VOLUME"] / prior_avg.replace(0, float("nan"))) - 1) * 100
            else:
                swing["VOL_EXPANSION"] = 0.0

            # ── ATR-to-price ratio (opportunity %) ──
            if "ATR" in swing.columns and "LAST" in swing.columns:
                swing["ATR_PCT"] = (swing["ATR"] / swing["LAST"].replace(0, float("nan"))) * 100
            else:
                swing["ATR_PCT"] = 0.0

            # ── RSI sweet spot: peaks at 62, penalizes overbought / weak ──
            rsi_col = swing["RSI"].fillna(62) if "RSI" in swing.columns else pd.Series(62.0, index=swing.index)
            c_rsi_swing = (100 - ((rsi_col - 62).abs() * 2.5)).clip(0, 100)

            # ── CHG% today ──
            chg_col = swing["CHG%"].fillna(0) if "CHG%" in swing.columns else pd.Series(0.0, index=swing.index)

            # ── AVWAP premium: price above AVWAP = bullish long-term ──
            if "AVWAP" in swing.columns and "LAST" in swing.columns:
                swing["AVWAP_PREMIUM"] = ((swing["LAST"] - swing["AVWAP"]) / swing["AVWAP"].replace(0, float("nan"))) * 100
            else:
                swing["AVWAP_PREMIUM"] = 0.0

            # ── Swing score (0–100) ──
            c_sctr   = norm_series(swing["SCTR"])                      # 30%
            c_vol    = norm_series(swing["VOL_EXPANSION"].fillna(0))   # 25%
            c_rsi_n  = c_rsi_swing                                     # 20%
            c_chg    = norm_series(chg_col)                            # 15%
            c_atr    = norm_series(swing["ATR_PCT"].fillna(0))         # 10%

            swing["SWING_SCORE"] = (
                c_sctr  * 0.30 +
                c_vol   * 0.25 +
                c_rsi_n * 0.20 +
                c_chg   * 0.15 +
                c_atr   * 0.10
            ).round(1)

            # ── Trade levels (ATR-based) ──
            # Limit entry = last close (pullback); Breakout entry = close + 0.5%
            # Stop = 1.5×ATR below entry; TP1 = 2:1 R/R; TP2 = 3:1 R/R
            if "ATR" in swing.columns and "LAST" in swing.columns:
                atr_s = pd.to_numeric(swing["ATR"], errors="coerce")
                last_s = pd.to_numeric(swing["LAST"], errors="coerce")
                swing["ENTRY_LIMIT"]     = last_s.round(2)
                swing["ENTRY_BREAKOUT"]  = (last_s * 1.005).round(2)
                swing["STOP"]            = (last_s - 1.5 * atr_s).round(2)
                swing["TP1"]             = (last_s + 3.0 * atr_s).round(2)   # 2:1
                swing["TP2"]             = (last_s + 4.5 * atr_s).round(2)   # 3:1
                swing["RISK_PCT"]        = ((1.5 * atr_s) / last_s * 100).round(2)

            swing = swing.sort_values("SWING_SCORE", ascending=False).reset_index(drop=True)
            swing.index += 1

            # ── Score bar chart ──
            top_swing_n = st.slider("Show top N swing picks", 1, max(1, min(50, len(swing))), min(15, len(swing)), key="swing_n")
            top_swing = swing.head(top_swing_n)

            fig_swing = px.bar(
                top_swing,
                x="SWING_SCORE", y="SYMBOL", orientation="h",
                color="SWING_SCORE",
                color_continuous_scale="RdYlGn", range_color=[30, 85],
                hover_data=["SCTR", "RSI", "CHG%", "VOL_EXPANSION"],
                title="Short-Term Swing Score (Today's Stocks Only)",
            )
            fig_swing.update_layout(yaxis={"categoryorder": "total ascending"}, height=max(350, top_swing_n * 28))
            st.plotly_chart(fig_swing, use_container_width=True)

            st.divider()

            # ── Card view ──
            for _, row in top_swing.iterrows():
                with st.container():
                    c1, c2, c3 = st.columns([3, 1, 1])
                    c1.markdown(f"**{row['SYMBOL']}** — {row.get('NAME', '')}")
                    c1.caption(f"{row.get('SECTOR', '')} | {row.get('INDUSTRY', '')}")
                    c2.metric("Swing Score", f"{row['SWING_SCORE']:.1f}")
                    c2.metric("SCTR", f"{row['SCTR']:.1f}")
                    rsi_val = row.get("RSI")
                    chg_val = row.get("CHG%")
                    c3.metric("RSI", f"{rsi_val:.1f}" if pd.notna(rsi_val) else "—")
                    c3.metric("CHG%", f"{chg_val:+.2f}%" if pd.notna(chg_val) else "—",
                              delta_color="normal")

                    c4, c5 = st.columns([1, 2])
                    vol_exp = row.get("VOL_EXPANSION")
                    c4.metric("Vol Expansion", f"{vol_exp:+.0f}%" if pd.notna(vol_exp) else "—")
                    c4.markdown(earn_badge(row.get("EARN_DAYS")), unsafe_allow_html=True)

                    last = row.get("LAST")
                    atr = row.get("ATR")
                    avwap_prem = row.get("AVWAP_PREMIUM")
                    entry_limit = row.get("ENTRY_LIMIT")
                    entry_bo = row.get("ENTRY_BREAKOUT")
                    stop = row.get("STOP")
                    tp1 = row.get("TP1")
                    tp2 = row.get("TP2")
                    risk_pct = row.get("RISK_PCT")

                    atr_str = f"ATR: ${atr:.2f}" if pd.notna(atr) else ""
                    avwap_str = f"  AVWAP premium: {avwap_prem:+.1f}%" if pd.notna(avwap_prem) else ""
                    c5.caption(atr_str + avwap_str)
                    c5.markdown(rsi_badge(rsi_val), unsafe_allow_html=True)

                    if pd.notna(entry_limit) and pd.notna(stop) and pd.notna(tp1):
                        c5.markdown(
                            f'<div style="margin-top:4px;font-size:0.85em;line-height:1.6">'
                            f'<span style="color:#aaa">🎯 Limit (pullback)</span> <b>${entry_limit:.2f}</b>'
                            f'&nbsp;&nbsp;'
                            f'<span style="color:#f39c12">🚀 Breakout (+0.5%)</span> <b>${entry_bo:.2f}</b>'
                            f'<br>'
                            f'<span style="color:#e74c3c">✕ Stop</span> <b>${stop:.2f}</b>'
                            f'&nbsp;<span style="color:#aaa;font-size:0.8em">({risk_pct:.1f}% risk)</span>'
                            f'<br>'
                            f'<span style="color:#27ae60">✔ TP1 (2:1)</span> <b>${tp1:.2f}</b>'
                            f'&nbsp;&nbsp;'
                            f'<span style="color:#2ecc71">✔ TP2 (3:1)</span> <b>${tp2:.2f}</b>'
                            f'</div>',
                            unsafe_allow_html=True
                        )

                    st.markdown("---")

            # ── Full table ──
            with st.expander("Full swing table"):
                display_swing_cols = [c for c in [
                    "SYMBOL", "NAME", "SECTOR", "SWING_SCORE", "SCTR", "RSI", "CHG%",
                    "VOL_EXPANSION", "ATR", "ENTRY_LIMIT", "ENTRY_BREAKOUT", "STOP", "TP1", "TP2", "RISK_PCT",
                    "AVWAP_PREMIUM", "EARN_DAYS"
                ] if c in swing.columns]
                st.dataframe(
                    swing[display_swing_cols],
                    use_container_width=True,
                    column_config={
                        "SWING_SCORE": st.column_config.ProgressColumn("Swing Score", min_value=0, max_value=100),
                        "CHG%": st.column_config.NumberColumn("CHG%", format="%+.2f%%"),
                        "VOL_EXPANSION": st.column_config.NumberColumn("Vol Expansion", format="%+.0f%%"),
                        "AVWAP_PREMIUM": st.column_config.NumberColumn("AVWAP Premium", format="%+.1f%%"),
                        "ENTRY_LIMIT": st.column_config.NumberColumn("Limit Entry $", format="$%.2f"),
                        "ENTRY_BREAKOUT": st.column_config.NumberColumn("Breakout Entry $", format="$%.2f"),
                        "STOP": st.column_config.NumberColumn("Stop $", format="$%.2f"),
                        "TP1": st.column_config.NumberColumn("TP1 2:1 $", format="$%.2f"),
                        "TP2": st.column_config.NumberColumn("TP2 3:1 $", format="$%.2f"),
                        "RISK_PCT": st.column_config.NumberColumn("Risk %", format="%.1f%%"),
                    },
                    hide_index=False,
                )

    # ══════════════════════════════════════════════════════════════════════════
    # TAB — WEEKLY PULLBACK SCANNER
    # ══════════════════════════════════════════════════════════════════════════
    with tab_pullback:
        st.subheader("📉 Weekly Pullback Scanner")
        st.caption(
            "Finds SCTR stocks whose intraweek low dropped ≥ N% from their intraweek high — "
            "strong stocks in a temporary dip, potential mean-reversion entries."
        )

        min_drop = st.slider("Min High→Low Drop %", 5, 40, 15, key="pullback_drop")

        week_cutoff = latest_date - timedelta(days=7)
        week_symbols = tuple(sorted(df[df["DATE"] >= week_cutoff]["SYMBOL"].unique()))

        if not week_symbols:
            st.warning("No symbols found in the past week.")
        else:
            with st.spinner(f"Fetching 1-week price data for {len(week_symbols)} symbols from Yahoo Finance…"):
                pullback_raw = fetch_weekly_pullbacks(week_symbols)

            if pullback_raw.empty:
                st.info("No price data returned from Yahoo Finance.")
            else:
                filtered_pb = pullback_raw[pullback_raw["DROP_PCT"] >= min_drop].copy()

                # Merge SCTR context
                score_ctx = scores[["SYMBOL", "LATEST_SCTR", "SCTR_MOMENTUM", "LATEST_RSI",
                                    "SECTOR", "NAME", "SCORE", "EARN_DAYS"]].copy()
                filtered_pb = filtered_pb.merge(score_ctx, on="SYMBOL", how="left")

                st.metric(f"Stocks with ≥ {min_drop}% weekly pullback", len(filtered_pb))

                if filtered_pb.empty:
                    st.info(f"No stocks found with ≥ {min_drop}% weekly pullback.")
                else:
                    # ── Drop % bar chart ──
                    fig_pb = px.bar(
                        filtered_pb,
                        x="DROP_PCT", y="SYMBOL", orientation="h",
                        color="DROP_PCT",
                        color_continuous_scale="RdYlGn_r",
                        hover_data=["WEEK_HIGH", "WEEK_LOW", "CURRENT", "LATEST_SCTR", "SECTOR"],
                        title=f"Weekly High→Low Drop % (≥ {min_drop}%)",
                        labels={"DROP_PCT": "Drop %"},
                    )
                    fig_pb.update_layout(
                        yaxis={"categoryorder": "total ascending"},
                        height=max(350, len(filtered_pb) * 28),
                    )
                    st.plotly_chart(fig_pb, use_container_width=True)

                    # ── Price range chart: low / current / high per symbol ──
                    fig_range = go.Figure()
                    for _, row in filtered_pb.iterrows():
                        sym = row["SYMBOL"]
                        fig_range.add_trace(go.Scatter(
                            x=[row["WEEK_LOW"], row["CURRENT"], row["WEEK_HIGH"]],
                            y=[sym, sym, sym],
                            mode="lines+markers",
                            marker=dict(
                                color=["#e74c3c", "#f39c12", "#27ae60"],
                                size=[8, 12, 8],
                                symbol=["circle", "diamond", "circle"],
                            ),
                            line=dict(color="#555555", width=2),
                            name=sym,
                            showlegend=False,
                            hovertemplate=(
                                f"<b>{sym}</b><br>"
                                f"Low: ${row['WEEK_LOW']:.2f}<br>"
                                f"Current: ${row['CURRENT']:.2f}<br>"
                                f"High: ${row['WEEK_HIGH']:.2f}"
                            ),
                        ))
                    fig_range.update_layout(
                        title="Weekly Price Range — Low (red) · Current (orange) · High (green)",
                        height=max(350, len(filtered_pb) * 28),
                        xaxis_title="Price ($)",
                    )
                    st.plotly_chart(fig_range, use_container_width=True)

                    # ── Table ──
                    display_pb_cols = [c for c in [
                        "SYMBOL", "NAME", "SECTOR",
                        "WEEK_HIGH", "WEEK_LOW", "CURRENT",
                        "DROP_PCT", "FROM_HIGH_PCT", "RECOVERY_PCT",
                        "LATEST_SCTR", "SCTR_MOMENTUM", "LATEST_RSI", "EARN_DAYS", "SCORE",
                    ] if c in filtered_pb.columns]

                    st.dataframe(
                        filtered_pb[display_pb_cols],
                        use_container_width=True,
                        column_config={
                            "DROP_PCT": st.column_config.NumberColumn("Drop %", format="%.1f%%"),
                            "FROM_HIGH_PCT": st.column_config.NumberColumn("From High %", format="%.1f%%"),
                            "RECOVERY_PCT": st.column_config.ProgressColumn("Recovery %", min_value=0, max_value=100),
                            "WEEK_HIGH": st.column_config.NumberColumn("Week High $", format="$%.2f"),
                            "WEEK_LOW": st.column_config.NumberColumn("Week Low $", format="$%.2f"),
                            "CURRENT": st.column_config.NumberColumn("Current $", format="$%.2f"),
                            "LATEST_SCTR": st.column_config.NumberColumn("SCTR", format="%.1f"),
                            "SCTR_MOMENTUM": st.column_config.NumberColumn("SCTR Mom.", format="%+.1f"),
                            "SCORE": st.column_config.ProgressColumn("SCTR Score", min_value=0, max_value=100),
                        },
                        hide_index=True,
                    )

    # ══════════════════════════════════════════════════════════════════════════
    # TAB — SOCIAL BUZZ
    # ══════════════════════════════════════════════════════════════════════════
    with tab_social:
        st.subheader("📣 Social Buzz — Trending on StockTwits")
        st.caption(
            "Top symbols trending on StockTwits right now, cross-referenced with your SCTR scanner. "
            "Stocks appearing in **both** social trending and the SCTR scanner are the highest-conviction candidates."
        )

        with st.spinner("Fetching trending symbols from StockTwits…"):
            trending_df = fetch_trending_stocktwits()

        if trending_df.empty:
            st.warning("Could not fetch trending data from StockTwits. Try again later.")
        else:
            score_ctx = scores[["SYMBOL", "LATEST_SCTR", "SCTR_MOMENTUM", "LATEST_RSI",
                                 "SECTOR", "NAME", "SCORE", "CONSISTENCY_PCT",
                                 "IN_LATEST", "EARN_DAYS"]].copy()
            merged = trending_df.merge(score_ctx, on="SYMBOL", how="left")
            merged["NAME"] = merged["NAME"].fillna(merged["ST_NAME"])
            merged["IN_SCTR"] = merged["LATEST_SCTR"].notna()

            in_both = int(merged["IN_SCTR"].sum())
            c1, c2, c3 = st.columns(3)
            c1.metric("Trending on StockTwits", len(merged))
            c2.metric("Also in SCTR Scanner", in_both)
            c3.metric("Overlap", f"{in_both / len(merged) * 100:.0f}%")

            st.divider()

            fig_social = px.bar(
                merged.sort_values("WATCHLIST_COUNT", ascending=False),
                x="SYMBOL", y="WATCHLIST_COUNT",
                color="IN_SCTR",
                color_discrete_map={True: "#27ae60", False: "#95a5a6"},
                hover_data=["NAME", "LATEST_SCTR", "SCORE", "SECTOR"],
                title="StockTwits Trending — Watchlist Count (green = also in SCTR scanner)",
                labels={"WATCHLIST_COUNT": "Watchlist Count", "IN_SCTR": "In SCTR"},
            )
            fig_social.update_layout(height=400, xaxis_tickangle=45)
            st.plotly_chart(fig_social, use_container_width=True)

            st.subheader("🎯 SCTR + Social Intersection")
            st.caption("Trending socially AND in the SCTR scanner — sorted by SCTR score.")

            intersection = merged[merged["IN_SCTR"]].sort_values("SCORE", ascending=False)

            if intersection.empty:
                st.info("No overlap between trending symbols and SCTR scanner right now.")
            else:
                for _, row in intersection.iterrows():
                    with st.container():
                        c1, c2, c3 = st.columns([3, 1, 1])
                        c1.markdown(f"**{row['SYMBOL']}** — {row.get('NAME', '')}")
                        c1.caption(row.get("SECTOR", ""))
                        score_val = row.get("SCORE")
                        sctr_val = row.get("LATEST_SCTR")
                        c2.metric("SCTR Score", f"{score_val:.1f}" if pd.notna(score_val) else "—")
                        c2.metric("SCTR", f"{sctr_val:.1f}" if pd.notna(sctr_val) else "—")
                        c3.metric("Watchlist", f"{int(row['WATCHLIST_COUNT']):,}")
                        c3.markdown(rsi_badge(row.get("LATEST_RSI")), unsafe_allow_html=True)

                        c4, c5 = st.columns([1, 2])
                        consistency = row.get("CONSISTENCY_PCT")
                        if pd.notna(consistency):
                            c4.caption(f"Consistency: {consistency:.0f}%")
                        c4.markdown(earn_badge(row.get("EARN_DAYS")), unsafe_allow_html=True)
                        if row.get("IN_LATEST"):
                            c5.markdown(
                                '<span style="background:#27ae60;color:white;padding:2px 8px;'
                                'border-radius:10px;font-size:0.85em">✓ In Today\'s List</span>',
                                unsafe_allow_html=True,
                            )
                        st.markdown("---")

            with st.expander("Full trending table"):
                display_social_cols = [c for c in [
                    "SYMBOL", "NAME", "WATCHLIST_COUNT", "IN_SCTR",
                    "LATEST_SCTR", "SCORE", "SECTOR", "LATEST_RSI", "CONSISTENCY_PCT", "EARN_DAYS",
                ] if c in merged.columns]
                st.dataframe(
                    merged[display_social_cols].sort_values("WATCHLIST_COUNT", ascending=False),
                    use_container_width=True,
                    column_config={
                        "WATCHLIST_COUNT": st.column_config.NumberColumn("Watchlist Count", format="%d"),
                        "IN_SCTR": st.column_config.CheckboxColumn("In SCTR"),
                        "SCORE": st.column_config.ProgressColumn("SCTR Score", min_value=0, max_value=100),
                        "LATEST_SCTR": st.column_config.NumberColumn("SCTR", format="%.1f"),
                        "CONSISTENCY_PCT": st.column_config.NumberColumn("Consistency %", format="%.0f%%"),
                    },
                    hide_index=True,
                )

    # ══════════════════════════════════════════════════════════════════════════
    # TAB 2 — SECTOR ANALYSIS
    # ══════════════════════════════════════════════════════════════════════════
    with tab2:
        st.subheader("Sector Rotation Analysis")

        if "SECTOR" not in df.columns:
            st.info("Sector data not available.")
        else:
            # Stocks per sector over time
            sector_time = (
                df[df["DATE"] >= latest_date - timedelta(days=90)]
                .groupby([df["DATE"].dt.to_period("W").dt.start_time, "SECTOR"])["SYMBOL"]
                .nunique()
                .reset_index()
                .rename(columns={"DATE": "WEEK", "SYMBOL": "COUNT"})
            )
            fig_sector_time = px.area(
                sector_time,
                x="WEEK", y="COUNT", color="SECTOR",
                title="Stocks per Sector Making the SCTR Scanner (Last 90 Days, Weekly)",
            )
            st.plotly_chart(fig_sector_time, use_container_width=True)

            col_a, col_b = st.columns(2)

            # Sector avg SCTR
            sector_sctr = df.groupby("SECTOR")["SCTR"].mean().sort_values(ascending=False).reset_index()
            fig_sector_sctr = px.bar(
                sector_sctr, x="SECTOR", y="SCTR",
                color="SCTR", color_continuous_scale="RdYlGn", range_color=[90, 99],
                title="Avg SCTR by Sector (All Time)"
            )
            fig_sector_sctr.update_xaxes(tickangle=30)
            col_a.plotly_chart(fig_sector_sctr, use_container_width=True)

            # Sector frequency pie
            sector_freq = df.groupby("SECTOR")["SYMBOL"].count().reset_index()
            fig_pie = px.pie(
                sector_freq, names="SECTOR", values="SYMBOL",
                title="Scanner Appearances by Sector"
            )
            col_b.plotly_chart(fig_pie, use_container_width=True)

            # Top sector trends — recent vs prior
            recent_cut = latest_date - timedelta(days=30)
            s_recent = df[df["DATE"] >= recent_cut].groupby("SECTOR")["SYMBOL"].nunique().rename("RECENT")
            s_older = df[df["DATE"] < recent_cut].groupby("SECTOR")["SYMBOL"].nunique().rename("OLDER")
            sector_trend = pd.concat([s_recent, s_older], axis=1).fillna(0)
            sector_trend["CHANGE"] = sector_trend["RECENT"] - sector_trend["OLDER"]
            sector_trend = sector_trend.sort_values("CHANGE", ascending=False).reset_index()

            st.subheader("Sector Momentum (Last 30 Days vs Prior)")
            fig_trend = px.bar(
                sector_trend, x="SECTOR", y="CHANGE",
                color="CHANGE", color_continuous_scale="RdYlGn",
                title="Sector Momentum: Recent - Historical Unique Stocks"
            )
            fig_trend.update_xaxes(tickangle=30)
            st.plotly_chart(fig_trend, use_container_width=True)

    # ══════════════════════════════════════════════════════════════════════════
    # TAB 3 — STOCK DEEP DIVE
    # ══════════════════════════════════════════════════════════════════════════
    with tab3:
        st.subheader("Stock Deep Dive")

        all_symbols = sorted(df["SYMBOL"].unique())
        chosen = st.selectbox("Select a symbol", all_symbols)

        stock_df = df[df["SYMBOL"] == chosen].sort_values("DATE")

        if stock_df.empty:
            st.info("No data for this symbol.")
        else:
            # Summary row
            latest_row = stock_df.iloc[-1]
            m1, m2, m3, m4, m5 = st.columns(5)
            m1.metric("SCTR (Latest)", f"{latest_row['SCTR']:.1f}")
            m2.metric("Days on List", len(stock_df))
            m3.metric("Consistency", f"{len(stock_df)/total_days*100:.0f}%")
            if "RSI" in latest_row and pd.notna(latest_row["RSI"]):
                m4.metric("RSI", f"{latest_row['RSI']:.1f}")
            if "EARN_DAYS" in latest_row and pd.notna(latest_row["EARN_DAYS"]):
                m5.metric("Earnings in", f"{int(latest_row['EARN_DAYS'])}d")

            st.markdown(f"**{latest_row.get('NAME', chosen)}** | {latest_row.get('SECTOR', '')} | {latest_row.get('INDUSTRY', '')}")

            # SCTR over time
            fig_sctr = go.Figure()
            fig_sctr.add_trace(go.Scatter(
                x=stock_df["DATE"], y=stock_df["SCTR"],
                mode="lines+markers", name="SCTR",
                line=dict(color="#3498db", width=2),
                marker=dict(size=5)
            ))
            fig_sctr.add_hline(y=90, line_dash="dash", line_color="orange", annotation_text="90 threshold")
            fig_sctr.update_layout(title=f"{chosen} — SCTR Over Time", height=300, showlegend=False)
            st.plotly_chart(fig_sctr, use_container_width=True)

            # Price vs MAs
            if all(c in stock_df.columns for c in ["LAST", "MA10", "MA20", "MA50", "MA150"]):
                fig_price = go.Figure()
                colors = {"LAST": "#2ecc71", "MA10": "#3498db", "MA20": "#9b59b6",
                          "MA50": "#e67e22", "MA150": "#e74c3c"}
                widths = {"LAST": 2.5, "MA10": 1, "MA20": 1, "MA50": 1.5, "MA150": 2}
                for col, color in colors.items():
                    valid = stock_df[["DATE", col]].dropna()
                    if not valid.empty:
                        fig_price.add_trace(go.Scatter(
                            x=valid["DATE"], y=valid[col], mode="lines",
                            name=col, line=dict(color=color, width=widths[col])
                        ))
                fig_price.update_layout(title=f"{chosen} — Price vs Moving Averages", height=350)
                st.plotly_chart(fig_price, use_container_width=True)

            # Volume trend
            if "VOLUME" in stock_df.columns:
                vol_data = stock_df[["DATE", "VOLUME"]].dropna()
                if not vol_data.empty:
                    fig_vol = px.bar(vol_data, x="DATE", y="VOLUME",
                                     title=f"{chosen} — Volume History",
                                     color_discrete_sequence=["#3498db"])
                    fig_vol.update_layout(height=250)
                    st.plotly_chart(fig_vol, use_container_width=True)

            # RSI history
            if "RSI" in stock_df.columns:
                rsi_data = stock_df[["DATE", "RSI"]].dropna()
                if not rsi_data.empty:
                    fig_rsi = go.Figure()
                    fig_rsi.add_trace(go.Scatter(
                        x=rsi_data["DATE"], y=rsi_data["RSI"],
                        mode="lines", fill="tozeroy",
                        line=dict(color="#9b59b6", width=1.5)
                    ))
                    fig_rsi.add_hline(y=70, line_dash="dash", line_color="red", annotation_text="Overbought 70")
                    fig_rsi.add_hline(y=50, line_dash="dash", line_color="green", annotation_text="Neutral 50")
                    fig_rsi.update_layout(title=f"{chosen} — RSI History", height=250, yaxis_range=[0, 100])
                    st.plotly_chart(fig_rsi, use_container_width=True)

            st.divider()
            with st.expander("Raw data for this stock"):
                st.dataframe(stock_df.sort_values("DATE", ascending=False), use_container_width=True)

    # ══════════════════════════════════════════════════════════════════════════
    # TAB 4 — DAILY HISTORY
    # ══════════════════════════════════════════════════════════════════════════
    with tab4:
        st.subheader("Daily Scanner History")

        dates_available = sorted(df["DATE"].unique(), reverse=True)
        selected_date = st.selectbox(
            "Pick a date",
            [d.strftime("%Y-%m-%d") for d in dates_available]
        )

        day_df = df[df["DATE"] == pd.to_datetime(selected_date)].copy()

        if day_df.empty:
            st.info("No data for this date.")
        else:
            st.caption(f"{len(day_df)} stocks on {selected_date}")

            # Quick sector breakdown
            if "SECTOR" in day_df.columns:
                sec_counts = day_df["SECTOR"].value_counts().reset_index()
                fig_day_sec = px.pie(sec_counts, names="SECTOR", values="count",
                                     title="Sector Distribution for This Day")
                st.plotly_chart(fig_day_sec, use_container_width=True)

            # Table — all fields
            all_day_cols = [
                "RANK", "SYMBOL", "NAME", "SECTOR", "INDUSTRY", "MARKET CAP",
                "SCTR", "SCTR_CHG",
                "LAST", "CHG", "CHG%", "LAST1D", "LAST2D",
                "RSI", "ATR", "VWAP", "AVWAP",
                "VOLUME", "VLAST1D", "VLAST2D",
                "MA10", "MA20", "MA50", "MA150",
                "EARN_DATE", "EARN_DAYS",
            ]
            display_cols = [c for c in all_day_cols if c in day_df.columns]
            display_day_df = day_df[display_cols].sort_values("SCTR", ascending=False).copy()
            for _vol_col in ["VOLUME", "VLAST1D", "VLAST2D"]:
                if _vol_col in display_day_df.columns:
                    display_day_df[_vol_col] = display_day_df[_vol_col].apply(
                        lambda x: f"{int(x):,}" if pd.notna(x) else ""
                    )
            st.dataframe(
                display_day_df,
                use_container_width=True,
                hide_index=True,
                column_config={
                    "RANK":       st.column_config.NumberColumn("Rank", format="%d"),
                    "MARKET CAP": st.column_config.NumberColumn("Mkt Cap", format="$%d"),
                    "SCTR":       st.column_config.NumberColumn("SCTR", format="%.1f"),
                    "SCTR_CHG":   st.column_config.NumberColumn("SCTR Chg", format="%+.1f"),
                    "LAST":       st.column_config.NumberColumn("Last $", format="$%.2f"),
                    "CHG":        st.column_config.NumberColumn("Chg $", format="$%+.2f"),
                    "CHG%":       st.column_config.NumberColumn("Chg %", format="%+.2f%%"),
                    "LAST1D":     st.column_config.NumberColumn("Last 1D $", format="$%.2f"),
                    "LAST2D":     st.column_config.NumberColumn("Last 2D $", format="$%.2f"),
                    "RSI":        st.column_config.NumberColumn("RSI", format="%.1f"),
                    "ATR":        st.column_config.NumberColumn("ATR $", format="$%.2f"),
                    "VWAP":       st.column_config.NumberColumn("VWAP $", format="$%.2f"),
                    "AVWAP":      st.column_config.NumberColumn("AVWAP $", format="$%.2f"),
                    "VOLUME":     st.column_config.TextColumn("Volume"),
                    "VLAST1D":    st.column_config.TextColumn("Vol 1D"),
                    "VLAST2D":    st.column_config.TextColumn("Vol 2D"),
                    "MA10":       st.column_config.NumberColumn("MA10 $", format="$%.2f"),
                    "MA20":       st.column_config.NumberColumn("MA20 $", format="$%.2f"),
                    "MA50":       st.column_config.NumberColumn("MA50 $", format="$%.2f"),
                    "MA150":      st.column_config.NumberColumn("MA150 $", format="$%.2f"),
                    "EARN_DATE":  st.column_config.TextColumn("Earn Date"),
                    "EARN_DAYS":  st.column_config.NumberColumn("Earn Days", format="%d"),
                },
            )

    # ══════════════════════════════════════════════════════════════════════════
    # TAB 6 — SPEC
    # ══════════════════════════════════════════════════════════════════════════
    with tab6:
        spec_path = os.path.join(SCRIPT_DIR, "doc", "dashboard_spec.md")
        if os.path.exists(spec_path):
            with open(spec_path, "r", encoding="utf-8") as f:
                st.markdown(f.read())
        else:
            st.warning(f"Spec file not found at `{spec_path}`")


if __name__ == "__main__":
    main()
