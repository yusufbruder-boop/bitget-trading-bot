"""
US Options Scanner — powered by the Polygon.io API.

Detects unusual options activity by monitoring:
  • Implied Volatility (IV) spikes relative to 30-day average
  • Volume / Open Interest ratio (Vol/OI) above threshold
  • Large single-contract sweeps (high premium, short expiry)

Usage:
    from modules.options_scanner import OptionsScanner
    scanner = OptionsScanner(config, logger)
    alerts  = scanner.scan()              # use default tickers from config
    alerts  = scanner.scan(ticker="AAPL") # override to a single ticker
"""

from __future__ import annotations

import time
from datetime import date, timedelta
from typing import List, Optional

import requests

from utils.alerts import Alert, Severity


# ── Thresholds ────────────────────────────────────────────────────────────────

IV_SPIKE_MULTIPLIER   = 1.5   # flag if current IV > 1.5× 30-day avg IV
VOL_OI_THRESHOLD      = 3.0   # flag if volume/open_interest > 3
LARGE_PREMIUM_USD     = 50_000  # flag single contract if premium > $50k
MAX_DAYS_TO_EXPIRY    = 14    # only look at near-term contracts for sweeps
POLYGON_BASE_URL      = "https://api.polygon.io"
REQUEST_TIMEOUT       = 10    # seconds


class OptionsScanner:
    """
    Scans US equity options for unusual activity via the Polygon.io REST API.

    Args:
        config: The config module (or any object with POLYGON_API_KEY,
                OPTIONS_TICKERS, etc. as attributes).
        logger: A utils.logger.Logger instance.
    """

    def __init__(self, config, logger) -> None:
        self._config  = config
        self._log     = logger
        self._api_key = getattr(config, "POLYGON_API_KEY", "")

        if not self._api_key:
            self._log.warning(
                "POLYGON_API_KEY is not set — options scanner will return no data."
            )

    # ── Public API ────────────────────────────────────────────────────────────

    def scan(self, ticker: Optional[str] = None) -> List[Alert]:
        """
        Run the options scan.

        Args:
            ticker: If provided, scan only this ticker.
                    Otherwise scan all tickers in config.OPTIONS_TICKERS.

        Returns:
            List of Alert objects for any unusual activity found.
        """
        tickers = [ticker] if ticker else list(self._config.OPTIONS_TICKERS)
        alerts: List[Alert] = []

        self._log.info(f"Options scan started — {len(tickers)} ticker(s): {', '.join(tickers)}")

        for sym in tickers:
            try:
                sym_alerts = self._scan_ticker(sym)
                alerts.extend(sym_alerts)
                if sym_alerts:
                    self._log.success(f"{sym}: {len(sym_alerts)} alert(s) generated")
                else:
                    self._log.info(f"{sym}: no unusual activity detected")
            except Exception as exc:
                self._log.error(f"{sym}: scan failed — {exc}")

        self._log.info(f"Options scan complete — {len(alerts)} total alert(s)")
        return alerts

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _scan_ticker(self, ticker: str) -> List[Alert]:
        """Fetch options chain for *ticker* and return any alerts."""
        if not self._api_key:
            return []

        alerts: List[Alert] = []
        contracts = self._fetch_options_chain(ticker)

        if not contracts:
            self._log.warning(f"{ticker}: empty options chain returned by Polygon")
            return alerts

        # Aggregate stats for IV baseline
        iv_values = [c["implied_volatility"] for c in contracts if c.get("implied_volatility")]
        avg_iv    = sum(iv_values) / len(iv_values) if iv_values else 0

        for contract in contracts:
            iv      = contract.get("implied_volatility", 0) or 0
            volume  = contract.get("day", {}).get("volume", 0) or 0
            oi      = contract.get("open_interest", 0) or 0
            premium = contract.get("day", {}).get("last_price", 0) or 0
            expiry  = contract.get("expiration_date", "")
            strike  = contract.get("strike_price", 0)
            c_type  = contract.get("contract_type", "").upper()
            details = f"{ticker} {c_type} ${strike} exp {expiry}"

            # ── IV spike ──────────────────────────────────────────────────────
            if avg_iv > 0 and iv > avg_iv * IV_SPIKE_MULTIPLIER:
                alerts.append(Alert(
                    title   = "IV Spike Detected",
                    message = (
                        f"{details} — IV {iv:.1%} is "
                        f"{iv / avg_iv:.1f}× the chain average ({avg_iv:.1%})"
                    ),
                    ticker   = ticker,
                    severity = Severity.WARNING,
                    module   = "options_scanner",
                    metadata = {
                        "contract":   details,
                        "iv_current": f"{iv:.1%}",
                        "iv_avg":     f"{avg_iv:.1%}",
                        "ratio":      f"{iv / avg_iv:.2f}×",
                    },
                ))

            # ── High Vol/OI ratio ─────────────────────────────────────────────
            if oi > 0 and volume / oi > VOL_OI_THRESHOLD:
                alerts.append(Alert(
                    title   = "Unusual Volume/OI Ratio",
                    message = (
                        f"{details} — Vol/OI = {volume / oi:.1f} "
                        f"(volume {volume:,}, OI {oi:,})"
                    ),
                    ticker   = ticker,
                    severity = Severity.WARNING,
                    module   = "options_scanner",
                    metadata = {
                        "contract": details,
                        "volume":   f"{volume:,}",
                        "oi":       f"{oi:,}",
                        "vol_oi":   f"{volume / oi:.2f}",
                    },
                ))

            # ── Large premium sweep ───────────────────────────────────────────
            contract_premium_usd = premium * 100  # 1 contract = 100 shares
            days_to_expiry = self._days_to_expiry(expiry)
            if (
                contract_premium_usd >= LARGE_PREMIUM_USD
                and 0 < days_to_expiry <= MAX_DAYS_TO_EXPIRY
            ):
                alerts.append(Alert(
                    title   = "Large Premium Sweep",
                    message = (
                        f"{details} — ${contract_premium_usd:,.0f} premium, "
                        f"{days_to_expiry}d to expiry"
                    ),
                    ticker   = ticker,
                    severity = Severity.CRITICAL,
                    module   = "options_scanner",
                    metadata = {
                        "contract":      details,
                        "premium_usd":   f"${contract_premium_usd:,.0f}",
                        "days_to_expiry": str(days_to_expiry),
                    },
                ))

        return alerts

    def _fetch_options_chain(self, ticker: str) -> list:
        """
        Fetch the options chain snapshot for *ticker* from Polygon.io.
        Returns a list of contract dicts, or [] on error.
        """
        url    = f"{POLYGON_BASE_URL}/v3/snapshot/options/{ticker}"
        params = {"apiKey": self._api_key, "limit": 250}

        try:
            resp = requests.get(url, params=params, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            data = resp.json()
            return [item.get("details", {}) | item for item in data.get("results", [])]
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 403:
                self._log.error(
                    f"{ticker}: Polygon returned 403 — check your POLYGON_API_KEY "
                    "and subscription tier (options data requires Starter plan or above)."
                )
            else:
                self._log.error(f"{ticker}: Polygon HTTP error — {exc}")
        except requests.RequestException as exc:
            self._log.error(f"{ticker}: network error fetching options chain — {exc}")

        return []

    @staticmethod
    def _days_to_expiry(expiry_str: str) -> int:
        """Return calendar days until *expiry_str* (YYYY-MM-DD), or 9999 on parse error."""
        try:
            exp  = date.fromisoformat(expiry_str)
            diff = (exp - date.today()).days
            return max(diff, 0)
        except (ValueError, TypeError):
            return 9999
