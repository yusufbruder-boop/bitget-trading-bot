"""
Colored console logger with rotating file output.

Usage:
    from utils.logger import Logger
    log = Logger("options_scanner")
    log.info("Scanning AAPL...")
    log.success("Alert generated for AAPL")
    log.warning("Low volume detected")
    log.error("API request failed")
"""

import logging
import sys
from datetime import datetime
from logging.handlers import RotatingFileHandler

# ── ANSI colour codes ─────────────────────────────────────────────────────────

RESET  = "\033[0m"
BOLD   = "\033[1m"
CYAN   = "\033[96m"
YELLOW = "\033[93m"
RED    = "\033[91m"
GREEN  = "\033[92m"
GREY   = "\033[90m"

LOG_FILE     = "scanner.log"
MAX_BYTES    = 5 * 1024 * 1024   # 5 MB per file
BACKUP_COUNT = 3                  # keep scanner.log, scanner.log.1, scanner.log.2


class Logger:
    """
    Thin wrapper around Python's stdlib logging that adds:
    - Coloured, emoji-prefixed console output
    - Rotating file handler writing plain text to scanner.log
    """

    def __init__(self, name: str = "scanner") -> None:
        self._logger = logging.getLogger(name)

        # Avoid adding duplicate handlers when multiple Logger instances share
        # the same underlying logger name (e.g. during tests or re-imports).
        if self._logger.handlers:
            return

        self._logger.setLevel(logging.DEBUG)

        # ── Console handler (coloured) ────────────────────────────────────────
        console = logging.StreamHandler(sys.stdout)
        console.setLevel(logging.DEBUG)
        console.setFormatter(_ColourFormatter())
        self._logger.addHandler(console)

        # ── Rotating file handler (plain text) ────────────────────────────────
        file_handler = RotatingFileHandler(
            LOG_FILE,
            maxBytes=MAX_BYTES,
            backupCount=BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(
            logging.Formatter(
                fmt="%(asctime)s  [%(levelname)-8s]  %(name)s  %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        self._logger.addHandler(file_handler)

    # ── Public API ────────────────────────────────────────────────────────────

    def info(self, message: str) -> None:
        """ℹ️  Informational message."""
        self._logger.info(message)

    def warning(self, message: str) -> None:
        """⚠️  Non-critical warning."""
        self._logger.warning(message)

    def error(self, message: str) -> None:
        """❌  Error — something went wrong."""
        self._logger.error(message)

    def success(self, message: str) -> None:
        """✅  Success — action completed or alert generated."""
        # Map to INFO level so stdlib routing works; the formatter adds the ✅.
        self._logger.info("✅ " + message)


# ── Internal formatter ────────────────────────────────────────────────────────

class _ColourFormatter(logging.Formatter):
    """Applies colour and emoji prefix based on log level."""

    _LEVEL_STYLES = {
        logging.DEBUG:   (GREY,   "·"),
        logging.INFO:    (CYAN,   "ℹ️ "),
        logging.WARNING: (YELLOW, "⚠️ "),
        logging.ERROR:   (RED,    "❌"),
        logging.CRITICAL:(RED,    "🔥"),
    }

    def format(self, record: logging.LogRecord) -> str:
        colour, emoji = self._LEVEL_STYLES.get(record.levelno, (RESET, "·"))
        ts      = datetime.fromtimestamp(record.created).strftime("%H:%M:%S")
        name    = f"{GREY}{record.name}{RESET}"
        message = record.getMessage()

        # Success messages already carry their own ✅ prefix — skip the ℹ️.
        if message.startswith("✅ "):
            emoji  = ""
            colour = GREEN

        return (
            f"{GREY}{ts}{RESET}  "
            f"{colour}{BOLD}{emoji}{RESET}  "
            f"{name}  "
            f"{colour}{message}{RESET}"
        )
