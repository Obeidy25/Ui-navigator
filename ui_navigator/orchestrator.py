"""orchestrator.py — Central coordination hub for Phoenix UI Navigator (Async).

This module is the SOLE entity responsible for coordinating:
  - executor  (browser operations)
  - gemini    (SoM content scoring)
  - validator (goal satisfaction checks)

It owns the main execution loop, replanning strategy, context guards,
circuit breaker for LLM calls, and centralized error aggregation.

Defensive Isolation guarantees
-------------------------------
- All sub-module errors are caught here and never propagate up raw.
- The LLM circuit breaker trips after CIRCUIT_FAIL_THRESHOLD consecutive
  failures and falls back to heuristic SoM scoring for CIRCUIT_COOLDOWN_S
  seconds before retrying Gemini.
- SoM failures (empty registry) are tolerated; the loop continues with
  whatever partial state is available.

No other module should directly call across the executor<->gemini<->validator
boundary — all inter-module communication goes through here.
"""

import asyncio
import os
import logging
import time
import traceback
from urllib.parse import urlparse

from playwright.async_api import async_playwright

from ui_navigator.types import (
    Plan,
    Action,
    ExecutionResult,
    ValidationResult,
    ExecutorError,
    ScorerError,
    ValidatorError,
    OrchestratorError,
)
from ui_navigator import executor
from ui_navigator.gemini import score_search_results
from ui_navigator.validator import goal_satisfied
from ui_navigator.logger import get_telemetry_logger

# ── isolated module logger ────────────────────────────────────────────
logger = logging.getLogger("ui_navigator.orchestrator")
_telem = get_telemetry_logger("orchestrator")


# ══════════════════════════════════════════════════════════════════════
# CIRCUIT BREAKER — LLM call guard
# ══════════════════════════════════════════════════════════════════════

CIRCUIT_FAIL_THRESHOLD = 3   # consecutive failures before opening
CIRCUIT_COOLDOWN_S = 60.0    # seconds the circuit stays open before retry


class CircuitBreaker:
    """Simple circuit breaker for Gemini / LLM API calls.

    States
    ------
    CLOSED  — normal operation, calls pass through.
    OPEN    — too many consecutive failures; heuristic fallback is used.
              After ``cooldown`` seconds the breaker half-opens to allow
              one probe call.  Success → CLOSED; failure → stays OPEN.

    Usage
    -----
    ::

        cb = CircuitBreaker()
        if cb.allow():
            result = some_llm_call()
            if result is None:
                cb.record_failure()
            else:
                cb.record_success()
        else:
            result = heuristic_fallback()
    """

    def __init__(
        self,
        threshold: int = CIRCUIT_FAIL_THRESHOLD,
        cooldown: float = CIRCUIT_COOLDOWN_S,
    ) -> None:
        self._threshold = threshold
        self._cooldown = cooldown
        self._failures = 0
        self._opened_at: float = 0.0
        self._state = "CLOSED"  # "CLOSED" | "OPEN" | "HALF_OPEN"

    # ── public interface ──────────────────────────────────────────────

    def allow(self) -> bool:
        """Return True if a Gemini call is permitted right now."""
        if self._state == "CLOSED":
            return True
        if self._state == "OPEN":
            if time.monotonic() - self._opened_at >= self._cooldown:
                self._state = "HALF_OPEN"
                logger.info(
                    "[CircuitBreaker] HALF_OPEN — probing Gemini after %.0fs cooldown",
                    self._cooldown,
                )
                return True
            return False
        # HALF_OPEN: allow exactly one probe
        return True

    def record_success(self) -> None:
        """Call after a successful Gemini response."""
        if self._state != "CLOSED":
            logger.info("[CircuitBreaker] CLOSED — Gemini recovered")
        self._failures = 0
        self._state = "CLOSED"

    def record_failure(self) -> None:
        """Call after a None / error response from Gemini."""
        self._failures += 1
        if self._state == "HALF_OPEN" or self._failures >= self._threshold:
            self._opened_at = time.monotonic()
            prev = self._state
            self._state = "OPEN"
            if prev != "OPEN":
                logger.warning(
                    "[CircuitBreaker] OPEN after %d consecutive failure(s). "
                    "Switching to heuristic fallback for %.0fs.",
                    self._failures,
                    self._cooldown,
                )

    @property
    def is_open(self) -> bool:
        """True while the breaker is in the OPEN state (no LLM calls)."""
        return self._state == "OPEN"


# ── module-level circuit breaker instance (shared across the run) ─────
_circuit_breaker = CircuitBreaker()


# ── keyword extraction (shared) ─────────────────────────────────────

_FILLER = {
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


def _keywords(goal: str) -> list[str]:
    return [w.lower() for w in goal.split() if w.lower() not in _FILLER and len(w) > 1]


def _log(step: int, msg: str) -> None:
    print(f"[orch:{step:02d}] {msg}")
    _telem.info(msg, extra={"step": step})


def _host(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""


# ══════════════════════════════════════════════════════════════════════
# CONTEXT GUARD
# ══════════════════════════════════════════════════════════════════════


async def _guard(page, plan: Plan) -> bool:
    """Verify that the current page matches plan origin metadata."""
    if not plan.origin_host and not plan.origin_url:
        _log(0, "⚠ no origin metadata — guard skipped")
        return True
    exp = (
        (plan.origin_host or _host(plan.origin_url or ""))
        .lower()
        .replace("www.", "", 1)
    )
    act = _host(page.url).lower().replace("www.", "", 1)
    try:
        title = (await page.title())[:80]
    except Exception:
        title = "?"
    if exp and act and exp != act:
        _log(0, f'🚫 MISMATCH: expected={exp} actual={act} title="{title}"')
        await executor.take_screenshot(page, "runs/context_mismatch.jpg", 0)
        return False
    if plan.origin_title_hint and plan.origin_title_hint.lower() not in title.lower():
        _log(0, f"⚠ title hint miss: '{plan.origin_title_hint}'")
    _log(0, f'✅ guard OK — {act} "{title}"')
    return True


# ══════════════════════════════════════════════════════════════════════
# REPLANNING (5-tier, SoM-driven, composite search)
# ══════════════════════════════════════════════════════════════════════

_NAV_HINTS = {
    "menu",
    "nav",
    "home",
    "about",
    "help",
    "explore",
    "discover",
    "browse",
    "categories",
    "sitemap",
    "directory",
    "services",
    "products",
    "contact",
    "support",
    "faq",
    "settings",
    "account",
}


async def _replan(
    page,
    goal: str,
    som: list[dict],
    failed_soms: set[int],
    failed_texts: set[str],
    cycle: int,
) -> tuple[Plan, list[dict]]:
    """5-tier replanning. Returns (plan, updated_som_registry).

    After composite search, the FIRST action is always a SNIPE click
    on the top-ranked search result link.
    """
    kw = _keywords(goal)
    query = " ".join(kw) if kw else goal

    avail = [
        e
        for e in som
        if e.get("som_id") not in failed_soms
        and e.get("text", "").lower() not in failed_texts
    ]

    # ── 1: keyword-scored (COORDINATE CLICKS) ────────────────────────
    scored = _score(avail, kw)
    if scored:
        _log(0, f"replan[1] keyword ({len(scored)} hits)")
        actions = []
        for sc, el in scored[:3]:
            _log(0, f"  SoM[{el['som_id']}] \"{el['text'][:35]}\" s={sc}")
            actions.append(executor.coord_action(el))
            actions.append(Action(type="wait", target="1s"))
        return (Plan(goal=goal, extracted_ui_text_preview="(kw)", actions=actions), som)

    # ── 2: COMPOSITE SEARCH (atomic: focus+type+Enter → new page) ───
    search_el = executor.find_search_som(avail)
    if search_el is not None:
        _log(0, f'replan[2] composite search "{query}"')
        try:
            result = await executor.search_composite(page, query, som, 0)
        except Exception as exc:
            _log(0, f"  search error: {exc}")
            result = ExecutionResult(ok=False, error_msg=str(exc))

        if result.ok:
            new_som = await executor.take_som(page, f"runs/c{cycle}_search_som.jpg", 0)
            executor.log_som(new_som, 0)

            # ── Gemini scoring guarded by circuit breaker ─────────────
            prioritized: list[dict] = []
            if _circuit_breaker.allow():
                try:
                    prioritized = score_search_results(new_som, kw)
                    if prioritized is not None:
                        _circuit_breaker.record_success()
                    else:
                        _circuit_breaker.record_failure()
                        prioritized = []
                except Exception as exc:
                    _log(0, f"  ⚠ scorer error: {exc}")
                    logger.error(
                        "[orchestrator] score_search_results raised: %s", exc
                    )
                    _circuit_breaker.record_failure()
                    prioritized = []
            else:
                # ── Heuristic fallback while circuit is OPEN ──────────
                logger.warning(
                    "[orchestrator] CircuitBreaker OPEN — using heuristic "
                    "link-scoring fallback instead of Gemini scoring"
                )
                _log(0, "  ⚠ Gemini CB open — heuristic scoring")
                prioritized = [
                    el for el in new_som
                    if el.get("tag") == "a"
                    and any(kw_word in el.get("text", "").lower() for kw_word in kw)
                    and len(el.get("text", "")) > 3
                ]

            actions = []
            if prioritized:
                _log(0, f"  content-prioritized: {len(prioritized)} results")
                top = prioritized[0]
                rs = top.get("relevance_score", 0)
                _log(
                    0,
                    f"  🎯 SNIPE SoM[{top['som_id']}] "
                    f'"{top["text"][:35]}" rel={rs}',
                )
                actions.append(executor.coord_action(top))
                actions.append(Action(type="wait", target="1.5s"))
                for el in prioritized[1:3]:
                    rs = el.get("relevance_score", 0)
                    _log(0, f"    SoM[{el['som_id']}] \"{el['text'][:35]}\" rel={rs}")
                    actions.append(executor.coord_action(el))
                    actions.append(Action(type="wait", target="1s"))
            else:
                clickable = [
                    e
                    for e in new_som
                    if e.get("tag") == "a"
                    and len(e.get("text", "")) > 3
                    and e.get("text", "").lower() not in failed_texts
                ]
                if clickable:
                    _log(
                        0, f"  snipe fallback: first link SoM[{clickable[0]['som_id']}]"
                    )
                    actions.append(executor.coord_action(clickable[0]))
                    actions.append(Action(type="wait", target="1.5s"))
                for el in clickable[1:3]:
                    actions.append(executor.coord_action(el))
                    actions.append(Action(type="wait", target="1s"))

            if not actions:
                actions.append(Action(type="wait", target="1s"))

            return (
                Plan(
                    goal=goal,
                    extracted_ui_text_preview="(search-results)",
                    actions=actions,
                ),
                new_som,
            )

    # ── 3: navigation ───────────────────────────────────────────────
    nav = [
        e
        for e in avail
        if 2 <= len(e.get("text", "")) <= 50
        and (
            set(e.get("text", "").lower().split()) & _NAV_HINTS
            or e.get("href", "").startswith(("/", "#"))
        )
    ]
    if nav:
        _log(0, f"replan[3] nav ({len(nav)} links)")
        actions = []
        for el in nav[:3]:
            actions.append(executor.coord_action(el))
            actions.append(Action(type="wait", target="1s"))
        return (
            Plan(goal=goal, extracted_ui_text_preview="(nav)", actions=actions),
            som,
        )

    # ── 4: scroll + fresh SoM ───────────────────────────────────────
    _log(0, "replan[4] scroll")
    try:
        await page.evaluate("window.scrollBy(0, window.innerHeight)")
        await asyncio.sleep(1.0)
        new_som = await executor.take_som(page, f"runs/c{cycle}_scroll_som.jpg", 0)
        new_avail = [
            e for e in new_som if e.get("text", "").lower() not in failed_texts
        ]
        new_scored = _score(new_avail, kw)
        if new_scored:
            actions = []
            for _, el in new_scored[:3]:
                actions.append(executor.coord_action(el))
                actions.append(Action(type="wait", target="1s"))
            return (
                Plan(goal=goal, extracted_ui_text_preview="(scroll)", actions=actions),
                new_som,
            )
    except Exception:
        pass

    # ── 5: broad exploration ─────────────────────────────────────────
    if avail:
        step_size = max(1, len(avail) // 3)
        picks = [avail[i] for i in range(0, len(avail), step_size)][:3]
        _log(0, f"replan[5] broad ({len(picks)})")
        actions = []
        for el in picks:
            actions.append(executor.coord_action(el))
            actions.append(Action(type="wait", target="1s"))
        return (
            Plan(goal=goal, extracted_ui_text_preview="(broad)", actions=actions),
            som,
        )

    # ── last resort ──────────────────────────────────────────────────
    _log(0, "replan: keyboard fallback")
    return (
        Plan(
            goal=goal,
            extracted_ui_text_preview="(keyboard)",
            actions=[
                Action(type="press_key", key="Tab"),
                Action(type="type_text", text=query),
                Action(type="press_key", key="Enter"),
                Action(type="wait", target="2s"),
            ],
        ),
        som,
    )


def _score(elements: list[dict], kw: list[str]) -> list[tuple[int, dict]]:
    scored = []
    for el in elements:
        blob = " ".join(
            [
                el.get("text", ""),
                el.get("aria_label", ""),
                el.get("title_attr", ""),
                el.get("href", ""),
            ]
        ).lower()
        total = sum(1 for k in kw if k in blob) + len(set(blob.split()) & set(kw))
        if total > 0:
            scored.append((total, el))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored


# ══════════════════════════════════════════════════════════════════════
# MAIN EXECUTION LOOP
# ══════════════════════════════════════════════════════════════════════


async def run(
    plan: Plan,
    start_url: str,
    headless: bool = False,
    *,
    max_cycles: int = 3,
    ignore_https_errors: bool = True,
    record_video: bool = False,
    enable_tracing: bool = False,
    run_id: str = "",
) -> None:
    """Execute a plan by coordinating executor, gemini, and validator.

    Defensive Isolation
    --------------------
    - Sub-module errors are caught and logged; they never crash the run.
    - LLM calls are guarded by ``_circuit_breaker``.
    - Empty SoM results (take_som returning []) are tolerated gracefully.
    - Browser crashes trigger automatic recovery before continuing.

    This is the single entry point for plan execution.
    """
    # Reset circuit breaker state at the start of each run
    global _circuit_breaker
    _circuit_breaker = CircuitBreaker()
    executor.set_run_id(run_id)
    logger.info(f"[orchestrator] run() started (run_id={run_id}) — circuit breaker reset")
    os.makedirs("runs", exist_ok=True)
    errors: list[str] = []  # centralized error log

    pw = await async_playwright().start()
    browser = None

    try:
        # ── Launch ───────────────────────────────────────────────────
        try:
            browser, ctx, page = await executor.launch_browser(
                pw,
                headless,
                ignore_https_errors=ignore_https_errors,
                record_video=record_video,
                enable_tracing=enable_tracing,
            )
        except ExecutorError as exc:
            _log(99, f"❌ launch failed: {exc}")
            errors.append(f"LAUNCH: {exc}")
            raise OrchestratorError("cannot launch browser") from exc

        # ── Navigate to start_url ────────────────────────────────────
        nav_result = await executor.navigate(page, start_url)
        if nav_result.fatal:
            errors.append(f"NAV: {nav_result.error_msg}")
            raise OrchestratorError("initial navigation fatal")

        initial_url = page.url
        last_url = initial_url
        cur = plan
        f_texts: set[str] = set()
        f_soms: set[int] = set()
        
        # ── Stall Detection state ────────────────────────────────────
        consecutive_stalls = 0
        last_state_hash = ""

        await executor.save_session(page)

        # ── Initial SoM ─────────────────────────────────────────────
        som = await executor.take_som(page, "runs/initial_som.jpg", 0)
        executor.log_som(som, 0)

        # ── Context guard ────────────────────────────────────────────
        if not await _guard(page, cur):
            _log(0, "🔄 mismatch → replan")
            cur, som = await _replan(page, cur.goal, som, f_soms, f_texts, 0)
            _log(0, f"replanned: {len(cur.actions)} | {cur.extracted_ui_text_preview}")

        # ── Cycles ───────────────────────────────────────────────────
        val = ValidationResult(satisfied=False)
        cycle = 1
        while cycle <= max_cycles:
            _log(0, f"═══ Cycle {cycle}/{max_cycles} ═══")
            _log(0, f'goal: "{cur.goal}"  actions: {len(cur.actions)}')

            for i, action in enumerate(cur.actions, start=1):

                # ── Crash guard ──────────────────────────────────────
                if not executor.page_ok(page):
                    _log(i, "💥 browser closed — recovering")
                    errors.append(f"CRASH at cycle {cycle} step {i}")
                    await executor.close_browser(browser, ctx)
                    try:
                        browser, ctx, page = await executor.recover_browser(
                            pw,
                            last_url,
                            headless,
                            ignore_https_errors=ignore_https_errors,
                            record_video=record_video,
                            enable_tracing=enable_tracing,
                        )
                        som = await executor.take_som(
                            page, f"runs/c{cycle}_recover.jpg", i
                        )
                    except ExecutorError as e:
                        _log(99, f"❌ recovery fail: {e}")
                        errors.append(f"RECOVERY: {e}")
                        _report_errors(errors)
                        return

                # ── Execute action ───────────────────────────────────
                result = await executor.exec_action(page, action, i, som)

                if result.fatal:
                    _log(i, f"💥 fatal: {result.error_msg}")
                    errors.append(f"FATAL at c{cycle}s{i}: {result.error_msg}")
                    await executor.close_browser(browser, ctx)
                    try:
                        browser, ctx, page = await executor.recover_browser(
                            pw,
                            last_url,
                            headless,
                            ignore_https_errors=ignore_https_errors,
                            record_video=record_video,
                            enable_tracing=enable_tracing,
                        )
                        som = await executor.take_som(
                            page, f"runs/c{cycle}_recover.jpg", i
                        )
                    except ExecutorError:
                        _log(99, "❌ unrecoverable")
                        errors.append("UNRECOVERABLE")
                        _report_errors(errors)
                        return
                    continue

                # ── Track state ──────────────────────────────────────
                try:
                    last_url = page.url
                except Exception:
                    pass

                if not result.ok:
                    if action.type == "click_text" and action.target:
                        f_texts.add(action.target.lower())
                    if action.type == "click_som" and action.som_id is not None:
                        f_soms.add(action.som_id)
                    if result.error_msg:
                        errors.append(f"c{cycle}s{i}: {result.error_msg}")

                if result.ok:
                    await executor.save_session(page)

                # ── Post-action SoM refresh ──────────────────────────
                som = await executor.take_som(
                    page, f"runs/c{cycle}_s{i:02d}_som.jpg", i
                )

                # ── Goal check ───────────────────────────────────────
                if result.ok:
                    try:
                        # Ensure to await validation since validator might get async later
                        val = await goal_satisfied(
                            page, cur.goal, initial_url=initial_url
                        )
                    except Exception as exc:
                        _log(i, f"⚠ validator error: {exc}")
                        errors.append(f"VALIDATOR: {exc}")
                        val = ValidationResult(satisfied=False, details=str(exc))

                    if val.satisfied:
                        _log(i, f"🎯 GOAL ACHIEVED via {val.rule_matched}")
                        await executor.take_screenshot(
                            page, f"runs/c{cycle}_goal.jpg", i
                        )
                        _report_errors(errors)
                        return

            # ── End of cycle ─────────────────────────────────────────
            _log(0, "Goal not achieved")
            
            # ── Stall check ──────────────────────────────────────────
            current_state_hash = f"{page.url}|{len(som)}"
            if current_state_hash == last_state_hash:
                consecutive_stalls += 1
                _log(0, f"⚠ STALL DETECTED: State identical for {consecutive_stalls} cycle(s)")
            else:
                consecutive_stalls = 0
                last_state_hash = current_state_hash

            if consecutive_stalls >= 2 and cycle < max_cycles:
                _log(0, "🛑 Repeated stall. Forcing broad exploration or HITL...")
                # We artificially advance the cycle to prompt broad exploration or hit max
                cycle = max(cycle, 4) 

            if cycle < max_cycles:
                await asyncio.sleep(2**cycle)
                som = await executor.take_som(page, f"runs/c{cycle}_replan_som.jpg", 0)
                executor.log_som(som, 0)
                cur, som = await _replan(page, cur.goal, som, f_soms, f_texts, cycle)
                _log(
                    0,
                    f"replanned: {len(cur.actions)}, "
                    f"{len(f_texts)} blacklisted | "
                    f"{cur.extracted_ui_text_preview}",
                )
            else:
                _log(
                    0,
                    "⏳ max cycles reached. Waiting for Human-in-the-Loop (HITL) hint...",
                )
                try:
                    # input() blocks the event loop, but since we're stalled it's fine for CLI.
                    # Alternatively we can use async-friendly console input if we ever daemonize.
                    hint = await asyncio.to_thread(
                        input,
                        "\n[HITL] Enter a hint (e.g. 'click login') or press Enter to abort: ",
                    )
                    hint = hint.strip()
                except (EOFError, KeyboardInterrupt):
                    hint = ""

                if hint:
                    _log(0, f"👤 User hint received: '{hint}'")
                    max_cycles += 1
                    cur.goal = hint
                    som = await executor.take_som(
                        page, f"runs/c{cycle}_hitl_som.jpg", 0
                    )
                    executor.log_som(som, 0)
                    cur, som = await _replan(
                        page, cur.goal, som, f_soms, f_texts, cycle
                    )
                    _log(0, f"replanned from hint: {len(cur.actions)}")
                else:
                    break

            cycle += 1

        if cycle > max_cycles or not val.satisfied:
            _log(99, "❌ max cycles reached or aborted")
            _report_errors(errors)

    except OrchestratorError:
        _report_errors(errors)
        raise
    except Exception as exc:
        _log(99, f"💥 {exc}")
        _log(99, traceback.format_exc())
        errors.append(f"UNEXPECTED: {exc}")
        _report_errors(errors)
        raise
    finally:
        _log(0, "closing …")
        if enable_tracing and "ctx" in locals() and ctx:
            try:
                trace_path = f"runs/{run_id}_trace.zip" if run_id else "runs/trace.zip"
                await ctx.tracing.stop(path=trace_path)
                _log(0, f"trace saved to {trace_path}")
            except Exception as e:
                _log(0, f"failed to save trace: {e}")
        await executor.close_browser(
            browser if "browser" in locals() else None,
            ctx if "ctx" in locals() else None,
        )
        try:
            await pw.stop()
        except Exception:
            pass
        _log(0, "done")


def _report_errors(errors: list[str]) -> None:
    """Print aggregated error summary if any errors were recorded."""
    if not errors:
        return
    _log(0, f"─── Error Summary ({len(errors)} issues) ───")
    for i, err in enumerate(errors, 1):
        _log(0, f"  {i}. {err}")
