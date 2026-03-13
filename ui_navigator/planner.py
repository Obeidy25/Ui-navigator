"""planner.py — Action planning for Phoenix UI Navigator.

Provides both AI-driven zero-shot planning (via Gemini Vision)
and deterministic heuristic planning (via OCR matching).
"""

import logging
from ui_navigator.types import Plan, Action
from ui_navigator.vision import generate_zero_shot_plan

logger = logging.getLogger("ui_navigator.planner")


async def build_plan(
    goal: str, image_path: str, ocr_text: str = "", api_key: str = ""
) -> Plan:
    """Build an action plan for the given goal.

    If api_key is provided, uses Gemini Vision for zero-shot planning.
    Otherwise, falls back to heuristic matching based on OCR text.
    """
    if api_key:
        logger.info("planner: generating zero-shot plan via Gemini Vision")
        return await generate_zero_shot_plan(image_path, goal, api_key=api_key)

    logger.info("planner: no API key provided, using heuristic rules")
    return _build_heuristic_plan(goal, ocr_text)


def _build_heuristic_plan(goal: str, ocr_text: str) -> Plan:
    """Deterministic planning based on string matching."""
    preview = "\n".join([l for l in ocr_text.splitlines() if l.strip()][:20])
    g = goal.lower().strip()
    actions: list[Action] = []

    # ── "settings" specialisation ────────────────────────────────────
    settings_hit = _has_any(ocr_text, ["Settings", "Preferences", "Options", "⚙"])

    if "settings" in g and settings_hit:
        actions.append(Action(type="click_text", target=settings_hit))
        actions.append(Action(type="wait", target="1s"))
        return Plan(goal=goal, extracted_ui_text_preview=preview, actions=actions)

    if "settings" in g:
        menu_hit = _has_any(ocr_text, ["Menu", "☰", "More", "Options"])
        if menu_hit:
            actions.append(Action(type="click_text", target=menu_hit))
        else:
            actions.append(Action(type="click_text", target="Menu"))
        actions.append(Action(type="wait", target="1s"))
        actions.append(Action(type="click_text", target="Settings"))
        actions.append(Action(type="wait", target="1s"))
        return Plan(goal=goal, extracted_ui_text_preview=preview, actions=actions)

    # ── generic goal handling ────────────────────────────────────────
    keywords = _extract_goal_keywords(goal)

    if keywords:
        matched_kw = _find_best_match(ocr_text, keywords)
        if matched_kw:
            actions.append(Action(type="click_text", target=matched_kw))
            actions.append(Action(type="wait", target="1s"))
        else:
            for kw in keywords:
                actions.append(Action(type="click_text", target=kw))
                actions.append(Action(type="wait", target="0.5s"))

        return Plan(goal=goal, extracted_ui_text_preview=preview, actions=actions)

    # ── absolute fallback ────────────────────────────────────────────
    actions.append(Action(type="wait", target="1s"))
    return Plan(goal=goal, extracted_ui_text_preview=preview, actions=actions)


# ── Internal Heuristic Helpers ─────────────────────────────────────


def _has_any(text: str, keywords: list[str]) -> str | None:
    t = text.lower()
    for k in keywords:
        if k.lower() in t:
            return k
    return None


def _extract_goal_keywords(goal: str) -> list[str]:
    _VERBS = {
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
        "to",
        "the",
        "a",
        "an",
    }
    words = goal.strip().split()
    return [w for w in words if w.lower() not in _VERBS]


def _find_best_match(ocr_text: str, keywords: list[str]) -> str | None:
    t = ocr_text.lower()
    for kw in keywords:
        if kw.lower() in t:
            return kw
    return None
