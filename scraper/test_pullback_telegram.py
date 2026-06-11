"""Quick test: runs only the AI pullback analysis, no scraping needed.

Usage:
  python test_pullback_telegram.py           # sends to Telegram (needs TELEGRAM_TOKEN + CHAT_ID)
  python test_pullback_telegram.py --dry-run # prints message to terminal, no Telegram needed
"""
import os, sys

DRY_RUN = "--dry-run" in sys.argv

# Load .env.local from the repo root
env_path = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

from scrape_sctr import run_pullback_telegram, _send_telegram

supabase_url  = os.environ.get("SUPABASE_URL", "")
supabase_key  = os.environ.get("SUPABASE_KEY", "")
anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")

required = {"SUPABASE_URL": supabase_url, "SUPABASE_KEY": supabase_key, "ANTHROPIC_API_KEY": anthropic_key}
if not DRY_RUN:
    required["TELEGRAM_TOKEN"]   = os.environ.get("TELEGRAM_TOKEN", "")
    required["TELEGRAM_CHAT_ID"] = os.environ.get("TELEGRAM_CHAT_ID", "")

missing = [k for k, v in required.items() if not v]
if missing:
    print(f"❌ Missing env vars: {', '.join(missing)}")
    sys.exit(1)

if DRY_RUN:
    # Patch _send_telegram to print instead of sending
    import scrape_sctr
    def _dry_send(token, chat_id, text):
        print("\n" + "─" * 50)
        print("TELEGRAM MESSAGE (dry run):")
        print("─" * 50)
        print(text)
        print("─" * 50 + "\n")
    scrape_sctr._send_telegram = _dry_send
    token = chat_id = "dry-run"
else:
    token   = os.environ.get("TELEGRAM_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")

print(f"▶ Running pullback analysis{'  (dry run — no Telegram send)' if DRY_RUN else ''}…")
run_pullback_telegram(token, chat_id, supabase_url, supabase_key, anthropic_key)
