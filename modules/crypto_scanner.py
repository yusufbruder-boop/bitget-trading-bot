"""
Crypto Whale Scanner — powered by the CoinGlass API.

Detects significant on-chain and derivatives activity:
  • Large liquidations (whale long/short wipeouts)
  • Open Interest spikes (sudden OI increase > threshold)
  • Funding rate extremes (over-leveraged market)
  • Large spot transactions via CoinGlass whale alerts

Usage:
    from modules.crypto_scanner import CryptoScanner
    scanner = CryptoScanner(config, logger)
    alerts  = scanner.scan()                    # all tickers from config
    alerts  = scanner.scan(ticker="BTCUSDT")    # single ticker override
"""

from __future__ import annotations

from typing import List, Optional

import requests

from utils.alerts import Alert, Severity


# ── Thresholds ────────────────────────────────────────────────────────────────

LIQUIDATION_USD_THRESHOLD  = 1_000_000   # $1M+ liquidation = whale event
OI_SPIKE_PCT               = 10.0        # OI increased > 10% in one interval
FUNDING_RATE_EXTREME       = 0.001       # |funding rate| > 0.1% = extreme
COINGLASS_BASE_URL         = "https://open-api.coinglass.com/public/v2"
REQUEST_TIMEOUT            = 10


class CryptoScanner:
    """
    Scans crypto derivatives markets for whale activity via CoinGlass.

    Args:
        config: Config module with COINGLASS_API_KEY and CRYPTO_TICKERS.
        logger: A utils.logger.Logger instance.
    """

    def __init__(self, config, logger) -> None:
        self._config  = config
        self._log     = logger
        self._api_key = getattr(config, "COINGLASS_API_KEY", "")

        if not self._api_key:
            self._log.warning(
                "COINGLASS_API_KEY is not set — crypto scanner will return no data."
            )

    # ── Public API ────────────────────────────────────────────────────────────

    def scan(self, ticker: Optional[str] = None) -> List[Alert]:
        """
        Run the crypto whale scan.

        Args:
            ticker: If provided, scan only this ticker (e.g. "BTCUSDT").
                    Otherwise scan all tickers in config.CRYPTO_TICKERS.

        Returns:
            List of Alert objects for any significant moves found.
        """
        tickers = [ticker] if ticker else list(self._config.CRYPTO_TICKERS)
        alerts: List[Alert] = []

        self._log.info(f"Crypto scan started — {len(tickers)} ticker(s): {', '.join(tickers)}")

        for sym in tickers:
            # CoinGlass uses base symbol without USDT suffix for some endpoints
            base = sym.replace("USDT", "").replace("usdt", "")
            try:
                sym_alerts = self._scan_ticker(sym, base)
                alerts.extend(sym_alerts)
                if sym_alerts:
                    self._log.success(f"{sym}: {len(sym_alerts)} alert(s) generated")
                else:
                    self._log.info(f"{sym}: no significant whale activity detected")
            except Exception as exc:
                self._log.error(f"{sym}: scan failed — {exc}")

        self._log.info(f"Crypto scan complete — {len(alerts)} total alert(s)")
        return alerts

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _scan_ticker(self, ticker: str, base: str) -> List[Alert]:
        """Run all checks for a single ticker and return alerts."""
        if not self._api_key:
            return []

        alerts: List[Alert] = []

        alerts.extend(self._check_liquidations(ticker, base))
        alerts.extend(self._check_open_interest(ticker, base))
        alerts.extend(self._check_funding_rate(ticker, base))

        return alerts

    # ── Liquidation check ─────────────────────────────────────────────────────

    def _check_liquidations(self, ticker: str, base: str) -> List[Alert]:
        """Flag large liquidation events."""
        alerts: List[Alert] = []
        data = self._get(f"/liquidation_info", params={"symbol": base, "time_type": "h1"})

        if not data:
            return alerts

        for exchange_data in data if isinstance(data, list) else [data]:
            long_liq  = float(exchange_data.get("longLiquidationUsd",  0) or 0)
            short_liq = float(exchange_data.get("shortLiquidationUsd", 0) or 0)
            exchange  = exchange_data.get("exchangeName", "unknown")

            for side, amount in (("LONG", long_liq), ("SHORT", short_liq)):
                if amount >= LIQUIDATION_USD_THRESHOLD:
                    alerts.append(Alert(
                        title   = f"Whale Liquidation — {side}",
                        message = (
                            f"{ticker} {side} liquidation of "
                            f"${amount:,.0f} on {exchange} in the last hour"
                        ),
                        ticker   = ticker,
                        severity = Severity.CRITICAL if amount >= 5_000_000 else Severity.WARNING,
                        module   = "crypto_scanner",
                        metadata = {
                            "exchange":  exchange,
                            "side":      side,
                            "amount":    f"${amount:,.0f}",
                        },
                    ))

        return alerts

    # ── Open Interest check ───────────────────────────────────────────────────

    def _check_open_interest(self, ticker: str, base: str) -> List[Alert]:
        """Flag sudden OI spikes."""
        alerts: List[Alert] = []
        data = self._get("/open_interest", params={"symbol": base})

        if not data or not isinstance(data, list) or len(data) < 2:
            return alerts

        # CoinGlass returns time-series; compare latest two data points
        latest   = float(data[-1].get("openInterest", 0) or 0)
        previous = float(data[-2].get("openInterest", 0) or 0)

        if previous <= 0:
            return alerts

        change_pct = (latest - previous) / previous * 100

        if abs(change_pct) >= OI_SPIKE_PCT:
            direction = "increased" if change_pct > 0 else "decreased"
            alerts.append(Alert(
                title   = "Open Interest Spike",
                message = (
                    f"{ticker} OI {direction} by {abs(change_pct):.1f}% "
                    f"(${previous:,.0f} → ${latest:,.0f})"
                ),
                ticker   = ticker,
                severity = Severity.WARNING,
                module   = "crypto_scanner",
                metadata = {
                    "oi_previous": f"${previous:,.0f}",
                    "oi_latest":   f"${latest:,.0f}",
                    "change_pct":  f"{change_pct:+.1f}%",
                },
            ))

        return alerts

    # ── Funding rate check ────────────────────────────────────────────────────

    def _check_funding_rate(self, ticker: str, base: str) -> List[Alert]:
        """Flag extreme funding rates indicating over-leveraged markets."""
        alerts: List[Alert] = []
        data = self._get("/funding_rate", params={"symbol": base})

        if not data:
            return alerts

        for exchange_data in data if isinstance(data, list) else [data]:
            rate     = float(exchange_data.get("fundingRate", 0) or 0)
            exchange = exchange_data.get("exchangeName", "unknown")

            if abs(rate) >= FUNDING_RATE_EXTREME:
                bias = "LONG-heavy (short squeeze risk)" if rate > 0 else "SHORT-heavy (long squeeze risk)"
                alerts.append(Alert(
                    title   = "Extreme Funding Rate",
                    message = (
                        f"{ticker} funding rate on {exchange}: "
                        f"{rate:.4%} — market is {bias}"
                    ),
                    ticker   = ticker,
                    severity = Severity.WARNING,
                    module   = "crypto_scanner",
                    metadata = {
                        "exchange":     exchange,
                        "funding_rate": f"{rate:.4%}",
                        "bias":         bias,
                    },
                ))

        return alerts

    # ── HTTP helper ───────────────────────────────────────────────────────────

    def _get(self, endpoint: str, params: Optional[dict] = None) -> Optional[list]:
        """
        Make a GET request to the CoinGlass API.
        Returns the parsed 'data' field, or None on error.
        """
        url     = COINGLASS_BASE_URL + endpoint
        headers = {"coinglassSecret": self._api_key}
        params  = params or {}

        try:
            resp = requests.get(url, headers=headers, params=params, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            body = resp.json()
            if not body.get("success", True):
                self._log.warning(f"CoinGlass API error: {body.get('msg', 'unknown')}")
                return None
            return body.get("data")
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 401:
                self._log.error(
                    "CoinGlass returned 401 — check your COINGLASS_API_KEY."
                )
            else:
                self._log.error(f"CoinGlass HTTP error on {endpoint}: {exc}")
        except requests.RequestException as exc:
            self._log.error(f"Network error calling CoinGlass {endpoint}: {exc}")

        return None
