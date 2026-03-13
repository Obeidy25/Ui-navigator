"""logger.py — Structured JSON telemetry for Phoenix.

A simple structured logger that writes JSON lines to runs/telemetry.jsonl
for Elasticsearch/Datadog integration, without breaking human readable stdout.
"""

import json
import logging
import os
from datetime import datetime

os.makedirs("runs", exist_ok=True)


class JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_obj = {
            "timestamp": datetime.fromtimestamp(record.created).isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "module": record.module,
            "msg": record.getMessage(),
        }
        if hasattr(record, "step"):
            log_obj["step"] = record.step

        if record.exc_info:
            log_obj["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_obj)


_handler = logging.FileHandler("runs/telemetry.jsonl", encoding="utf-8")
_handler.setFormatter(JSONFormatter())


def get_telemetry_logger(name: str) -> logging.Logger:
    """Returns a logger that writes NO to stdout, only to telemetry.jsonl."""
    logger = logging.getLogger(f"telemetry.{name}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        logger.addHandler(_handler)
    return logger
