"""validator.py — Goal satisfaction checking (Async).

All validation rules are wrapped in try-except so that one failing rule
does not block others.  Returns ValidationResult for structured output.
"""

import logging
from urllib.parse import urlparse

from ui_navigator.types import ValidationResult, ValidatorError

logger = logging.getLogger("ui_navigator.validator")

# Action verbs and filler — never useful as goal indicators.
_FILLER = {
    "a",
    "an",
    "the",
    "to",
    "in",
    "on",
    "of",
    "and",
    "or",
    "is",
    "it",
    "open",
    "go",
    "click",
    "find",
    "navigate",
    "show",
    "view",
    "press",
    "tap",
    "select",
    "launch",
    "get",
    "see",
    "use",
    "do",
    "make",
}

_NOISE_WORDS = {
    "more",
    "about",
    "help",
    "info",
    "information",
    "here",
    "this",
    "page",
    "home",
    "contact",
    "new",
    "back",
    "next",
    "all",
    "search",
    "sign",
    "log",
    "learn",
    "read",
    "terms",
    "privacy",
    "policy",
    "example",
}

_CONTENT_SELECTORS = [
    "main",
    "[role='main']",
    "#content",
    ".content",
    "#search-results",
    ".search-results",
    "#results",
    ".results",
    "#rso",
    "article",
    ".article",
]

_SEARCH_SELECTORS = [
    "#search-results",
    ".search-results",
    "#results",
    ".results",
    "#rso",
    "#search",
    ".search",
    "[data-search-results]",
    "main",
    "[role='main']",
]


def _tokenize_goal(goal: str) -> list[str]:
    return [w for w in goal.lower().split() if len(w) > 1 and w not in _FILLER]


async def _extract_content(page, max_chars: int = 2000) -> str:
    for sel in _CONTENT_SELECTORS:
        try:
            loc = page.locator(sel).first
            if await loc.is_visible(timeout=500):
                text = await loc.inner_text()
                text = text.strip()
                if len(text) > 50:
                    return text[:max_chars]
        except Exception:
            pass
    try:
        text = await page.inner_text("body")
        return text.strip()[:max_chars]
    except Exception:
        return ""


async def _extract_search_content(page, max_chars: int = 3000) -> str:
    for sel in _SEARCH_SELECTORS:
        try:
            loc = page.locator(sel).first
            if await loc.is_visible(timeout=500):
                text = await loc.inner_text()
                text = text.strip()
                if len(text) > 30:
                    return text[:max_chars]
        except Exception:
            pass
    try:
        text = await page.inner_text("body")
        return text.strip()[:max_chars]
    except Exception:
        return ""


def _url_path_keywords(url: str) -> list[str]:
    try:
        parsed = urlparse(url)
        segments = [s for s in parsed.path.split("/") if len(s) > 2]
        tokens = []
        for seg in segments:
            for part in seg.replace("_", "-").split("-"):
                part = part.strip().lower()
                if len(part) > 2 and part not in _NOISE_WORDS:
                    tokens.append(part)
        return tokens
    except Exception:
        return []


async def goal_satisfied(
    page,
    goal: str,
    *,
    initial_url: str | None = None,
) -> ValidationResult:
    """Check whether the current page state satisfies *goal*.

    Returns ValidationResult (never raises to caller).

    Validation rules (any one is sufficient):
      1. TITLE    — ≥ ceil(n/2) keywords, min 2.
      2. URL      — ≥ ceil(n/2) non-domain keywords.
      3. URL PATH — ≥ ceil(n/2) keywords in URL path segments.
      4. BODY     — ALL non-noise keywords in main content area (min 2).
      5. CONTENT AREA — ≥ ceil(n/2) keywords in main content area.
      6. SEARCH RESULTS — ≥ ceil(n/2) in search-results region.
    """
    try:
        return await _check_all_rules(page, goal, initial_url)
    except Exception as exc:
        logger.warning("goal_satisfied unexpected error: %s", exc)
        return ValidationResult(
            satisfied=False,
            details=f"validator error: {exc}",
        )


async def _check_all_rules(
    page,
    goal: str,
    initial_url: str | None,
) -> ValidationResult:
    keywords = _tokenize_goal(goal)
    if not keywords:
        _lprint("no usable keywords from goal", goal, False)
        return ValidationResult(satisfied=False, details="no usable keywords")

    try:
        current_url = page.url
    except Exception:
        current_url = ""

    if initial_url:
        if current_url.rstrip("/") == initial_url.rstrip("/"):
            _lprint("still on starting page", goal, False)
            return ValidationResult(satisfied=False, details="still on starting page")

    total = len(keywords)
    threshold = max(2 if total >= 2 else 1, (total + 1) // 2)

    url_exclude = set()
    if initial_url:
        for kw in keywords:
            if kw in initial_url.lower():
                url_exclude.add(kw)

    # ── 1. TITLE ─────────────────────────────────────────────────────
    try:
        title = (await page.title()).lower()
        matched = [k for k in keywords if k in title]
        if len(matched) >= threshold:
            _lprint(f'TITLE "{title}"', goal, True, matched, total, threshold)
            return ValidationResult(
                satisfied=True,
                rule_matched="TITLE",
                matched_keywords=matched,
                total_keywords=total,
                threshold=threshold,
            )
    except Exception as exc:
        logger.debug("title check failed: %s", exc)

    # ── 2. URL ───────────────────────────────────────────────────────
    try:
        url = current_url.lower()
        matched = [k for k in keywords if k in url and k not in url_exclude]
        if len(matched) >= threshold:
            _lprint(f'URL "{url}"', goal, True, matched, total, threshold)
            return ValidationResult(
                satisfied=True,
                rule_matched="URL",
                matched_keywords=matched,
                total_keywords=total,
                threshold=threshold,
            )
    except Exception as exc:
        logger.debug("url check failed: %s", exc)

    # ── 3. URL PATH SEGMENTS ─────────────────────────────────────────
    try:
        path_tokens = _url_path_keywords(current_url)
        if path_tokens:
            matched = [k for k in keywords if any(k in pt for pt in path_tokens)]
            if len(matched) >= threshold:
                _lprint(
                    f"URL PATH {path_tokens[:5]}", goal, True, matched, total, threshold
                )
                return ValidationResult(
                    satisfied=True,
                    rule_matched="URL_PATH",
                    matched_keywords=matched,
                    total_keywords=total,
                    threshold=threshold,
                )
    except Exception as exc:
        logger.debug("url path check failed: %s", exc)

    # ── 4. BODY (strict: ALL non-noise keywords) ─────────────────────
    try:
        body = (await page.inner_text("body")).lower()
        strict_kw = [k for k in keywords if k not in _NOISE_WORDS]
        if len(strict_kw) >= 2:
            matched = [k for k in strict_kw if k in body]
            if len(matched) == len(strict_kw):
                _lprint(
                    f"BODY ({len(body)} chars)",
                    goal,
                    True,
                    matched,
                    len(strict_kw),
                    len(strict_kw),
                )
                return ValidationResult(
                    satisfied=True,
                    rule_matched="BODY",
                    matched_keywords=matched,
                    total_keywords=len(strict_kw),
                    threshold=len(strict_kw),
                )
            else:
                _lprint(
                    f"BODY ({len(body)} chars)",
                    goal,
                    False,
                    matched,
                    len(strict_kw),
                    len(strict_kw),
                )
        elif len(strict_kw) == 1:
            kw = strict_kw[0]
            try:
                title = (await page.title()).lower()
                if kw in body and kw in title:
                    _lprint(f"BODY+TITLE combo '{kw}'", goal, True, [kw], 1, 1)
                    return ValidationResult(
                        satisfied=True,
                        rule_matched="BODY+TITLE",
                        matched_keywords=[kw],
                        total_keywords=1,
                        threshold=1,
                    )
            except Exception:
                pass
        else:
            _lprint("all keywords are noise", goal, False)
    except Exception as exc:
        logger.debug("body check failed: %s", exc)

    # ── 5. CONTENT AREA ──────────────────────────────────────────────
    try:
        content = await _extract_content(page)
        if content:
            content_low = content.lower()
            matched = [k for k in keywords if k in content_low]
            if len(matched) >= threshold:
                _lprint(
                    f"CONTENT AREA ({len(content)} chars)",
                    goal,
                    True,
                    matched,
                    total,
                    threshold,
                )
                return ValidationResult(
                    satisfied=True,
                    rule_matched="CONTENT_AREA",
                    matched_keywords=matched,
                    total_keywords=total,
                    threshold=threshold,
                )
    except Exception as exc:
        logger.debug("content check failed: %s", exc)

    # ── 6. SEARCH RESULTS ────────────────────────────────────────────
    try:
        search_content = await _extract_search_content(page)
        if search_content:
            sc_low = search_content.lower()
            matched = [k for k in keywords if k in sc_low]
            if len(matched) >= threshold:
                _lprint(
                    f"SEARCH RESULTS ({len(search_content)} chars)",
                    goal,
                    True,
                    matched,
                    total,
                    threshold,
                )
                return ValidationResult(
                    satisfied=True,
                    rule_matched="SEARCH_RESULTS",
                    matched_keywords=matched,
                    total_keywords=total,
                    threshold=threshold,
                )
    except Exception as exc:
        logger.debug("search results check failed: %s", exc)

    _lprint("all checks", goal, False, [], total, threshold)
    return ValidationResult(
        satisfied=False,
        total_keywords=total,
        threshold=threshold,
        details="no rule satisfied",
    )


def _lprint(
    source: str,
    goal: str,
    result: bool,
    matched: list[str] | None = None,
    total: int = 0,
    threshold: int = 0,
) -> None:
    if result:
        print(
            f"[validator] ✅ goal satisfied via {source} — "
            f"matched {matched} ({len(matched)}/{total}, need {threshold})"
        )
    else:
        detail = ""
        if matched is not None:
            detail = f" — matched {matched} ({len(matched)}/{total}, need {threshold})"
        print(f"[validator] ❌ goal NOT satisfied: {source}{detail}")
