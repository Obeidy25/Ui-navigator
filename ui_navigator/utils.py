"""utils.py — Google Cloud Storage upload utilities with local fallback.

Defensive Isolation guarantee
------------------------------
``upload_to_gcs`` NEVER raises.  On any failure it:
  1. Logs a WARNING with full error details.
  2. Attempts to save/keep the file locally as a fallback.
  3. Returns an empty string so the caller can continue uninterrupted.

Configuration (environment variables)
--------------------------------------
GCS_BUCKET_NAME : str
    Target GCS bucket.  If unset, uploads are skipped; file stays local.
GOOGLE_APPLICATION_CREDENTIALS : str (optional)
    Path to a service-account JSON key.  Omit to use ADC / gcloud login.
"""

from __future__ import annotations

import logging
import os
import shutil
from typing import Optional

# ── module-level logger (isolated, clearly labelled) ──────────────────
logger = logging.getLogger("ui_navigator.utils")

# ── GCS client is created lazily to avoid import-time side-effects ────
_gcs_client = None


def _get_gcs_client():
    """Return a cached GCS ``storage.Client``, creating it on first call.

    Raises ``ImportError`` or ``google.auth.exceptions.DefaultCredentialsError``
    if the library is missing or credentials are not configured — the caller
    is responsible for catching these.
    """
    global _gcs_client
    if _gcs_client is None:
        from google.cloud import storage as _gcs  # type: ignore

        _gcs_client = _gcs.Client()
        logger.debug("GCS client created")
    return _gcs_client


# ── local fallback directory (matches executor's "runs/" convention) ──
_LOCAL_FALLBACK_DIR = "runs/gcs_fallback"


def _ensure_local_fallback(local_path: str) -> str:
    """Copy *local_path* into the fallback dir; return the copy path."""
    os.makedirs(_LOCAL_FALLBACK_DIR, exist_ok=True)
    dest = os.path.join(_LOCAL_FALLBACK_DIR, os.path.basename(local_path))
    try:
        if os.path.abspath(local_path) != os.path.abspath(dest):
            shutil.copy2(local_path, dest)
        logger.info("Local fallback saved: %s", dest)
    except Exception as copy_exc:
        logger.warning("Local fallback copy failed: %s", copy_exc)
    return dest


def upload_to_gcs(
    local_path: str,
    destination_blob: Optional[str] = None,
) -> str:
    """Upload *local_path* to GCS and return its public HTTPS URL.

    Defensive Isolation
    -------------------
    - Never raises.
    - Falls back to local copy on any error.
    - Returns ``""`` when ``GCS_BUCKET_NAME`` is not set or upload fails.

    Parameters
    ----------
    local_path:
        Path to the file to upload (absolute or relative).
    destination_blob:
        Object name in the bucket.  Defaults to
        ``phoenix/<basename(local_path)>``.

    Returns
    -------
    str
        Public GCS URL on success, otherwise ``""``.
    """
    bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()

    # ── GCS disabled — stay local, nothing to do ──────────────────────
    if not bucket_name:
        logger.debug(
            "GCS_BUCKET_NAME not configured — skipping upload for: %s", local_path
        )
        return ""

    # ── Source file must exist ────────────────────────────────────────
    if not os.path.isfile(local_path):
        logger.warning("upload_to_gcs: source file not found: %s", local_path)
        return ""

    blob_name = destination_blob or f"phoenix/{os.path.basename(local_path)}"

    try:
        client = _get_gcs_client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        blob.upload_from_filename(local_path)
        blob.make_public()
        url = f"https://storage.googleapis.com/{bucket_name}/{blob_name}"
        logger.info("GCS ✓ uploaded %s → %s", local_path, url)
        return url

    except Exception as exc:
        # ── Graceful degradation: log + local fallback ────────────────
        logger.warning(
            "GCS upload failed for '%s' (bucket=%s blob=%s): %s — "
            "falling back to local copy.",
            local_path,
            bucket_name,
            blob_name,
            exc,
        )
        _ensure_local_fallback(local_path)
        return ""


def upload_log_to_gcs(log_text: str, blob_name: str) -> str:
    """Upload an in-memory log string to GCS.

    Parameters
    ----------
    log_text:
        UTF-8 text content to upload.
    blob_name:
        Object name inside the bucket (e.g. ``phoenix/logs/run.log``).

    Returns
    -------
    str
        Public GCS URL on success, otherwise ``""``.
        Never raises.
    """
    bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not bucket_name:
        logger.debug("GCS_BUCKET_NAME not set — log upload skipped")
        return ""

    try:
        client = _get_gcs_client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        blob.upload_from_string(log_text, content_type="text/plain; charset=utf-8")
        blob.make_public()
        url = f"https://storage.googleapis.com/{bucket_name}/{blob_name}"
        logger.info("GCS ✓ log uploaded → %s", url)
        return url
    except Exception as exc:
        logger.warning("GCS log upload failed (blob=%s): %s", blob_name, exc)
        return ""
