"""executor.py — Pure browser primitives for Playwright (Async).

This module contains ONLY browser interaction logic:
  - Launch / recover / close browser
  - Screenshot & SoM capture
  - Click, type, navigate, search actions
  - Session persistence

It does NOT contain orchestration, replanning, or validation logic.
All public functions return ExecutionResult for clean inter-module flow.
Playwright errors are caught internally and never leak raw.
"""

import asyncio
import io
import os
import logging
from typing import Optional
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFont
from playwright.async_api import (
    async_playwright,
    Playwright,
    Browser,
    BrowserContext,
    Page,
)

from ui_navigator.types import Action, ExecutionResult, ExecutorError
from ui_navigator.logger import get_telemetry_logger
from ui_navigator.utils import upload_to_gcs

logger = logging.getLogger("ui_navigator.executor")  # isolated module logger
_telem = get_telemetry_logger("executor")

# ── configurable timeouts (ms) ───────────────────────────────────────
T_NAV = 12_000
T_CLICK = 5_000
T_VISIBLE = 1_500
T_SCREENSHOT = 6_000
T_SCREENSHOT_RETRY = 12_000
T_SCREENSHOT_LAST = 20_000
MAX_SCREENSHOT_RETRIES = 3
MAX_SOM_ELEMENTS = 40
PW_OP_RETRIES = 2

_SESSION = "runs/_session.json"
RUN_ID_PREFIX = ""

def set_run_id(run_id: str) -> None:
    global RUN_ID_PREFIX
    RUN_ID_PREFIX = f"{run_id}_" if run_id else ""


# ══════════════════════════════════════════════════════════════════════
# HELPERS (private)
# ══════════════════════════════════════════════════════════════════════


def _log(step: int, msg: str) -> None:
    print(f"[exec:{step:02d}] {msg}")
    _telem.info(msg, extra={"step": step})


def _sleep(target: Optional[str]) -> float:
    if not target:
        return 1.0
    t = target.strip().lower().rstrip("s")
    try:
        return max(0.1, float(t))
    except ValueError:
        return 1.0


def _is_fatal(exc: Exception) -> bool:
    s = str(exc).lower()
    return "closed" in s or "disposed" in s or "target page" in s


def page_ok(page: Page) -> bool:
    """Check if the page handle is still alive."""
    try:
        _ = page.url
        return True
    except Exception:
        return False


def _host(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""


def _overlap(a: str, b: str) -> float:
    sa, sb = set(a.lower().split()), set(b.lower().split())
    return len(sa & sb) / len(sa) if sa else 0.0


async def _settle(page: Page, url0: str) -> None:
    try:
        if page.url != url0:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
            await page.wait_for_load_state("networkidle", timeout=5000)
        else:
            await asyncio.sleep(0.3)
    except Exception:
        await asyncio.sleep(0.5)


# ══════════════════════════════════════════════════════════════════════
# BROWSER LIFECYCLE
# ══════════════════════════════════════════════════════════════════════


async def launch_browser(
    pw: Playwright,
    headless: bool,
    *,
    restore: bool = False,
    ignore_https_errors: bool = True,
    record_video: bool = False,
    enable_tracing: bool = False,
) -> tuple[Browser, BrowserContext, Page]:
    """Launch Chromium with SSL bypass, session restore, tracing, and video.

    Returns (browser, context, page). Raises ExecutorError on failure.
    """
    try:
        browser = await pw.chromium.launch(headless=headless)
        kw: dict = {"ignore_https_errors": ignore_https_errors}
        if restore and os.path.isfile(_SESSION):
            kw["storage_state"] = _SESSION
            _log(0, "restoring session")

        if record_video:
            os.makedirs("runs/videos", exist_ok=True)
            kw["record_video_dir"] = "runs/videos"
            kw["record_video_size"] = {"width": 1280, "height": 720}

        ctx = await browser.new_context(**kw)

        # ── Sandboxed Execution: Request Interception ─────────────
        ALLOWED_DOMAINS = ("amazon.com", "ebay.com", "walmart.com")
        
        async def intercept_sandbox(route) -> None:
            req = route.request
            if req.resource_type in ("image", "media", "font"):
                await route.abort()
                return
            
            if req.resource_type == "document":
                host = _host(req.url)
                if host and not any(host.endswith(d) for d in ALLOWED_DOMAINS):
                    await route.abort()
                    return
            
            await route.continue_()

        await ctx.route("**/*", intercept_sandbox)

        if enable_tracing:
            await ctx.tracing.start(screenshots=True, snapshots=True, sources=True)

        _log(
            0,
            f"browser launched (ignore_https_errors={ignore_https_errors}, video={record_video}, tracing={enable_tracing})",
        )
        return browser, ctx, await ctx.new_page()
    except Exception as exc:
        raise ExecutorError(f"browser launch failed: {exc}") from exc


async def recover_browser(
    pw: Playwright,
    url: str,
    headless: bool,
    *,
    ignore_https_errors: bool = True,
    record_video: bool = False,
    enable_tracing: bool = False,
) -> tuple[Browser, BrowserContext, Page]:
    """Recover browser after crash with session + SSL handling."""
    _log(0, "🔄 recovering …")
    browser, ctx, page = await launch_browser(
        pw,
        headless,
        restore=True,
        ignore_https_errors=ignore_https_errors,
        record_video=record_video,
        enable_tracing=enable_tracing,
    )
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=T_NAV)
    except Exception as exc:
        _log(0, f"⚠ recovery goto failed: {exc}")
        try:
            await page.goto(url, timeout=T_NAV)
        except Exception:
            pass
    try:
        await page.wait_for_load_state("networkidle", timeout=T_NAV)
    except Exception:
        pass
    _log(0, "✅ recovered")
    return browser, ctx, page


async def close_browser(
    browser: Optional[Browser], ctx: Optional[BrowserContext] = None
) -> None:
    """Safely close browser and optionally save trace."""
    try:
        if ctx:
            # We don't know the exact trace name here, but the orchestrator will handle it.
            # This is just a fallback to ensure it's closed.
            await ctx.close()
        if browser:
            await browser.close()
    except Exception:
        pass


async def _save_dom_state(page: Page, base_path: str) -> None:
    """Save the current HTML DOM state to a file next to the screenshot."""
    try:
        html = await page.content()
        html_path = os.path.splitext(base_path)[0] + ".html"
        # File I/O is small enough that pure sync open/write is fine.
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html)
    except Exception as exc:
        pass  # non-critical


# ══════════════════════════════════════════════════════════════════════
# SESSION PERSISTENCE
# ══════════════════════════════════════════════════════════════════════


async def save_session(page: Page) -> None:
    """Persist cookies / storage state."""
    try:
        await page.context.storage_state(path=_SESSION)
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════════════
# NAVIGATION
# ══════════════════════════════════════════════════════════════════════


async def navigate(page: Page, url: str, step: int = 0) -> ExecutionResult:
    """Navigate to a URL. Returns ExecutionResult."""
    _log(step, f"nav -> {url}")
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=T_NAV)
    except Exception as exc:
        if _is_fatal(exc):
            return ExecutionResult(ok=False, error_msg=str(exc), fatal=True)
        _log(step, f"⚠ nav warning: {exc}")
        await asyncio.sleep(1.0)
    try:
        await page.wait_for_load_state("networkidle", timeout=T_NAV)
    except Exception:
        pass
    try:
        new_url = page.url
    except Exception:
        new_url = ""
    return ExecutionResult(ok=True, navigated=True, new_url=new_url)


# ══════════════════════════════════════════════════════════════════════
# SCREENSHOT — JPEG, aggressive retry, partial-fallback
# ══════════════════════════════════════════════════════════════════════


async def take_screenshot(page: Page, path: str, step: int = 0) -> ExecutionResult:
    """Take a screenshot with aggressive retry and quality fallback."""
    if RUN_ID_PREFIX and path.startswith("runs/"):
        dirname, basename = os.path.split(path)
        path = os.path.join(dirname, f"{RUN_ID_PREFIX}{basename}")
        
    jpg_path = os.path.splitext(path)[0] + ".jpg"
    timeouts = [T_SCREENSHOT, T_SCREENSHOT_RETRY, T_SCREENSHOT_LAST]

    for att, timeout in enumerate(timeouts[:MAX_SCREENSHOT_RETRIES], 1):
        try:
            await page.screenshot(
                path=jpg_path,
                full_page=True,
                timeout=timeout,
                type="jpeg",
                quality=80,
            )
            await _save_dom_state(page, path)
            _log(step, f"screenshot -> {jpg_path}")
            # ── GCS upload (non-blocking, best-effort) ───────────────
            gcs_url = await asyncio.to_thread(
                upload_to_gcs,
                jpg_path,
                f"phoenix/screenshots/{os.path.basename(jpg_path)}",
            )
            if gcs_url:
                _log(step, f"screenshot uploaded -> {gcs_url}")
            return ExecutionResult(ok=True)
        except Exception as exc:
            if _is_fatal(exc):
                _log(step, "⚠ screenshot skip — browser closed")
                return ExecutionResult(ok=False, error_msg="browser closed", fatal=True)
            if att < MAX_SCREENSHOT_RETRIES:
                _log(step, f"screenshot timeout (att {att}) — retry")
                await asyncio.sleep(0.3 * att)
            else:
                # Last resort: viewport-only at lower quality
                try:
                    await page.screenshot(
                        path=jpg_path,
                        full_page=False,
                        timeout=T_SCREENSHOT_LAST,
                        type="jpeg",
                        quality=50,
                    )
                    await _save_dom_state(page, path)
                    _log(step, f"screenshot (viewport-only fallback) -> {jpg_path}")
                    return ExecutionResult(ok=True)
                except Exception:
                    _log(step, f"⚠ screenshot failed after {att} attempts: {exc}")
                    _log(step, "  proceeding with last known DOM state")
                    return ExecutionResult(ok=False, error_msg=str(exc))
    return ExecutionResult(ok=False, error_msg="screenshot retries exhausted")


# ══════════════════════════════════════════════════════════════════════
# SoM (Set-of-Mark)
# ══════════════════════════════════════════════════════════════════════

_SOM_JS = """
() => {
    const sels = [
        'a','button','input','textarea','select',
        '[role="button"]','[role="link"]','[role="tab"]',
        '[role="menuitem"]','[role="searchbox"]'
    ];
    const out = [], seen = new Set();
    for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
            const r = el.getBoundingClientRect();
            if (r.width<8||r.height<8||r.bottom<0||r.right<0) continue;
            if (r.top > window.innerHeight + 50) continue;
            const k = Math.round(r.x)+','+Math.round(r.y);
            if (seen.has(k)) continue; seen.add(k);
            out.push({
                tag: el.tagName.toLowerCase(),
                type: el.getAttribute('type')||'',
                text: (el.innerText||el.getAttribute('aria-label')||
                       el.getAttribute('title')||el.getAttribute('placeholder')||
                       el.getAttribute('alt')||'').trim().substring(0,120),
                href: el.getAttribute('href')||'',
                aria_label: el.getAttribute('aria-label')||'',
                title_attr: el.getAttribute('title')||'',
                placeholder: el.getAttribute('placeholder')||'',
                name: el.getAttribute('name')||'',
                role: el.getAttribute('role')||'',
                bbox:{x:Math.round(r.x),y:Math.round(r.y),
                      w:Math.round(r.width),h:Math.round(r.height)}
            });
        }
    }
    return out;
}
"""


async def take_som(page: Page, path: str, step: int = 0) -> list[dict]:
    """Generate SoM screenshot (capped + timeout-resilient).

    Returns the SoM registry (list of element dicts).
    Catches all errors internally — never raises.
    """
    if not page_ok(page):
        logger.warning("[executor.take_som] page not OK — returning empty registry")
        return []
    try:
        elements = await page.evaluate(_SOM_JS)
    except Exception as exc:
        logger.error(
            "[executor.take_som] JS evaluation failed (step=%d): %s", step, exc
        )
        _log(step, f"⚠ SoM JS eval error: {exc}")
        return []
    if not elements:
        logger.warning(
            "[executor.take_som] JS returned empty element list (step=%d)", step
        )
        return []

    elements = elements[:MAX_SOM_ELEMENTS]
    for i, el in enumerate(elements):
        el["som_id"] = i

    if RUN_ID_PREFIX and path.startswith("runs/"):
        dirname, basename = os.path.split(path)
        path = os.path.join(dirname, f"{RUN_ID_PREFIX}{basename}")

    path = os.path.splitext(path)[0] + ".jpg"
    timeouts = [T_SCREENSHOT, T_SCREENSHOT_RETRY, T_SCREENSHOT_LAST]

    for att, timeout in enumerate(timeouts[:MAX_SCREENSHOT_RETRIES], 1):
        try:
            raw = await page.screenshot(
                full_page=False,
                timeout=timeout,
                type="jpeg",
                quality=80,
            )
            # Image ops are sync but CPU-bound, fine for now.
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            draw = ImageDraw.Draw(img)
            try:
                font = ImageFont.truetype("arial.ttf", 12)
            except Exception:
                font = ImageFont.load_default()
            pal = [
                (255, 0, 0),
                (0, 150, 0),
                (0, 0, 255),
                (255, 140, 0),
                (128, 0, 128),
                (0, 128, 128),
                (255, 20, 147),
                (0, 100, 0),
            ]
            for el in elements:
                b, c = el["bbox"], pal[el["som_id"] % len(pal)]
                draw.rectangle(
                    [b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]],
                    outline=c,
                    width=2,
                )
                lbl = str(el["som_id"])
                lx, ly = max(0, b["x"]), max(0, b["y"] - 15)
                draw.rectangle([lx, ly, lx + len(lbl) * 8 + 4, ly + 14], fill=c)
                draw.text((lx + 2, ly + 1), lbl, fill="white", font=font)
            img.save(path, "JPEG", quality=80)
            await _save_dom_state(page, path)
            _log(step, f"SoM -> {path} ({len(elements)} el)")
            # ── GCS upload (non-blocking, best-effort) ───────────────
            gcs_url = await asyncio.to_thread(
                upload_to_gcs,
                path,
                f"phoenix/som/{os.path.basename(path)}",
            )
            if gcs_url:
                _log(step, f"SoM uploaded -> {gcs_url}")
            return elements
        except Exception as exc:
            if _is_fatal(exc):
                logger.error(
                    "[executor.take_som] fatal browser error (step=%d): %s", step, exc
                )
                _log(step, "⚠ SoM skip — browser closed")
                return elements
            if att < MAX_SCREENSHOT_RETRIES:
                logger.warning(
                    "[executor.take_som] screenshot timeout attempt %d/%d (step=%d)",
                    att, MAX_SCREENSHOT_RETRIES, step,
                )
                _log(step, f"SoM screenshot timeout (att {att}) — retry")
                await asyncio.sleep(0.3 * att)
            else:
                logger.warning(
                    "[executor.take_som] all screenshot attempts exhausted (step=%d): %s "
                    "— returning registry without image",
                    step, exc,
                )
                _log(step, f"⚠ SoM draw failed (using registry only): {exc}")
                return elements

    return elements


def log_som(reg: list[dict], step: int = 0, n: int = 10) -> None:
    """Pretty-print SoM registry."""
    _log(step, f"SoM: {len(reg)} el")
    for el in reg[:n]:
        s, t, tx = el["som_id"], el["tag"], el.get("text", "")[:35]
        ex = ""
        if el.get("type"):
            ex += f" type={el['type']}"
        if el.get("placeholder"):
            ex += f' ph="{el["placeholder"][:20]}"'
        _log(step, f'  [{s:>2}] <{t}>{ex} "{tx}"')


# ══════════════════════════════════════════════════════════════════════
# COMPOSITE SEARCH — atomic focus + type + submit
# ══════════════════════════════════════════════════════════════════════


async def search_composite(
    page: Page,
    query: str,
    som: list[dict],
    step: int = 0,
) -> ExecutionResult:
    """Execute a search as ONE atomic operation.

    Returns ExecutionResult with navigated=True if search was performed.
    """
    _log(step, f'🔎 composite search: "{query}"')

    search_el = find_search_som(som)
    if search_el:
        b = search_el["bbox"]
        cx, cy = b["x"] + b["w"] // 2, b["y"] + b["h"] // 2
        try:
            await page.mouse.click(cx, cy)
            await asyncio.sleep(0.2)
            _log(step, f"  focused SoM[{search_el['som_id']}] at ({cx},{cy})")
        except Exception:
            _log(step, "  SoM bbox focus failed — trying selectors")
            if not await _focus_search_sel(page, step):
                return ExecutionResult(ok=False, error_msg="all focus methods failed")
    else:
        if not await _focus_search_sel(page, step):
            return ExecutionResult(ok=False, error_msg="no search input found")

    try:
        await page.keyboard.press("Control+a")
        await asyncio.sleep(0.1)
        await page.keyboard.type(query, delay=30)
        await asyncio.sleep(0.2)
        _log(step, f'  typed "{query}"')

        url_before = page.url
        await page.keyboard.press("Enter")
        _log(step, "  pressed Enter")

        try:
            await page.wait_for_load_state("domcontentloaded", timeout=6000)
            await page.wait_for_load_state("networkidle", timeout=6000)
        except Exception:
            await asyncio.sleep(1.5)

        new_url = page.url
        navigated = new_url != url_before
        if navigated:
            _log(step, f"  navigated → {new_url[:60]}")
        else:
            _log(step, "  page updated (same URL)")

        return ExecutionResult(ok=True, navigated=navigated, new_url=new_url)

    except Exception as exc:
        if _is_fatal(exc):
            return ExecutionResult(ok=False, error_msg=str(exc), fatal=True)
        _log(step, f"  search input error: {exc}")
        return ExecutionResult(ok=False, error_msg=str(exc))


def find_search_som(registry: list[dict]) -> Optional[dict]:
    """Find a search input in the SoM registry."""
    for el in registry:
        if el.get("tag") not in ("input", "textarea"):
            continue
        blob = " ".join(
            [
                el.get("type", ""),
                el.get("name", ""),
                el.get("aria_label", ""),
                el.get("placeholder", ""),
                el.get("role", ""),
                el.get("text", ""),
            ]
        ).lower()
        if any(k in blob for k in ("search", "query", "بحث")):
            return el
        if el.get("name", "").lower() == "q":
            return el
    return None


async def _focus_search_sel(page: Page, step: int) -> bool:
    """Focus search input via Playwright CSS selectors."""
    for sel in (
        "input[type='search']",
        "[role='searchbox']",
        "input[name='q']",
        "input[name*='search' i]",
        "input[placeholder*='search' i]",
        "input[aria-label*='search' i]",
        "input[aria-label*='بحث' i]",
    ):
        try:
            loc = page.locator(sel).first
            if await loc.is_visible(timeout=T_VISIBLE):
                await loc.click(timeout=T_CLICK)
                await asyncio.sleep(0.2)
                _log(step, f"  focused via '{sel}'")
                return True
        except Exception:
            pass
    return False


# ══════════════════════════════════════════════════════════════════════
# ACTION EXECUTION
# ══════════════════════════════════════════════════════════════════════


async def exec_action(
    page: Page,
    a: Action,
    step: int,
    som_registry: list[dict] | None = None,
) -> ExecutionResult:
    """Execute a single action. Returns ExecutionResult.

    All Playwright errors are caught internally.
    Fatal errors set result.fatal = True.
    """
    try:
        if a.type == "navigate" and a.url:
            return await navigate(page, a.url, step)

        elif a.type == "wait":
            s = _sleep(a.target)
            _log(step, f"wait {s}s")
            await asyncio.sleep(s)
            return ExecutionResult(ok=False)  # wait is not a "success" action

        elif a.type == "click_coord" and a.x is not None and a.y is not None:
            return await _click_at_coord(page, a.x, a.y, a.target or "", step)

        elif a.type == "click_som" and a.som_id is not None:
            return await _click_som(
                page, a.som_id, a.target or "", step, som_registry or []
            )

        elif a.type == "click_text" and a.target:
            ok = await _click(page, a.target, step)
            if not ok:
                _log(step, f'⚠ FAIL "{a.target}"')
            try:
                new_url = page.url
            except Exception:
                new_url = ""
            return ExecutionResult(ok=ok, new_url=new_url)

        elif a.type == "type_text" and a.text:
            _log(step, f'type "{a.text[:40]}"')
            await page.keyboard.type(a.text, delay=25)
            return ExecutionResult(ok=True)

        elif a.type == "press_key" and a.key:
            _log(step, f'key "{a.key}"')
            await page.keyboard.press(a.key)
            return ExecutionResult(ok=True)

        else:
            _log(step, f"skip: {a.type}")
            return ExecutionResult(ok=False, error_msg=f"unhandled action: {a.type}")

    except Exception as exc:
        fatal = _is_fatal(exc)
        if fatal:
            _log(step, f"💥 fatal: {exc}")
        else:
            _log(step, f"⚠ action error: {exc}")
        return ExecutionResult(ok=False, error_msg=str(exc), fatal=fatal)


def coord_action(el: dict) -> Action:
    """Create a click_coord Action from a SoM element's bbox center."""
    b = el.get("bbox")
    text = el.get("text", "")
    sid = el.get("som_id")
    if b and b.get("w") and b.get("h"):
        cx = b["x"] + b["w"] // 2
        cy = b["y"] + b["h"] // 2
        return Action(type="click_coord", target=text, x=cx, y=cy, som_id=sid)
    return Action(type="click_text", target=text)


# ══════════════════════════════════════════════════════════════════════
# CLICK INTERNALS
# ══════════════════════════════════════════════════════════════════════


async def _click_at_coord(
    page: Page,
    x: int,
    y: int,
    label: str,
    step: int,
) -> ExecutionResult:
    url0 = page.url
    _log(step, f'click_coord ({x},{y}) "{label[:35]}"')
    try:
        await page.mouse.click(x, y)
        await _settle(page, url0)
        _log(step, "  coord click OK")
        try:
            new_url = page.url
        except Exception:
            new_url = ""
        return ExecutionResult(ok=True, navigated=new_url != url0, new_url=new_url)
    except Exception as exc:
        if _is_fatal(exc):
            return ExecutionResult(ok=False, error_msg=str(exc), fatal=True)
        _log(step, f"  coord click failed: {exc}")
        if label:
            _log(step, f'  fallback → click_text "{label[:35]}"')
            ok = await _click(page, label, step)
            try:
                new_url = page.url
            except Exception:
                new_url = ""
            return ExecutionResult(ok=ok, navigated=new_url != url0, new_url=new_url)
        return ExecutionResult(ok=False, error_msg=str(exc))


async def _click_som(
    page: Page,
    som_id: int,
    label: str,
    step: int,
    registry: list[dict],
) -> ExecutionResult:
    el = None
    for e in registry:
        if e.get("som_id") == som_id:
            el = e
            break
    if el:
        b = el.get("bbox")
        if b and b.get("w") and b.get("h"):
            cx = b["x"] + b["w"] // 2
            cy = b["y"] + b["h"] // 2
            _log(step, f'click_som [{som_id}] ({cx},{cy}) "{label[:35]}"')
            return await _click_at_coord(page, cx, cy, label, step)
    _log(step, f"click_som [{som_id}] not in registry — fallback to text")
    if label:
        ok = await _click(page, label, step)
        return ExecutionResult(ok=ok)
    return ExecutionResult(ok=False, error_msg="som_id not in registry")


async def _click(page: Page, text: str, step: int, retries: int = 3) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    tl = t.lower()
    url0 = page.url

    for att in range(1, retries + 1):
        if not page_ok(page):
            return False
        _log(step, f'click "{t}" ({att}/{retries})')

        try:
            await page.get_by_text(t, exact=False).first.click(timeout=T_CLICK)
            await _settle(page, url0)
            return True
        except Exception:
            if page.url != url0:
                await _settle(page, url0)
                return True

        for r in ("link", "button"):
            try:
                await page.get_by_role(r, name=t).first.click(timeout=T_CLICK - 1000)
                await _settle(page, url0)
                return True
            except Exception:
                if page.url != url0:
                    await _settle(page, url0)
                    return True

        for attr in ("aria-label", "title"):
            try:
                loc = page.locator(f"[{attr}='{t}' i]").first
                if await loc.is_visible(timeout=T_VISIBLE):
                    await loc.click(timeout=T_CLICK)
                    await _settle(page, url0)
                    return True
            except Exception:
                if page.url != url0:
                    await _settle(page, url0)
                    return True

        try:
            best = None
            for sel in ("a", "button", "[role='button']"):
                els = page.locator(sel)
                cnt = await els.count()
                if att == 1 and sel == "a":
                    _log(step, f"{cnt} <a>")
                    for i in range(min(cnt, 8)):
                        inner = await els.nth(i).inner_text()
                        inner = inner.strip()
                        if inner:
                            _log(step, f'  [{i}] "{inner}"')
                for i in range(cnt):
                    el = els.nth(i)
                    et = await el.inner_text()
                    et = et.strip()
                    if not et:
                        try:
                            att_val = await el.get_attribute("aria-label")
                            et = (att_val or "").strip()
                        except Exception:
                            pass
                    if not et:
                        continue
                    el_low = et.lower()
                    if tl in el_low or el_low in tl:
                        await el.click(timeout=T_CLICK)
                        await _settle(page, url0)
                        return True
                    sc = _overlap(t, et)
                    if sc > (best[0] if best else 0):
                        best = (sc, el, et)
            if best and best[0] >= 0.5:
                try:
                    await best[1].click(timeout=T_CLICK)
                    await _settle(page, url0)
                    _log(step, f'fuzzy "{best[2]}" ({best[0]:.0%})')
                    return True
                except Exception:
                    if page.url != url0:
                        await _settle(page, url0)
                        return True
        except Exception:
            pass
        await asyncio.sleep(0.5 * att)

    _log(step, f'FAILED "{t}"')
    return False
