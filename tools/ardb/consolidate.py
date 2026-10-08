"""Consolidate scraped pages into one normalized English corpus.

Each scraped page becomes a single English entry: a title, a plain-English
restatement of the page's substance, and the figures exactly as published. The
Khmer source is kept in the entry for audit but is not sent to the Worker at
draft time, so the prompt carries one language and one representation.

The risk this takes on is explicit: a model now sits between what ARDB
publishes and what a customer is told, and a mistranslated rate reads exactly
like a correct one. Three things hold it down.

1. Figures are converted from Khmer numerals and ARDB's separator convention
   **before** the model sees them (``ardb.normalize``), so the step most
   likely to produce a wrong number has no model in it.
2. Every output is checked against its source for figure preservation. A
   dropped or invented number fails that entry rather than shipping it.
3. A failed entry keeps its previous consolidation if one exists, and is
   reported for review rather than silently replaced.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import anthropic

from .knowledge import KnowledgeEntry
from .normalize import normalize_numbers, numbers_match

log = logging.getLogger(__name__)

#: Opus 5.5. Thinking is always on for this model and cannot be disabled, so
#: depth is set through effort instead; its default here would be `medium`.
DEFAULT_MODEL = "claude-opus-5-5"

#: Headroom for adaptive thinking plus a restatement of a long page. Thinking
#: tokens count against this, so a value sized only for the visible output
#: would truncate mid-entry.
MAX_TOKENS = 16_000

CONSOLIDATION_SYSTEM = """You restate pages from the website of ARDB (the Agricultural and Rural Development Bank), a state-owned Cambodian bank, as English reference material.

This material is the sole source a support assistant will use to answer customer questions about ARDB. It is not marketing copy and it is not a summary for a reader: it is a reference document that must let someone answer a specific question about a specific product correctly.

What to produce:

- Plain English, complete sentences, no Markdown and no headings in the body.
- Everything a customer might ask about: who a product is for, eligibility, required documents, amounts, terms, rates, fees, currencies, how to apply, where to go.
- Keep the structure of lists and tables as prose that preserves which value belongs to which thing. A rate table becomes sentences like "For a 12-month term the annual rate is 4.00% in US dollars and 4.00% in riel." Never emit a bare list of numbers.

Rules about figures, which matter more than fluency:

- Reproduce every figure in the source exactly: rates, fees, ceilings, terms, percentages, counts, dates. Do not round, convert currencies, average, or combine them.
- The figures you are given have already been converted to English notation: a full stop is the decimal point and a comma groups thousands, so "4.00%" is four percent and "40,000" is forty thousand. Copy them exactly as written and do not reinterpret the separators.
- State no figure that is not in the source. If the source says a rate is competitive without saying what it is, write that it is described as competitive and do not supply a number.
- If a value's association is ambiguous in the source, say what is certain and name the ambiguity. Never guess which row or column a number belongs to.

Rules about content:

- Restate, do not interpret. Add no banking knowledge of your own, no comparisons to other banks, and no advice.
- Translate terms of art into the words a customer would use, keeping the Khmer or formal term in brackets on first use where it identifies a specific product.
- Omit navigation text, cookie notices, copyright lines and social media prompts.
- If a page carries no substantive information, say so in one sentence rather than padding it."""


class FatalConsolidationError(RuntimeError):
    """A failure that every remaining entry will hit too.

    An invalid API key is the motivating case: it does not describe the entry
    being processed, it describes the run, and 33 sequential 401s tell nobody
    anything the first one did not. Raised so the caller stops immediately
    rather than attributing a configuration problem to the corpus.
    """


#: Why an entry did not get consolidated. The distinction is not cosmetic: a
#: figure mismatch means review the translation, a transport failure means
#: re-run, and a config failure means fix the secret. Reporting all three as
#: "failed verification" sends people to the wrong place -- which is exactly
#: what happened on the first real run.
VERIFICATION_FAILURE = "verification"
TRANSPORT_FAILURE = "transport"
MODEL_FAILURE = "model"


#: 400 responses that describe the run rather than the page. Every entry will
#: hit them identically, so they are fatal: re-running changes nothing, and
#: telling someone to re-run is worse than useless. The workspace-scoping case
#: is the one that caught us -- an organization-level key authenticates fine,
#: then every request is rejected for want of a workspace.
_FATAL_BAD_REQUEST_SIGNALS = (
    "not scoped to a workspace",
    "anthropic-workspace-id",
    "credit balance",
    "insufficient",
    "billing",
    "organization has been disabled",
    "model:",
    "not found",
    "not_found",
    "does not have access",
)


#: A workspace ID, e.g. wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ. Checked here because
#: the workspace *name* is the obvious thing to reach for and the API's own
#: rejection of a name is a bare 400 several steps removed from the setting
#: that caused it.
_WORKSPACE_ID_RE = re.compile(r"^wrkspc_[A-Za-z0-9]+$")


def build_client(
    *, api_key: str | None = None, workspace_id: str | None = None
) -> anthropic.Anthropic:
    """Construct the client, scoping it to a workspace when one is given.

    An API key created at organization level is not bound to a workspace, and
    the Messages API then rejects every request unless the request names one.
    The SDK treats ``anthropic-workspace-id`` as a client-level header, so
    setting it here covers every call.

    Raises ``FatalConsolidationError`` when the value is not a workspace ID.
    The header takes the ID, not the workspace's name, and passing a name
    earns a 400 from the API -- correct but unhelpful, because it arrives
    without saying which setting is wrong or where the right value lives.
    """
    if workspace_id and not _WORKSPACE_ID_RE.match(workspace_id.strip()):
        raise FatalConsolidationError(
            f"ANTHROPIC_WORKSPACE_ID is {workspace_id!r}, which is not a "
            "workspace ID. The header takes the ID, not the workspace name: "
            "it looks like wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ, and the Console "
            "shows it under Settings -> Workspaces in the ID column.\n"
            "Simpler alternative: create an API key scoped to that workspace "
            "and leave ANTHROPIC_WORKSPACE_ID unset -- a scoped key needs no "
            "header at all."
        )

    headers = (
        {"anthropic-workspace-id": workspace_id.strip()} if workspace_id else None
    )
    return anthropic.Anthropic(api_key=api_key, default_headers=headers)


def verify_credentials(client: anthropic.Anthropic, *, model: str = DEFAULT_MODEL) -> None:
    """Make one minimal request to prove the credentials work.

    Cheaper and far more honest than discovering the problem 33 entries in.
    Any failure here is run-level by definition -- the request carries no page
    content, so nothing about the corpus can be at fault -- and is raised with
    the API's own message, which names the actual remedy better than any
    guess made from a status code.
    """
    try:
        client.messages.create(
            model=model,
            max_tokens=1,
            messages=[{"role": "user", "content": "ok"}],
        )
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as error:
        raise FatalConsolidationError(
            f"Claude rejected the credentials ({error.status_code}). "
            "Check the ANTHROPIC_API_KEY secret: it is missing, malformed, "
            "revoked, or belongs to a different organization."
        ) from error
    except anthropic.APIStatusError as error:
        raise FatalConsolidationError(
            f"Claude rejected a minimal test request ({error.status_code}): "
            f"{_message_of(error)}\n"
            "This describes the credentials or the account, not the corpus, "
            "so no page was sent and re-running will not help."
        ) from error
    except anthropic.APIConnectionError as error:
        raise FatalConsolidationError(
            f"Could not reach the Claude API: {error}"
        ) from error


def _message_of(error: anthropic.APIStatusError) -> str:
    """The API's own human-readable message, when it sent one."""
    body = getattr(error, "body", None)
    if isinstance(body, dict):
        inner = body.get("error")
        if isinstance(inner, dict) and inner.get("message"):
            return str(inner["message"])
    return str(error)


@dataclass(frozen=True, slots=True)
class ConsolidationResult:
    entry: KnowledgeEntry
    ok: bool
    missing_numbers: tuple[str, ...]
    invented_numbers: tuple[str, ...]
    note: str = ""
    #: One of the *_FAILURE constants when `ok` is False.
    failure_kind: str | None = None

    @property
    def failed_verification(self) -> bool:
        """True only for a genuine figure mismatch."""
        return not self.ok and self.failure_kind == VERIFICATION_FAILURE


def build_user_message(entry: KnowledgeEntry, prepared_content: str) -> str:
    """The page to restate, with its figures already normalized."""
    return "\n".join(
        [
            f"Page title: {entry.title}",
            f"Source URL: {entry.url}",
            "",
            "Page content follows. Figures in it have already been converted to "
            "English notation; copy them exactly as written.",
            "",
            "<page>",
            prepared_content.strip(),
            "</page>",
            "",
            "Write the English reference entry for this page.",
        ]
    )


#: Structured output so the title and body come back as separate fields rather
#: than needing to be parsed out of prose.
_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {
            "type": "string",
            "description": "Short English title naming the product or topic.",
        },
        "content": {
            "type": "string",
            "description": "The English reference text. Plain prose, no Markdown.",
        },
        "substantive": {
            "type": "boolean",
            "description": "False if the page carries no information a customer could use.",
        },
    },
    "required": ["title", "content", "substantive"],
    "additionalProperties": False,
}


def consolidate_entry(
    client: anthropic.Anthropic,
    entry: KnowledgeEntry,
    *,
    model: str = DEFAULT_MODEL,
    effort: str = "high",
) -> ConsolidationResult:
    """Restate one page in English and verify its figures survived.

    ``effort`` defaults to high rather than low: this runs once per page in a
    batch job, not on a customer's request, and a figure dropped here is wrong
    for every answer afterwards. Accuracy is worth more than the tokens.
    """
    # The model never sees Khmer numerals or ARDB's separator convention.
    prepared = normalize_numbers(entry.content)

    try:
        response = client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            output_config={
                "effort": effort,
                "format": {"type": "json_schema", "schema": _OUTPUT_SCHEMA},
            },
            system=CONSOLIDATION_SYSTEM,
            messages=[{"role": "user", "content": build_user_message(entry, prepared)}],
        )
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as error:
        # Nothing about this entry is wrong, and every remaining entry will
        # fail identically. Stop.
        raise FatalConsolidationError(
            f"Claude rejected the credentials ({error.status_code}). "
            "Check the ANTHROPIC_API_KEY secret: it is missing, malformed, "
            "revoked, or belongs to a different organization."
        ) from error
    except anthropic.BadRequestError as error:
        message = _message_of(error)
        lowered = message.lower()
        if any(signal in lowered for signal in _FATAL_BAD_REQUEST_SIGNALS):
            # Describes the account or the request shape, not this page.
            raise FatalConsolidationError(
                f"Claude rejected the request (400): {message}\n"
                "This describes the credentials, the account or the model, "
                "not the corpus, so re-running will not help."
            ) from error
        return ConsolidationResult(
            entry=entry,
            ok=False,
            missing_numbers=(),
            invented_numbers=(),
            note=f"rejected by Claude: {message}",
            failure_kind=MODEL_FAILURE,
        )
    except anthropic.APIError as error:
        return ConsolidationResult(
            entry=entry,
            ok=False,
            missing_numbers=(),
            invented_numbers=(),
            note=f"could not reach Claude: {error}",
            failure_kind=TRANSPORT_FAILURE,
        )

    if response.stop_reason == "refusal":
        category = getattr(response.stop_details, "category", None) or "unspecified"
        return ConsolidationResult(
            entry=entry,
            ok=False,
            missing_numbers=(),
            invented_numbers=(),
            note=f"model declined (category: {category})",
            failure_kind=MODEL_FAILURE,
        )

    if response.stop_reason == "max_tokens":
        return ConsolidationResult(
            entry=entry,
            ok=False,
            missing_numbers=(),
            invented_numbers=(),
            note="output was cut off before the entry finished",
            failure_kind=MODEL_FAILURE,
        )

    import json

    try:
        text = next(block.text for block in response.content if block.type == "text")
        payload = json.loads(text)
    except (StopIteration, ValueError) as error:
        return ConsolidationResult(
            entry=entry,
            ok=False,
            missing_numbers=(),
            invented_numbers=(),
            note=f"could not read the structured output: {error}",
            failure_kind=MODEL_FAILURE,
        )

    english = str(payload["content"]).strip()
    title = str(payload["title"]).strip() or entry.title

    # The guard: compare against the ORIGINAL source, not the prepared text,
    # so a fault in normalization is caught here too.
    ok, missing, invented = numbers_match(entry.content, english)

    consolidated = KnowledgeEntry(
        id=entry.id,
        title=title,
        url=entry.url,
        language="en",
        category=entry.category,
        content=english,
        source_text=entry.content,
        source_language=entry.language,
    )

    note = ""
    if not payload["substantive"]:
        note = "model reports the page carries no usable information"

    return ConsolidationResult(
        entry=consolidated,
        ok=ok,
        missing_numbers=tuple(missing),
        invented_numbers=tuple(invented),
        note=note,
        failure_kind=None if ok else VERIFICATION_FAILURE,
    )
