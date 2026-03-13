from pydantic import BaseModel, Field
from typing import List, Literal, Optional
from dataclasses import dataclass, field


# ══════════════════════════════════════════════════════════════════════
# ACTION TYPES
# ══════════════════════════════════════════════════════════════════════

ActionType = Literal[
    "click_text",
    "click_coord",
    "click_som",
    "type_text",
    "press_key",
    "wait",
    "navigate",
]


class Action(BaseModel):
    type: ActionType
    target: Optional[str] = None  # display text (click_text / logging)
    text: Optional[str] = None  # type_text payload
    key: Optional[str] = None  # press_key name
    url: Optional[str] = None  # navigate URL
    x: Optional[int] = None  # click_coord: center X of SoM bbox
    y: Optional[int] = None  # click_coord: center Y of SoM bbox
    som_id: Optional[int] = None  # click_som: SoM element index


class Plan(BaseModel):
    goal: str
    extracted_ui_text_preview: str = Field(default="")
    actions: List[Action] = Field(default_factory=list)

    # ── origin metadata (context guard) ──────────────────────────────
    origin_url: Optional[str] = Field(
        default=None,
        description="The URL this plan was designed for (e.g. https://example.com)",
    )
    origin_host: Optional[str] = Field(
        default=None,
        description="Domain host this plan targets (e.g. example.com)",
    )
    origin_title_hint: Optional[str] = Field(
        default=None,
        description="Expected page title substring for context verification",
    )
    origin_keywords: List[str] = Field(
        default_factory=list,
        description="Short list of keywords expected on the target page",
    )


# ══════════════════════════════════════════════════════════════════════
# INTER-MODULE RESULT TYPES
# ══════════════════════════════════════════════════════════════════════


@dataclass
class ExecutionResult:
    """Returned by every executor operation to the orchestrator."""

    ok: bool
    error_msg: str = ""
    navigated: bool = False  # True if the page URL changed
    new_url: str = ""  # current URL after the operation
    fatal: bool = False  # True if browser died (needs recovery)

    def __bool__(self) -> bool:
        return self.ok


@dataclass
class ValidationResult:
    """Returned by the validator to the orchestrator."""

    satisfied: bool
    rule_matched: str = ""  # which rule triggered (e.g. "TITLE", "BODY")
    matched_keywords: list[str] = field(default_factory=list)
    total_keywords: int = 0
    threshold: int = 0
    details: str = ""

    def __bool__(self) -> bool:
        return self.satisfied


# ══════════════════════════════════════════════════════════════════════
# EXCEPTION HIERARCHY
# ══════════════════════════════════════════════════════════════════════


class PhoenixError(Exception):
    """Base exception for all Phoenix UI Navigator errors."""

    pass


class ExecutorError(PhoenixError):
    """Raised when a browser / Playwright operation fails fatally."""

    pass


class ScorerError(PhoenixError):
    """Raised when content scoring / prioritisation fails."""

    pass


class ValidatorError(PhoenixError):
    """Raised when goal validation fails unexpectedly."""

    pass


class OrchestratorError(PhoenixError):
    """Raised when the orchestrator cannot proceed."""

    pass
