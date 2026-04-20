#!/usr/bin/env python3
"""
Python Scanner CLI — market scanner orchestrator.

Runs one or more scanner modules (options, crypto, commodities) either once
or in a continuous loop, with optional ticker override and Telegram alerting.

Examples:
    python main.py --loop --modules options,crypto --ticker BTCUSDT
    python main.py --modules commodities
    python main.py --loop
"""

import argparse
import sys
import time
from typing import List, Optional

import config
from utils.alerts import Alert, Severity, send_batch
from utils.logger import Logger

# ── Module registry ───────────────────────────────────────────────────────────
# Lazy imports so missing optional dependencies only fail for the module in use.

AVAILABLE_MODULES = ("options", "crypto", "commodities")


def _load_scanner(module_name: str, logger: Logger):
    """Instantiate and return the scanner class for *module_name*."""
    if module_name == "options":
        from modules.options_scanner import OptionsScanner
        return OptionsScanner(config, logger)

    if module_name == "crypto":
        from modules.crypto_scanner import CryptoScanner
        return CryptoScanner(config, logger)

    if module_name == "commodities":
        from modules.commodities_scanner import CommoditiesScanner
        return CommoditiesScanner(config, logger)

    raise ValueError(f"Unknown module: '{module_name}'. Choose from: {', '.join(AVAILABLE_MODULES)}")


# ── CLI argument parsing ──────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python main.py",
        description="Market scanner CLI — options, crypto, and commodities.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py                                  Run all modules once
  python main.py --loop                           Run all modules continuously
  python main.py --modules options,crypto         Run specific modules once
  python main.py --loop --modules crypto          Loop a single module
  python main.py --modules options --ticker AAPL  Override ticker for a module
  python main.py --loop --modules options,crypto --ticker BTCUSDT
        """,
    )

    parser.add_argument(
        "--loop",
        action="store_true",
        help=(
            f"Run continuously, sleeping SCAN_INTERVAL_SECONDS "
            f"(default: {config.SCAN_INTERVAL_SECONDS}s) between cycles."
        ),
    )

    parser.add_argument(
        "--modules",
        type=str,
        default=",".join(AVAILABLE_MODULES),
        metavar="MODULE[,MODULE...]",
        help=(
            f"Comma-separated list of modules to run. "
            f"Available: {', '.join(AVAILABLE_MODULES)}. "
            f"Default: all modules."
        ),
    )

    parser.add_argument(
        "--ticker",
        type=str,
        default=None,
        metavar="TICKER",
        help=(
            "Override the default ticker list for all selected modules. "
            "E.g. --ticker AAPL (options), --ticker BTCUSDT (crypto), "
            "--ticker GC=F (commodities)."
        ),
    )

    return parser.parse_args()


# ── Core scan logic ───────────────────────────────────────────────────────────

def run_scan(
    modules: List[str],
    ticker: Optional[str],
    logger: Logger,
) -> List[Alert]:
    """
    Instantiate and run each requested scanner module.

    Args:
        modules: List of module names to run.
        ticker:  Optional ticker override passed to every scanner.
        logger:  Shared Logger instance.

    Returns:
        Flat list of all Alert objects generated across all modules.
    """
    all_alerts: List[Alert] = []

    for name in modules:
        logger.info(f"{'─' * 50}")
        logger.info(f"Running module: {name.upper()}")
        logger.info(f"{'─' * 50}")

        try:
            scanner = _load_scanner(name, logger)
            alerts  = scanner.scan(ticker=ticker)
            all_alerts.extend(alerts)
        except ValueError as exc:
            logger.error(str(exc))
        except Exception as exc:
            logger.error(f"Unexpected error in {name} module: {exc}")

    return all_alerts


def dispatch_alerts(alerts: List[Alert], logger: Logger) -> None:
    """
    Send all generated alerts via Telegram (if credentials are configured).
    Logs a summary regardless.
    """
    if not alerts:
        logger.info("No alerts generated in this cycle.")
        return

    # Log every alert to console / file
    for alert in alerts:
        if alert.severity == Severity.CRITICAL:
            logger.error(f"[{alert.module}] {alert.title}: {alert.message}")
        elif alert.severity == Severity.WARNING:
            logger.warning(f"[{alert.module}] {alert.title}: {alert.message}")
        else:
            logger.info(f"[{alert.module}] {alert.title}: {alert.message}")

    logger.success(f"{len(alerts)} alert(s) generated this cycle.")

    # Telegram dispatch
    if config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID:
        logger.info("Sending alerts to Telegram...")
        sent = send_batch(
            alerts,
            config.TELEGRAM_BOT_TOKEN,
            config.TELEGRAM_CHAT_ID,
            min_severity=Severity.INFO,
        )
        logger.success(f"Telegram: {sent}/{len(alerts)} alert(s) sent.")
    else:
        logger.warning(
            "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — "
            "skipping Telegram notifications."
        )


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    args    = _parse_args()
    logger  = Logger("scanner")

    # Validate and normalise module list
    requested = [m.strip().lower() for m in args.modules.split(",") if m.strip()]
    invalid   = [m for m in requested if m not in AVAILABLE_MODULES]

    if invalid:
        logger.error(
            f"Unknown module(s): {', '.join(invalid)}. "
            f"Available: {', '.join(AVAILABLE_MODULES)}"
        )
        sys.exit(1)

    if not requested:
        logger.error("No modules specified. Use --modules options,crypto,commodities")
        sys.exit(1)

    # ── Banner ────────────────────────────────────────────────────────────────
    logger.info("═" * 58)
    logger.info("  Market Scanner CLI")
    logger.info(f"  Modules  : {', '.join(requested)}")
    logger.info(f"  Ticker   : {args.ticker or '(module defaults)'}")
    logger.info(f"  Mode     : {'LOOP every ' + str(config.SCAN_INTERVAL_SECONDS) + 's' if args.loop else 'SINGLE RUN'}")
    logger.info("═" * 58)

    # ── Run ───────────────────────────────────────────────────────────────────
    cycle = 0

    while True:
        cycle += 1

        if args.loop:
            logger.info(f"Cycle #{cycle} starting...")

        alerts = run_scan(requested, args.ticker, logger)
        dispatch_alerts(alerts, logger)

        if not args.loop:
            break

        logger.info(
            f"Cycle #{cycle} complete. "
            f"Next scan in {config.SCAN_INTERVAL_SECONDS}s — press Ctrl+C to stop."
        )

        try:
            time.sleep(config.SCAN_INTERVAL_SECONDS)
        except KeyboardInterrupt:
            logger.info("Interrupted by user. Exiting.")
            break

    logger.info("Scanner stopped.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted. Exiting.")
        sys.exit(0)
