"""
Alert system with Telegram push notifications.

Usage:
    from utils.alerts import Alert, Severity
    alert = Alert(
        title="Unusual Options Activity",
        message="AAPL IV spike: 45% → 82% in 15 min",
        ticker="AAPL",
        severity=Severity.CRITICAL,
    )
    alert.send_telegram(bot_token, chat_id)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import List, Optional

import requests


# ── Severity levels ───────────────────────────────────────────────────────────

class Severity(Enum):
    INFO     = "INFO"
    WARNING  = "WARNING"
    CRITICAL = "CRITICAL"


_SEVERITY_EMOJI = {
    Severity.INFO:     "ℹ️",
    Severity.WARNING:  "⚠️",
    Severity.CRITICAL: "🚨",
}

_SEVERITY_LABEL = {
    Severity.INFO:     "Info",
    Severity.WARNING:  "Warning",
    Severity.CRITICAL: "CRITICAL",
}


# ── Alert dataclass ───────────────────────────────────────────────────────────

@dataclass
class Alert:
    """
    A single scanner alert.

    Attributes:
        title:     Short headline, e.g. "Unusual Options Activity".
        message:   Detailed description of the signal.
        ticker:    The instrument this alert relates to (e.g. "AAPL").
        severity:  Severity.INFO | Severity.WARNING | Severity.CRITICAL
        module:    Name of the scanner module that generated the alert.
        timestamp: UTC ISO-8601 string; auto-set on creation.
        metadata:  Arbitrary key/value pairs for extra context.
    """

    title:     str
    message:   str
    ticker:    str                  = ""
    severity:  Severity             = Severity.INFO
    module:    str                  = ""
    timestamp: str                  = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata:  dict                 = field(default_factory=dict)

    # ── Formatting ────────────────────────────────────────────────────────────

    def format(self) -> str:
        """Return a human-readable, emoji-decorated string representation."""
        emoji  = _SEVERITY_EMOJI[self.severity]
        label  = _SEVERITY_LABEL[self.severity]
        ts     = self.timestamp[:19].replace("T", " ") + " UTC"
        ticker = f"  📌 Ticker:   {self.ticker}\n" if self.ticker else ""
        module = f"  🔧 Module:   {self.module}\n" if self.module else ""

        lines = [
            f"{emoji} [{label}] {self.title}",
            "─" * 40,
            f"  {self.message}",
            ticker.rstrip("\n"),
            module.rstrip("\n"),
            f"  🕐 Time:     {ts}",
        ]

        if self.metadata:
            lines.append("  📊 Details:")
            for k, v in self.metadata.items():
                lines.append(f"     • {k}: {v}")

        return "\n".join(line for line in lines if line)

    # ── Telegram ──────────────────────────────────────────────────────────────

    def send_telegram(
        self,
        bot_token: str,
        chat_id: str,
        *,
        retries: int = 3,
        retry_delay: float = 2.0,
    ) -> bool:
        """
        Send this alert to a Telegram chat.

        Returns True on success, False if all retries are exhausted.
        Raises ValueError if bot_token or chat_id are empty.
        """
        if not bot_token or not chat_id:
            raise ValueError(
                "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set "
                "before calling send_telegram()."
            )

        url     = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = {
            "chat_id":    chat_id,
            "text":       self.format(),
            "parse_mode": "HTML",
        }

        for attempt in range(1, retries + 1):
            try:
                resp = requests.post(url, json=payload, timeout=10)
                if resp.status_code == 200:
                    return True
                # Telegram rate-limit: back off and retry
                if resp.status_code == 429:
                    retry_after = resp.json().get("parameters", {}).get("retry_after", retry_delay)
                    time.sleep(float(retry_after))
                    continue
                # Any other non-200 is a hard failure
                return False
            except requests.RequestException:
                if attempt < retries:
                    time.sleep(retry_delay)

        return False


# ── Batch helper ──────────────────────────────────────────────────────────────

def send_batch(
    alerts: List[Alert],
    bot_token: str,
    chat_id: str,
    *,
    min_severity: Severity = Severity.INFO,
    delay_between: float = 0.5,
) -> int:
    """
    Send a list of alerts to Telegram, filtering by minimum severity.

    Severity order: INFO < WARNING < CRITICAL

    Args:
        alerts:         List of Alert objects to send.
        bot_token:      Telegram bot token.
        chat_id:        Telegram chat ID.
        min_severity:   Only send alerts at or above this severity level.
        delay_between:  Seconds to wait between messages (avoids rate-limiting).

    Returns:
        Number of alerts successfully sent.
    """
    _ORDER = {Severity.INFO: 0, Severity.WARNING: 1, Severity.CRITICAL: 2}
    threshold = _ORDER[min_severity]

    sent = 0
    for alert in alerts:
        if _ORDER[alert.severity] >= threshold:
            ok = alert.send_telegram(bot_token, chat_id)
            if ok:
                sent += 1
            if delay_between > 0:
                time.sleep(delay_between)

    return sent
