"""gemini.py — Gemini SDK client + content prioritization helpers.

Two distinct layers are provided:

1. **GeminiClient** (top section)
   LLM-backed interface using the official ``google-generativeai`` SDK.
   Use this for zero-shot planning, action generation, and any call that
   requires a live Gemini API round-trip.

2. **Content-scoring helpers** (bottom section)
   Lightweight, deterministic functions for scoring SoM elements based
   on content relevance.  These run INSIDE the execution loop and are
   intentionally LLM-free (fast, no latency, no quota usage).

All public functions catch errors internally and return safe defaults —
they never let exceptions leak to the caller.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import google.generativeai as genai  # pip: google-generativeai
from dotenv import load_dotenv

from ui_navigator.types import ScorerError

load_dotenv()  # honour .env file for local development

logger = logging.getLogger("ui_navigator.gemini")


# ══════════════════════════════════════════════════════════════════════
# GEMINI SDK CLIENT
# ══════════════════════════════════════════════════════════════════════


class GeminiClient:
    """Thin wrapper around the google-generativeai SDK.

    Usage
    -----
    ::

        client = GeminiClient()
        reply = client.generate_text("Plan how to book a flight to Paris.")

    Environment Variables
    ---------------------
    GEMINI_API_KEY : str (required)
        Google AI Studio API key.
    GEMINI_MODEL : str (optional, default ``gemini-1.5-flash``)
        Model identifier to use for generation.
    """

    DEFAULT_MODEL = "gemini-1.5-flash"

    def __init__(self) -> None:
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. "
                "Add it to your .env file or export it as an environment variable."
            )
        genai.configure(api_key=api_key)
        model_name = os.environ.get("GEMINI_MODEL", self.DEFAULT_MODEL).strip()
        self._model = genai.GenerativeModel(model_name)
        logger.info("GeminiClient initialised (model=%s)", model_name)

    # ── public API ────────────────────────────────────────────────────

    def generate_text(self, prompt: str, *, temperature: float = 0.2) -> Optional[str]:
        """Send *prompt* to Gemini and return the response text.

        Defensive Isolation
        -------------------
        Returns ``None`` (not empty string) on any API error so callers
        (e.g. the orchestrator's circuit breaker) can distinguish a real
        failure from a legitimately empty response.

        Parameters
        ----------
        prompt:
            The instruction / question to send to the model.
        temperature:
            Sampling temperature (0 = deterministic, 1 = creative).

        Returns
        -------
        Optional[str]
            Model response text on success, ``None`` on any error.
            Never raises.
        """
        try:
            response = self._model.generate_content(
                prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=temperature,
                ),
            )
            text = response.text or ""
            
            # --- Cost Tracking ---
            try:
                usage = response.usage_metadata
                if usage:
                    # Approximation for Gemini 1.5 Flash: $0.075/1M input, $0.30/1M output
                    cost = (usage.prompt_token_count * 0.075 + usage.candidates_token_count * 0.30) / 1000000.0
                    print(f"[COST_USD] {cost:.6f}")
            except Exception:
                pass
                
            logger.debug("GeminiClient.generate_text OK (%d chars)", len(text))
            return text

        # ── Specific SDK errors (ordered most-specific first) ─────────
        except Exception as exc:
            exc_type = type(exc).__name__
            exc_str = str(exc)

            # Rate limit / quota exhausted
            if any(
                k in exc_str.lower()
                for k in ("rate", "quota", "429", "resource_exhausted")
            ):
                logger.warning(
                    "GeminiClient: rate-limit / quota error [%s]: %s",
                    exc_type,
                    exc_str,
                )
            # Auth / key problems
            elif any(
                k in exc_str.lower()
                for k in ("api_key", "permission", "unauthenticated", "401", "403")
            ):
                logger.error(
                    "GeminiClient: authentication error [%s]: %s",
                    exc_type,
                    exc_str,
                )
            # Network / timeout
            elif any(
                k in exc_str.lower()
                for k in ("timeout", "deadline", "connect", "network")
            ):
                logger.warning(
                    "GeminiClient: network/timeout error [%s]: %s",
                    exc_type,
                    exc_str,
                )
            # Catch-all for any other SDK or unexpected error
            else:
                logger.error(
                    "GeminiClient: unexpected error [%s]: %s",
                    exc_type,
                    exc_str,
                )

            # Return None so the orchestrator circuit breaker can count failures
            return None


# ══════════════════════════════════════════════════════════════════════
# CONTENT SCORING HELPERS (LLM-free, deterministic)
# ══════════════════════════════════════════════════════════════════════

logger = logging.getLogger("ui_navigator.gemini")

# ── noise elements to ignore during content scoring ──────────────────

_NOISE_TAGS = {"nav", "header", "footer", "aside"}

_NOISE_TEXT = {
    "cookie",
    "privacy",
    "terms",
    "policy",
    "copyright",
    "©",
    "sign in",
    "sign up",
    "log in",
    "log out",
    "register",
    "advertisement",
    "sponsored",
    "ad",
    "subscribe",
    "accept",
    "decline",
    "dismiss",
    "close",
}

_NAV_NOISE = {
    "home",
    "back",
    "next",
    "previous",
    "menu",
    "toggle",
    "share",
    "print",
    "save",
    "download",
    "upload",
}

_NAV_TOP_PX = 80
_NAV_BOTTOM_PX = 700


# ══════════════════════════════════════════════════════════════════════
# CONTENT AREA DETECTION
# ══════════════════════════════════════════════════════════════════════


def prioritize_content_elements(
    som_registry: list[dict],
    keywords: list[str],
    *,
    after_search: bool = False,
) -> list[dict]:
    """Filter and rank SoM elements by content relevance.

    Returns sorted list with 'relevance_score' added to each dict.
    On error, returns empty list (never raises).
    """
    try:
        return _prioritize_impl(som_registry, keywords, after_search)
    except Exception as exc:
        logger.warning("prioritize_content_elements failed: %s", exc)
        return []


def _prioritize_impl(
    som_registry: list[dict],
    keywords: list[str],
    after_search: bool,
) -> list[dict]:
    scored = []

    for el in som_registry:
        text = el.get("text", "").strip()
        text_low = text.lower()

        if len(text) < 3:
            continue
        if _is_noise(el, after_search):
            continue

        if after_search:
            bbox = el.get("bbox", {})
            y = bbox.get("y", 0)
            if y < _NAV_TOP_PX and el.get("tag") != "input":
                continue

        blob = " ".join(
            [
                text_low,
                el.get("aria_label", "").lower(),
                el.get("title_attr", "").lower(),
                el.get("href", "").lower(),
            ]
        )

        kw_set = set(keywords)
        sub_hits = sum(1 for kw in keywords if kw in blob)
        word_hits = len(set(blob.split()) & kw_set)
        score = sub_hits + word_hits

        href = el.get("href", "")
        if href and not href.startswith(("#", "javascript:")):
            score += 1
        if len(text) > 20:
            score += 1

        if after_search:
            if el.get("tag") == "a" and len(text) > 10:
                score += 2
            href_low = href.lower()
            href_kw_hits = sum(1 for kw in keywords if kw in href_low)
            if href_kw_hits > 0:
                score += href_kw_hits

        el_copy = dict(el)
        el_copy["relevance_score"] = score
        scored.append(el_copy)

    scored.sort(
        key=lambda e: (
            -e["relevance_score"],
            e.get("bbox", {}).get("y", 9999),
        )
    )
    return scored


def _is_noise(el: dict, strict: bool = False) -> bool:
    text_low = el.get("text", "").lower()
    for noise in _NOISE_TEXT:
        if noise in text_low:
            return True
    if strict:
        if text_low in _NAV_NOISE:
            return True
        if el.get("tag") == "a" and len(el.get("text", "")) <= 3:
            return True
    return False


def score_search_results(
    som_registry: list[dict],
    keywords: list[str],
) -> list[dict]:
    """Post-search content scoring. Returns empty list on error."""
    try:
        return prioritize_content_elements(som_registry, keywords, after_search=True)
    except Exception as exc:
        logger.warning("score_search_results failed: %s", exc)
        return []


def snipe_first_result(
    som_registry: list[dict],
    keywords: list[str],
) -> Optional[dict]:
    """Return the single best search-result element to click.

    Returns None on error (never raises).
    """
    try:
        scored = score_search_results(som_registry, keywords)
        for el in scored:
            if el.get("tag") == "a" and len(el.get("text", "")) > 5:
                return el
        if scored:
            return scored[0]
        return None
    except Exception as exc:
        logger.warning("snipe_first_result failed: %s", exc)
        return None


def extract_content_snippet(page, max_chars: int = 500) -> str:
    """Extract main content text from the current page.

    Returns empty string on error (never raises).
    """
    selectors = [
        "main",
        "[role='main']",
        "#content",
        ".content",
        "#search-results",
        ".search-results",
        "#results",
        ".results",
        "article",
        ".article",
    ]
    try:
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=500):
                    text = loc.inner_text().strip()
                    if len(text) > 50:
                        return text[:max_chars]
            except Exception:
                pass
        return page.inner_text("body").strip()[:max_chars]
    except Exception as exc:
        logger.warning("extract_content_snippet failed: %s", exc)
        return ""


def find_exploratory_links(
    som_registry: list[dict],
    keywords: list[str],
    failed_texts: set[str] | None = None,
) -> list[dict]:
    """Find best links for exploratory navigation.

    Returns empty list on error (never raises).
    """
    try:
        return _find_exploratory_impl(som_registry, keywords, failed_texts)
    except Exception as exc:
        logger.warning("find_exploratory_links failed: %s", exc)
        return []


def _find_exploratory_impl(
    som_registry: list[dict],
    keywords: list[str],
    failed_texts: set[str] | None,
) -> list[dict]:
    failed = failed_texts or set()
    candidates = []

    for el in som_registry:
        text = el.get("text", "").strip()
        text_low = text.lower()

        if text_low in failed or len(text) < 4:
            continue
        if _is_noise(el, strict=True):
            continue

        href = el.get("href", "")
        tag = el.get("tag", "")
        if tag not in ("a", "button") and not href:
            continue
        if href.startswith(("javascript:", "#", "mailto:")):
            continue

        blob = " ".join(
            [
                text_low,
                el.get("aria_label", "").lower(),
                el.get("title_attr", "").lower(),
                href.lower(),
            ]
        )

        kw_set = set(keywords)
        score = sum(1 for k in keywords if k in blob)
        score += len(set(blob.split()) & kw_set)

        if href and href.startswith("/"):
            score += 2
        elif href and href.startswith("http"):
            score += 1
        if len(text) > 15:
            score += 1

        el_copy = dict(el)
        el_copy["explore_score"] = score
        candidates.append(el_copy)

    candidates.sort(
        key=lambda e: (
            -e["explore_score"],
            e.get("bbox", {}).get("y", 9999),
        )
    )
    return candidates
