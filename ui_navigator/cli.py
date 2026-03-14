"""cli.py — CLI entry point for Phoenix UI Navigator.

Responsibilities:
  - Parse CLI arguments
  - Secure API key resolution (env → .env → user prompt → save)
  - Route commands to the appropriate module (orchestrator, planner, etc.)
"""

import argparse
import asyncio
import os
import sys
from urllib.parse import urlparse

from dotenv import load_dotenv, set_key, find_dotenv

from ui_navigator.ocr import extract_text
from ui_navigator.planner import build_plan
from ui_navigator.types import Plan, OrchestratorError


# ══════════════════════════════════════════════════════════════════════
# SECURE API KEY MANAGEMENT
# ══════════════════════════════════════════════════════════════════════


def _resolve_api_key(
    env_name: str = "GOOGLE_API_KEY",
    display_name: str = "Google API Key (Gemini)",
) -> str:
    """Resolve an API key via the secure cascade:

    1. Environment variable (already set, or loaded from .env)
    2. Interactive prompt (user types it in)
    3. Offer to save to .env for future use

    Returns the key string. Exits with error msg if user declines.
    """
    # Step 1: Check env (load_dotenv already called in main)
    key = os.environ.get(env_name, "").strip()
    if key:
        return key

    # Step 2: Prompt user
    print(f"\n⚠  {display_name} not found in environment or .env file.")
    print(f"   Env var name: {env_name}\n")
    try:
        key = input(f"   Enter your {display_name}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print("\n   Cancelled.")
        sys.exit(1)

    if not key:
        print("   No key provided. Exiting.")
        sys.exit(1)

    # Step 3: Offer to save
    try:
        save = input("   Save to .env for future use? [Y/n]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        save = "n"

    if save in ("", "y", "yes"):
        dotenv_path = find_dotenv() or os.path.join(os.getcwd(), ".env")
        try:
            set_key(dotenv_path, env_name, key)
            print(f"   ✅ Saved to {dotenv_path}\n")
        except Exception as exc:
            print(f"   ⚠ Could not save to .env: {exc}\n")

    # Set in environment for this session
    os.environ[env_name] = key
    return key


# ══════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════


def _host_from_url(url: str) -> str:
    """Extract the hostname from a URL string."""
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""


# ══════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════


def main() -> int:
    load_dotenv()

    parser = argparse.ArgumentParser(
        prog="ui-navigator",
        description="Phoenix: Autonomous UI Navigator",
    )
    subparsers = parser.add_subparsers(dest="command")

    # ── OCR command ──────────────────────────────────────────────────
    ocr_parser = subparsers.add_parser(
        "ocr", help="Extract text from a screenshot via OCR"
    )
    ocr_parser.add_argument("--image", required=True, help="Path to screenshot image")

    # ── PLAN command ─────────────────────────────────────────────────
    plan_parser = subparsers.add_parser(
        "plan", help="Generate an action plan from a screenshot + goal"
    )
    plan_parser.add_argument("--image", required=True, help="Path to screenshot image")
    plan_parser.add_argument("--goal", required=True, help="Goal to achieve")
    plan_parser.add_argument("--out", default="plan.json", help="Output plan file path")
    plan_parser.add_argument(
        "--url",
        default=None,
        help="Origin URL this plan is designed for (stored as metadata)",
    )

    # ── EXEC command ─────────────────────────────────────────────────
    exec_parser = subparsers.add_parser("exec", help="Execute a plan in a browser")
    exec_parser.add_argument("--plan", required=True, help="Path to plan JSON file")
    exec_parser.add_argument(
        "--url", default="https://example.com", help="Starting URL"
    )
    exec_parser.add_argument(
        "--headless", action="store_true", help="Run browser in headless mode"
    )
    exec_parser.add_argument(
        "--max-cycles",
        type=int,
        default=3,
        help="Maximum replan cycles (default: 3)",
    )
    exec_parser.add_argument(
        "--no-ignore-ssl",
        action="store_true",
        help="Do NOT ignore HTTPS/SSL certificate errors (default: ignore them)",
    )
    exec_parser.add_argument(
        "--video", action="store_true", help="Record session video to runs/videos/"
    )
    exec_parser.add_argument(
        "--trace", action="store_true", help="Record Playwright trace to runs/trace.zip"
    )
    exec_parser.add_argument(
        "--run-id", default="", help="Prefix used for saving isolated SoM images"
    )

    # ── ANALYZE command (Gemini) ─────────────────────────────────────
    analyze_parser = subparsers.add_parser(
        "analyze", help="Analyze a screenshot with Gemini"
    )
    analyze_parser.add_argument(
        "--image", required=True, help="Path to screenshot image"
    )
    analyze_parser.add_argument("--goal", required=True, help="Goal to achieve")

    # ── Global flags ─────────────────────────────────────────────────
    parser.add_argument("--ping", action="store_true", help="Health-check")

    args = parser.parse_args()

    # ── --ping ───────────────────────────────────────────────────────
    if args.ping:
        print("ui-navigator: OK")
        return 0

    # ── plan ─────────────────────────────────────────────────────────
    if args.command == "plan":
        # Try to resolve API key for AI-driven planning
        api_key = os.environ.get("GOOGLE_API_KEY", "")
        if not api_key:
            # We only prompt if not in environment
            print(
                "\n💡 Tip: Provide a Google API Key to enable AI-driven Zero-Shot planning."
            )
            try:
                # Resolve key (prompts user if missing)
                api_key = _resolve_api_key()
            except SystemExit:
                print("   Using heuristic OCR fallback...")
                api_key = ""

        text = extract_text(args.image)

        # build_plan is now async
        plan = asyncio.run(build_plan(args.goal, args.image, text, api_key=api_key))

        if args.url:
            plan.origin_url = args.url
            plan.origin_host = _host_from_url(args.url)

        with open(args.out, "w", encoding="utf-8") as f:
            f.write(plan.model_dump_json(indent=2))

        print(f"\nSaved plan to: {args.out}\n")
        print(plan.model_dump_json(indent=2))
        return 0

    # ── ocr ──────────────────────────────────────────────────────────
    if args.command == "ocr":
        text = extract_text(args.image)
        print("\n=== OCR TEXT (first 40 lines) ===\n")
        lines = text.splitlines()
        for line in lines[:40]:
            if line.strip():
                print(line)
        print(f"\n---\nFull length: {len(text)} chars")
        return 0

    # ── exec (routed through orchestrator) ───────────────────────────
    if args.command == "exec":
        plan_path = args.plan
        if not os.path.isfile(plan_path):
            print(f"Error: plan file not found: {plan_path}", file=sys.stderr)
            return 1

        try:
            with open(plan_path, "r", encoding="utf-8") as f:
                plan = Plan.model_validate_json(f.read())
        except Exception as exc:
            print(f"Error: failed to load plan: {exc}", file=sys.stderr)
            return 1

        ignore_https = not args.no_ignore_ssl

        # Import orchestrator here to avoid circular imports
        from ui_navigator.orchestrator import run

        try:
            asyncio.run(
                run(
                    plan,
                    start_url=args.url,
                    headless=args.headless,
                    max_cycles=args.max_cycles,
                    ignore_https_errors=ignore_https,
                    record_video=args.video,
                    enable_tracing=args.trace,
                    run_id=args.run_id,
                )
            )
        except OrchestratorError as exc:
            print(f"Orchestration error: {exc}", file=sys.stderr)
            return 1
        except Exception as exc:
            print(f"Execution error: {exc}", file=sys.stderr)
            return 1

        print("Execution finished.")
        return 0

    # ── analyze (requires API key) ───────────────────────────────────
    if args.command == "analyze":
        api_key = _resolve_api_key()

        from ui_navigator.vision import analyze_image

        try:
            # analyze_image is async and must be run in an event loop
            result = asyncio.run(analyze_image(args.image, args.goal, api_key=api_key))
        except Exception as exc:
            print(f"Analysis error: {exc}", file=sys.stderr)
            return 1
        print("\n=== Gemini Analysis ===\n")
        print(result)
        return 0

    # ── no command ───────────────────────────────────────────────────
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
