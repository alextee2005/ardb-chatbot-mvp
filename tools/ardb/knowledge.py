"""The knowledge-base file: schema, classification, and merge rules.

This module owns the contract with the Worker. `knowledge/ardb-knowledge.json`
is imported directly by `src/worker.ts` and parsed as the `KnowledgeBase`
interface in `src/core/knowledge.ts`, so the field names and the `language`
values here must match that interface exactly. Changing one without the other
breaks the deployed bot at build time.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Literal
from urllib.parse import unquote, urlparse

Language = Literal["km", "en", "mixed"]

#: Marker in the ``url`` field for hand-written entries. These are authored by
#: staff to correct or supplement a scrape and must survive re-scraping.
MANUAL_URL = "manual"

#: Khmer block U+1780-U+17FF. Deliberately the same test as
#: ``detectLanguage`` in src/core/language.ts, so a page classified Khmer here
#: is the language the Worker would also detect in a question about it.
_KHMER_RE = re.compile(r"[ក-៿]")
_LATIN_RE = re.compile(r"[A-Za-z]")


@dataclass(frozen=True, slots=True)
class KnowledgeEntry:
    """One page of ARDB source material."""

    id: str
    title: str
    url: str
    language: Language
    category: str
    content: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, str]) -> KnowledgeEntry:
        missing = {"id", "title", "url", "language", "category", "content"} - raw.keys()
        if missing:
            raise ValueError(f"entry is missing fields: {sorted(missing)}")
        return cls(
            id=str(raw["id"]),
            title=str(raw["title"]),
            url=str(raw["url"]),
            language=_coerce_language(str(raw["language"])),
            category=str(raw["category"]),
            content=str(raw["content"]),
        )

    @property
    def is_manual(self) -> bool:
        return self.url == MANUAL_URL


@dataclass(frozen=True, slots=True)
class KnowledgeBase:
    version: str
    generated_at: str
    source: str
    entries: tuple[KnowledgeEntry, ...]

    def to_dict(self) -> dict[str, object]:
        # camelCase on the way out: this is the shape TypeScript reads.
        return {
            "version": self.version,
            "generatedAt": self.generated_at,
            "source": self.source,
            "entries": [entry.to_dict() for entry in self.entries],
        }

    @classmethod
    def from_dict(cls, raw: dict[str, object]) -> KnowledgeBase:
        entries = raw.get("entries") or []
        if not isinstance(entries, list):
            raise ValueError("entries must be a list")
        return cls(
            version=str(raw.get("version", "")),
            generated_at=str(raw.get("generatedAt", "")),
            source=str(raw.get("source", "")),
            entries=tuple(KnowledgeEntry.from_dict(item) for item in entries),
        )

    @property
    def total_chars(self) -> int:
        return sum(len(entry.content) for entry in self.entries)

    @property
    def estimated_tokens(self) -> int:
        """Rough token estimate for the whole corpus.

        Every question pays for all of it, because the corpus is sent in full
        behind a prompt-cache breakpoint rather than retrieved. ~3.5 chars per
        token is a conservative blend of Latin and Khmer, which tokenizes
        considerably worse than English.
        """
        return round(self.total_chars / 3.5)


def _coerce_language(value: str) -> Language:
    return value if value in ("km", "en", "mixed") else "en"


def classify_language(text: str) -> Language:
    """Classify by script share, mirroring src/core/language.ts."""
    khmer = len(_KHMER_RE.findall(text))
    latin = len(_LATIN_RE.findall(text))
    total = khmer + latin
    if total == 0:
        return "en"

    share = khmer / total
    if share >= 0.75:
        return "km"
    if share <= 0.25:
        return "en"
    return "mixed"


#: Category assignment, first match wins. Order matters: a page about loan
#: interest rates is more useful filed under loans than under rates, because
#: that is how a customer asks about it.
_CATEGORY_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("loan-products", re.compile(r"loan|credit|apply|requirement", re.I)),
    ("deposit-products", re.compile(r"deposit|saving", re.I)),
    ("rates-and-fees", re.compile(r"interest|rate|fee|tariff|charge", re.I)),
    ("digital-banking", re.compile(r"digital|mobile|internet|app|banking", re.I)),
    ("branches-and-contact", re.compile(r"branch|location|contact|address", re.I)),
    ("faq", re.compile(r"faq|question", re.I)),
    ("about", re.compile(r"profile|about|history|vision|mission", re.I)),
)


def categorize(url: str) -> str:
    for category, pattern in _CATEGORY_RULES:
        if pattern.search(url):
            return category
    return "general"


def slugify(url: str) -> str:
    """Stable, readable entry ID derived from the URL path.

    Readable because a reviewer refers to entries by ID in a pull request;
    stable because a changing ID would churn the file on every scrape.

    The path is percent-decoded first, so ``/loan%20type/`` reads as
    ``loan-type`` rather than ``loan-20type``. A decoded path can still reduce
    to nothing -- a Khmer URL slug such as ``/កម្ចី/`` has no ASCII
    alphanumerics at all -- and every such page would otherwise collapse onto
    the same ID and silently overwrite the others. Those fall back to a short
    digest of the path, which is stable across runs and unique per page.
    """
    path = unquote(urlparse(url).path).strip("/")
    if not path:
        return "home"

    slug = re.sub(r"[^a-z0-9]+", "-", path.lower()).strip("-")[:60].strip("-")
    if slug:
        return slug

    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()[:10]
    return f"page-{digest}"


def merge_entries(
    scraped: Iterable[KnowledgeEntry],
    manual: Iterable[KnowledgeEntry],
) -> tuple[KnowledgeEntry, ...]:
    """Combine a fresh scrape with hand-written entries.

    Manual entries win on an ID collision, which is what lets staff override a
    page the scraper reads badly without editing the scraper. Output is sorted
    by ID so the rendered corpus is byte-identical between runs -- the
    condition for the Worker's prompt cache to hit.
    """
    by_id: dict[str, KnowledgeEntry] = {entry.id: entry for entry in scraped}
    for entry in manual:
        by_id[entry.id] = entry
    return tuple(sorted(by_id.values(), key=lambda entry: entry.id))


def build_version(entry_count: int, now: datetime | None = None) -> str:
    """Date plus entry count, e.g. ``2026-10-07-23``.

    Logged with every draft, so a bad answer can be traced to the corpus that
    produced it.
    """
    moment = now or datetime.now(timezone.utc)
    return f"{moment.date().isoformat()}-{entry_count}"


def load(path: Path) -> KnowledgeBase:
    """Read an existing knowledge file, tolerating absence."""
    if not path.exists():
        return KnowledgeBase(version="", generated_at="", source="", entries=())
    return KnowledgeBase.from_dict(json.loads(path.read_text(encoding="utf-8")))


def dump(knowledge: KnowledgeBase, path: Path) -> None:
    """Write the knowledge file.

    Two-space indent, ``ensure_ascii=False`` and a trailing newline match what
    the Worker's repo already contains, so a re-scrape produces a reviewable
    diff rather than reformatting every line. ``ensure_ascii=False`` in
    particular keeps Khmer readable in a pull request instead of turning it
    into escape sequences.
    """
    payload = json.dumps(knowledge.to_dict(), indent=2, ensure_ascii=False)
    path.write_text(payload + "\n", encoding="utf-8")
