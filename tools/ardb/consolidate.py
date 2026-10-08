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
- The figures you are given are already in English notation: a full stop is the decimal point and a comma groups thousands. Copy them as they are written.
- State no figure that is not in the source. If the source says a rate is competitive without saying what it is, write that it is described as competitive and do not supply a number.
- If a value's association is ambiguous in the source, say what is certain and name the ambiguity. Never guess which row or column a number belongs to.

Rules about content:

- Restate, do not interpret. Add no banking knowledge of your own, no comparisons to other banks, and no advice.
- Translate terms of art into the words a customer would use, keeping the Khmer or formal term in brackets on first use where it identifies a specific product.
- Omit navigation text, cookie notices, copyright lines and social media prompts.
- If a page carries no substantive information, say so in one sentence rather than padding it."""


@dataclass(frozen=True, slots=True)
class ConsolidationResult:
    entry: KnowledgeEntry
    ok: bool
    missing_numbers: tuple[str, ...]
    invented_numbers: tuple[str, ...]
    note: str = ""

    @property
    def failed_verification(self) -> bool:
        return not self.ok


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
    except anthropic.APIError as error:
        return ConsolidationResult(
            entry=entry,
            ok=False,
            missing_numbers=(),
            invented_numbers=(),
            note=f"API error: {error}",
        )

    if response.stop_reason == "refusal":
        category = getattr(response.stop_details, "category", None) or "unspecified"
        return ConsolidationResult(
            entry=entry,
            ok=False,
            missing_numbers=(),
            invented_numbers=(),
            note=f"model declined (category: {category})",
        )

    if response.stop_reason == "max_tokens":
        return ConsolidationResult(
            entry=entry,
            ok=False,
            missing_numbers=(),
            invented_numbers=(),
            note="output was cut off before the entry finished",
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
    )
