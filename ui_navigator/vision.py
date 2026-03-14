"""vision.py — Gemini Vision analysis (LLM-based, used outside execution loop).

Accepts api_key as a parameter for secure key management.
Wraps Gemini API calls with domain-specific error handling.
"""

import logging
import json
import asyncio
import os
from google import genai
from PIL import Image

from ui_navigator.types import ScorerError, Plan, Action

logger = logging.getLogger("ui_navigator.vision")


async def analyze_image(image_path: str, goal: str, *, api_key: str) -> str:
    """Analyze a screenshot with Gemini Vision (Async)."""
    use_vertex = os.environ.get("USE_VERTEX_AI", "false").lower() == "true"
    if not use_vertex and not api_key:
        raise ScorerError(
            "GOOGLE_API_KEY is required. Set it as an environment variable, "
            "in a .env file, or provide it when prompted."
        )

    try:
        # We wrap in a thread to avoid blocking the event loop if the SDK is sync
        return await asyncio.to_thread(_analyze_image_sync, image_path, goal, api_key)
    except Exception as exc:
        raise ScorerError(f"Gemini Analysis failed: {exc}") from exc


def _analyze_image_sync(image_path: str, goal: str, api_key: str) -> str:
    use_vertex = os.environ.get("USE_VERTEX_AI", "false").lower() == "true"
    if use_vertex:
        # ══════════════════════════════════════════════════════════════════
        # [HACKATHON PROOF: GOOGLE CLOUD VERTEX AI]
        # Direct API calls to Vertex AI endpoints for Vision analysis.
        # ══════════════════════════════════════════════════════════════════
        project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
        location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        if not project_id:
            raise ScorerError("GOOGLE_CLOUD_PROJECT is required for Vertex AI.")
        client = genai.Client(vertexai=True, project=project_id, location=location)
    else:
        client = genai.Client(api_key=api_key)

    image = Image.open(image_path)

    prompt = f"""
You are an autonomous UI navigation agent.

The user's goal is:
{goal}

1. Describe what you see in the screenshot.
2. Identify relevant UI elements.
3. Suggest step-by-step actions to achieve the goal.
Be precise and structured.
"""
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[prompt, image],
    )
    return response.text


async def generate_zero_shot_plan(image_path: str, goal: str, *, api_key: str) -> Plan:
    """Generate a structured Plan from a screenshot using Gemini Vision (Async)."""
    use_vertex = os.environ.get("USE_VERTEX_AI", "false").lower() == "true"
    if not use_vertex and not api_key:
        raise ScorerError("GOOGLE_API_KEY required for zero-shot planning.")

    try:
        json_str = await asyncio.to_thread(
            _generate_plan_sync, image_path, goal, api_key
        )

        # Clean up Markdown code blocks if present
        if "```json" in json_str:
            json_str = json_str.split("```json")[1].split("```")[0].strip()
        elif "```" in json_str:
            json_str = json_str.split("```")[1].split("```")[0].strip()

        data = json.loads(json_str)
        return Plan.model_validate(data)
    except Exception as exc:
        logger.error(f"Zero-shot planning failed: {exc}")
        # Fallback to a simple wait plan if AI fails
        return Plan(
            goal=goal,
            extracted_ui_text_preview="AI planning failed",
            actions=[Action(type="wait", target="2s")],
        )


def _generate_plan_sync(image_path: str, goal: str, api_key: str) -> str:
    use_vertex = os.environ.get("USE_VERTEX_AI", "false").lower() == "true"
    if use_vertex:
        project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
        location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        if not project_id:
            raise ScorerError("GOOGLE_CLOUD_PROJECT is required for Vertex AI.")
        client = genai.Client(vertexai=True, project=project_id, location=location)
    else:
        client = genai.Client(api_key=api_key)

    image = Image.open(image_path)

    prompt = f"""
You are an autonomous UI navigation agent.
The user's goal is: "{goal}"

Based on the provided screenshot, generate a sequence of actions to achieve this goal.
Return ONLY a JSON object followed by nothing else.

JSON structure:
{{
  "goal": "{goal}",
  "extracted_ui_text_preview": "Brief description of the UI state",
  "actions": [
    {{ "type": "click_text", "target": "Login" }},
    {{ "type": "type_text", "text": "user@example.com" }},
    {{ "type": "press_key", "key": "Enter" }},
    {{ "type": "wait", "target": "1s" }}
  ]
}}

Rules:
1. Use 'click_text' for clicking elements based on their visible labels.
2. Use 'type_text' and 'press_key' for inputs.
3. Be concise.
"""
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[prompt, image],
    )
    return response.text
