"""
Centralized configuration for the Python scanner CLI.
Loads all settings from environment variables via python-dotenv.
"""

import os
from dotenv import load_dotenv

load_dotenv()


# ── API Keys ──────────────────────────────────────────────────────────────────

POLYGON_API_KEY      = os.getenv("POLYGON_API_KEY", "")
COINGLASS_API_KEY    = os.getenv("COINGLASS_API_KEY", "")
NASDAQ_DATA_API_KEY  = os.getenv("NASDAQ_DATA_API_KEY", "")

# ── Telegram ──────────────────────────────────────────────────────────────────

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

# ── Scan Settings ─────────────────────────────────────────────────────────────

SCAN_INTERVAL_SECONDS  = int(os.getenv("SCAN_INTERVAL_SECONDS", "300"))
POLITICIAN_LOOKBACK_DAYS = int(os.getenv("POLITICIAN_LOOKBACK_DAYS", "30"))

# ── Default Tickers ───────────────────────────────────────────────────────────

OPTIONS_TICKERS = os.getenv(
    "OPTIONS_TICKERS",
    "AAPL,TSLA,NVDA,MSFT,AMZN,GOOGL,META,SPY,QQQ,IWM",
).split(",")

CRYPTO_TICKERS = os.getenv(
    "CRYPTO_TICKERS",
    "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT",
).split(",")

COMMODITIES_TICKERS = os.getenv(
    "COMMODITIES_TICKERS",
    "GC=F,SI=F,CL=F,NG=F,HG=F",
).split(",")
