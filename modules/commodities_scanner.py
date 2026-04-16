"""
COMEX / COT Commodities Scanner — powered by the NASDAQ Data Link API.

Detects positioning changes in commodity futures markets by analysing:
  • CFTC Commitment of Traders (COT) reports — net speculative positioning
  • Significant week-over-week shifts in commercial vs non-commercial positions
  • Extreme net-long / net-short readings (contrarian signals)

Usage:
    from modules.commodities_scanner import CommoditiesScanner
    scanner = CommoditiesScanner(config, logger)
    alerts  = scanner.scan()              # all tickers from config
    alerts  = scanner.scan(ticker="GC=F") # single ticker override
"""

from __future__ import annotations

from typing import Dict, List, Optional

import requests

from utils.alerts import Alert, Severity


# ── Thresholds ────────────────────────────────────────────────────────────────

# Flag if net speculative position changed by more than this % week-over-week
NET_POSITION_CHANGE_PCT = 15.0

# Flag if net speculative position is in the top/bottom X% of its 52-week range
EXTREME_PERCENTILE = 10.0   # bottom 10% or top 90%

NASDAQ_BASE_URL    = "https://data.nasdaq.com/api/v3"
REQUEST_TIMEOUT    = 10

# Map from ticker symbol to NASDAQ Data Link COT dataset code.
# CFTC COT data is available via the CFTC dataset on NASDAQ Data Link.
# Format: CFTC/{COMMODITY_CODE}_FO_ALL  (Futures Only, All)
_COT_DATASET_MAP: Dict[str, str] = {
    "GC=F":  "CFTC/088691_F_ALL",   # Gold
    "SI=F":  "CFTC/084691_F_ALL",   # Silver
    "CL=F":  "CFTC/067651_F_ALL",   # Crude Oil (WTI)
    "NG=F":  "CFTC/023651_F_ALL",   # Natural Gas
    "HG=F":  "CFTC/085692_F_ALL",   # Copper
    "ZC=F":  "CFTC/002602_F_ALL",   # Corn
    "ZW=F":  "CFTC/001602_F_ALL",   # Wheat
    "ZS=F":  "CFTC/005602_F_ALL",   # Soybeans
}


class CommoditiesScanner:
    """
    Scans commodity futures markets for COT positioning changes.

    Args:
        config: Config module with NASDAQ_DATA_API_KEY and COMMODITIES_TICKERS.
        logger: A utils.logger.Logger instance.
    """

    def __init__(self, config, logger) -> None:
        self._config  = config
        self._log     = logger
        self._api_key = getattr(config, "NASDAQ_DATA_API_KEY", "")

        if not self._api_key:
            self._log.warning(
                "NASDAQ_DATA_API_KEY is not set — commodities scanner will return no data."
            )

    # ── Public API ────────────────────────────────────────────────────────────

    def scan(self, ticker: Optional[str] = None) -> List[Alert]:
        """
        Run the commodities COT scan.

        Args:
            ticker: If provided, scan only this ticker (e.g. "GC=F" for Gold).
                    Otherwise scan all tickers in config.COMMODITIES_TICKERS.

        Returns:
            List of Alert objects for any notable positioning changes.
        """
        tickers = [ticker] if ticker else list(self._config.COMMODITIES_TICKERS)
        alerts: List[Alert] = []

        self._log.info(
            f"Commodities scan started — {len(tickers)} ticker(s): {', '.join(tickers)}"
        )

        for sym in tickers:
            try:
                sym_alerts = self._scan_ticker(sym)
                alerts.extend(sym_alerts)
                if sym_alerts:
                    self._log.success(f"{sym}: {len(sym_alerts)} alert(s) generated")
                else:
                    self._log.info(f"{sym}: no significant positioning changes detected")
            except Exception as exc:
                self._log.error(f"{sym}: scan failed — {exc}")

        self._log.info(f"Commodities scan complete — {len(alerts)} total alert(s)")
        return alerts

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _scan_ticker(self, ticker: str) -> List[Alert]:
        """Fetch COT data for *ticker* and return positioning alerts."""
        if not self._api_key:
            return []

        dataset = _COT_DATASET_MAP.get(ticker)
        if not dataset:
            self._log.warning(
                f"{ticker}: no COT dataset mapping found. "
                f"Supported tickers: {', '.join(_COT_DATASET_MAP)}"
            )
            return []

        rows = self._fetch_cot_data(dataset, ticker)
        if not rows or len(rows) < 2:
            self._log.warning(f"{ticker}: insufficient COT history returned")
            return []

        alerts: List[Alert] = []
        alerts.extend(self._check_net_position_change(ticker, rows))
        alerts.extend(self._check_extreme_positioning(ticker, rows))
        return alerts

    # ── COT analysis ──────────────────────────────────────────────────────────

    def _check_net_position_change(self, ticker: str, rows: list) -> List[Alert]:
        """
        Compare the two most recent COT reports.
        Alert if net speculative position changed by >= NET_POSITION_CHANGE_PCT.
        """
        alerts: List[Alert] = []

        latest   = rows[0]
        previous = rows[1]

        net_latest   = self._net_spec(latest)
        net_previous = self._net_spec(previous)

        if net_previous == 0:
            return alerts

        change_pct = (net_latest - net_previous) / abs(net_previous) * 100

        if abs(change_pct) >= NET_POSITION_CHANGE_PCT:
            direction = "increased" if change_pct > 0 else "decreased"
            bias      = "BULLISH" if net_latest > 0 else "BEARISH"
            alerts.append(Alert(
                title   = "COT Net Position Shift",
                message = (
                    f"{ticker} speculative net position {direction} by "
                    f"{abs(change_pct):.1f}% week-over-week "
                    f"({net_previous:+,} → {net_latest:+,} contracts). "
                    f"Current bias: {bias}."
                ),
                ticker   = ticker,
                severity = Severity.WARNING,
                module   = "commodities_scanner",
                metadata = {
                    "net_prev":   f"{net_previous:+,}",
                    "net_latest": f"{net_latest:+,}",
                    "change_pct": f"{change_pct:+.1f}%",
                    "bias":       bias,
                    "report_date": latest.get("date", ""),
                },
            ))

        return alerts

    def _check_extreme_positioning(self, ticker: str, rows: list) -> List[Alert]:
        """
        Check if the current net speculative position is at a 52-week extreme.
        Uses the last 52 weekly reports (~1 year of data).
        """
        alerts: List[Alert] = []

        net_values = [self._net_spec(r) for r in rows[:52]]
        if len(net_values) < 10:
            return alerts

        current = net_values[0]
        min_val = min(net_values)
        max_val = max(net_values)
        rng     = max_val - min_val

        if rng == 0:
            return alerts

        percentile = (current - min_val) / rng * 100

        if percentile <= EXTREME_PERCENTILE:
            alerts.append(Alert(
                title   = "Extreme Bearish COT Positioning",
                message = (
                    f"{ticker} speculative net position ({current:+,} contracts) "
                    f"is in the bottom {percentile:.0f}% of its 52-week range "
                    f"({min_val:+,} to {max_val:+,}). "
                    "Historically a contrarian BULLISH signal."
                ),
                ticker   = ticker,
                severity = Severity.CRITICAL,
                module   = "commodities_scanner",
                metadata = {
                    "net_current":  f"{current:+,}",
                    "52w_min":      f"{min_val:+,}",
                    "52w_max":      f"{max_val:+,}",
                    "percentile":   f"{percentile:.0f}%",
                    "signal":       "Contrarian BULLISH",
                },
            ))
        elif percentile >= (100 - EXTREME_PERCENTILE):
            alerts.append(Alert(
                title   = "Extreme Bullish COT Positioning",
                message = (
                    f"{ticker} speculative net position ({current:+,} contracts) "
                    f"is in the top {100 - percentile:.0f}% of its 52-week range "
                    f"({min_val:+,} to {max_val:+,}). "
                    "Historically a contrarian BEARISH signal."
                ),
                ticker   = ticker,
                severity = Severity.CRITICAL,
                module   = "commodities_scanner",
                metadata = {
                    "net_current":  f"{current:+,}",
                    "52w_min":      f"{min_val:+,}",
                    "52w_max":      f"{max_val:+,}",
                    "percentile":   f"{percentile:.0f}%",
                    "signal":       "Contrarian BEARISH",
                },
            ))

        return alerts

    # ── Data fetching ─────────────────────────────────────────────────────────

    def _fetch_cot_data(self, dataset: str, ticker: str) -> list:
        """
        Fetch the last 52 weekly COT reports from NASDAQ Data Link.
        Returns a list of row dicts ordered newest-first, or [] on error.
        """
        url    = f"{NASDAQ_BASE_URL}/datasets/{dataset}/data.json"
        params = {
            "api_key":   self._api_key,
            "rows":      52,
            "order":     "desc",
        }

        try:
            resp = requests.get(url, params=params, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            body = resp.json()

            dataset_data = body.get("dataset_data", {})
            column_names = dataset_data.get("column_names", [])
            raw_rows     = dataset_data.get("data", [])

            if not column_names or not raw_rows:
                return []

            # Convert to list of dicts for easier access
            return [dict(zip(column_names, row)) for row in raw_rows]

        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 403:
                self._log.error(
                    f"{ticker}: NASDAQ Data Link returned 403 — "
                    "check your NASDAQ_DATA_API_KEY."
                )
            elif exc.response is not None and exc.response.status_code == 404:
                self._log.error(
                    f"{ticker}: COT dataset '{dataset}' not found on NASDAQ Data Link."
                )
            else:
                self._log.error(f"{ticker}: NASDAQ HTTP error — {exc}")
        except requests.RequestException as exc:
            self._log.error(f"{ticker}: network error fetching COT data — {exc}")

        return []

    # ── Utility ───────────────────────────────────────────────────────────────

    @staticmethod
    def _net_spec(row: dict) -> int:
        """
        Calculate net speculative (non-commercial) position from a COT row.
        Net = NonComm_Positions_Long_All - NonComm_Positions_Short_All
        Column names vary slightly by dataset; try common variants.
        """
        long_keys  = ["NonComm_Positions_Long_All",  "Noncommercial Long",  "noncomm_long"]
        short_keys = ["NonComm_Positions_Short_All", "Noncommercial Short", "noncomm_short"]

        long_val  = 0
        short_val = 0

        for k in long_keys:
            if k in row:
                long_val = int(row[k] or 0)
                break

        for k in short_keys:
            if k in row:
                short_val = int(row[k] or 0)
                break

        return long_val - short_val
