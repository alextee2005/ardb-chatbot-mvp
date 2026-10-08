"""The knowledge files: schema, classification, and merge rules.

There are two of them, written by two separate steps, and the distinction is
the whole point of the layout:

``knowledge/raw/ardb-raw.json``
    Stage 1. ARDB's pages exactly as published -- Khmer where ARDB wrote
    Khmer -- with nothing translated or rewritten. Written only by the
    scraper. This is the archive: if a restatement is ever disputed, this is
    the evidence.

``knowledge/corpus/ardb-corpus.json``
    Stage 2. Built *from* the raw snapshot by restating every page in English.
    ``content`` is the English the bot sends; ``sourceText`` is the raw page it
    came from. Carries ``builtFrom``, naming the exact raw snapshot it was
    built from, so a corpus can always be traced to its source and a corpus
    left behind by a newer scrape can be detected.

This module owns the contract with the Worker. The corpus file is imported
directly by `src/worker.ts` and parsed as the `KnowledgeBase` interface in
`src/core/knowledge.ts`, so the field names and the `language` values here
must match that interface exactly. Changing one without the other breaks the
deployed bot at build time.
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

#: Which of the two files this is. Recorded in the file itself so a path
#: mix-up -- scraping over the corpus, say -- is caught by reading one field
#: rather than by noticing the Khmer came back.
Stage = Literal["raw", "corpus"]

REPO_ROOT = Path(__file__).resolve().parents[2]

#: Stage 1 output: the pages as published. Never contains a translation.
RAW_PATH = REPO_ROOT / "knowledge" / "raw" / "ardb-raw.json"

#: Stage 2 output: the English corpus the Worker imports and sends to Claude.
CORPUS_PATH = REPO_ROOT / "knowledge" / "corpus" / "ardb-corpus.json"

#: Append-only ledger of every scrape and every build, with timestamps.
#: Git already versions the two files; this is the readable index over that
#: history -- what ran, when, how much it found, and which raw snapshot each
#: corpus came from -- without checking out old commits to find out.
HISTORY_PATH = REPO_ROOT / "knowledge" / "HISTORY.jsonl"

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
    """One topic of ARDB source material.

    After consolidation ``content`` is the English reference text and
    ``source_text`` holds the Khmer page it came from, verbatim.

    The split is deliberate. ``content`` is what the Worker sends to Claude, so
    the prompt carries one language and one representation. ``source_text``
    never leaves the file: it exists so a reviewer, or anyone auditing a bad
    answer months later, can compare what a customer was told against what
    ARDB actually published. Dropping it would make the consolidation
    unfalsifiable.
    """

    id: str
    title: str
    url: str
    language: Language
    category: str
    content: str
    #: Verbatim source text, when ``content`` has been rewritten from it.
    source_text: str | None = None
    #: Language of ``source_text``.
    source_language: Language | None = None

    def to_dict(self) -> dict[str, str]:
        payload = {
            "id": self.id,
            "title": self.title,
            "url": self.url,
            "language": self.language,
            "category": self.category,
            "content": self.content,
        }
        # Omitted rather than null when absent, so an un-consolidated corpus
        # produces the same file it always did.
        if self.source_text is not None:
            payload["sourceText"] = self.source_text
        if self.source_language is not None:
            payload["sourceLanguage"] = self.source_language
        return payload

    @classmethod
    def from_dict(cls, raw: dict[str, str]) -> KnowledgeEntry:
        missing = {"id", "title", "url", "language", "category", "content"} - raw.keys()
        if missing:
            raise ValueError(f"entry is missing fields: {sorted(missing)}")
        source_text = raw.get("sourceText")
        source_language = raw.get("sourceLanguage")
        return cls(
            id=str(raw["id"]),
            title=str(raw["title"]),
            url=str(raw["url"]),
            language=_coerce_language(str(raw["language"])),
            category=str(raw["category"]),
            content=str(raw["content"]),
            source_text=None if source_text is None else str(source_text),
            source_language=(
                None if source_language is None else _coerce_language(str(source_language))
            ),
        )

    @property
    def is_manual(self) -> bool:
        return self.url == MANUAL_URL

    @property
    def is_consolidated(self) -> bool:
        return self.source_text is not None


@dataclass(frozen=True, slots=True)
class Provenance:
    """Which snapshot a file was built from.

    The digest is what makes this more than a comment. A version string is
    date-plus-entry-count, so two different scrapes on the same day that keep
    the same number of pages share a version; the digest does not. Comparing
    ``built_from.digest`` against the raw file's own digest is how a corpus
    that a later scrape has left behind is detected.
    """

    version: str
    generated_at: str
    digest: str
    source: str = ""

    def to_dict(self) -> dict[str, str]:
        return {
            "version": self.version,
            "generatedAt": self.generated_at,
            "digest": self.digest,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, object]) -> Provenance:
        return cls(
            version=str(raw.get("version", "")),
            generated_at=str(raw.get("generatedAt", "")),
            digest=str(raw.get("digest", "")),
            source=str(raw.get("source", "")),
        )


@dataclass(frozen=True, slots=True)
class KnowledgeBase:
    version: str
    generated_at: str
    source: str
    entries: tuple[KnowledgeEntry, ...]
    stage: Stage = "raw"
    #: Set on a corpus: the raw snapshot it was built from. Never set on raw,
    #: which is built from the website.
    built_from: Provenance | None = None

    def to_dict(self) -> dict[str, object]:
        # camelCase on the way out: this is the shape TypeScript reads.
        payload: dict[str, object] = {
            "version": self.version,
            "generatedAt": self.generated_at,
            "source": self.source,
            "stage": self.stage,
        }
        if self.built_from is not None:
            payload["builtFrom"] = self.built_from.to_dict()
        payload["entries"] = [entry.to_dict() for entry in self.entries]
        return payload

    @classmethod
    def from_dict(cls, raw: dict[str, object]) -> KnowledgeBase:
        entries = raw.get("entries") or []
        if not isinstance(entries, list):
            raise ValueError("entries must be a list")
        built_from = raw.get("builtFrom")
        stage = str(raw.get("stage", "")) or None
        return cls(
            version=str(raw.get("version", "")),
            generated_at=str(raw.get("generatedAt", "")),
            source=str(raw.get("source", "")),
            entries=tuple(KnowledgeEntry.from_dict(item) for item in entries),
            stage=stage if stage in ("raw", "corpus") else "raw",
            built_from=(
                Provenance.from_dict(built_from)
                if isinstance(built_from, dict)
                else None
            ),
        )

    @property
    def digest(self) -> str:
        """Content fingerprint over the entries alone.

        Deliberately excludes ``version``, ``generated_at`` and ``stage``: a
        re-scrape that finds the site unchanged must produce the same digest,
        or every re-run would look like new data and mark the corpus stale.
        """
        payload = json.dumps(
            [entry.to_dict() for entry in self.entries],
            sort_keys=True,
            ensure_ascii=False,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    @property
    def provenance(self) -> Provenance:
        """This file, as the thing a later stage was built from."""
        return Provenance(
            version=self.version,
            generated_at=self.generated_at,
            digest=self.digest,
            source=self.source,
        )

    @property
    def total_chars(self) -> int:
        """Characters the Worker actually sends.

        ``source_text`` is excluded: it lives in the file for audit and is
        never put in a prompt, so counting it would overstate the cost of
        every question.
        """
        return sum(len(entry.content) for entry in self.entries)

    @property
    def archived_chars(self) -> int:
        """Characters of retained source text. Never sent; file size only."""
        return sum(len(entry.source_text or "") for entry in self.entries)

    @property
    def consolidated_count(self) -> int:
        return sum(1 for entry in self.entries if entry.is_consolidated)

    @property
    def estimated_tokens(self) -> int:
        """Rough token estimate for the whole corpus.

        Every question pays for all of it, because the corpus is sent in full
        behind a prompt-cache breakpoint rather than retrieved. ~3.5 chars per
        token is a conservative blend of Latin and Khmer, which tokenizes
        considerably worse than English.
        """
        return round(self.total_chars / 3.5)

    @property
    def english_count(self) -> int:
        return sum(1 for entry in self.entries if entry.language == "en")

    @property
    def pending(self) -> tuple[KnowledgeEntry, ...]:
        """Entries the corpus build has not yet restated in English.

        These still carry their published language, so the bot would be
        sending Khmer to a model told the source material is English. They are
        what stage 2 reports as outstanding.
        """
        return tuple(entry for entry in self.entries if entry.language != "en")


def append_history(record: dict[str, object], path: Path = HISTORY_PATH) -> None:
    """Add one line to the run ledger.

    JSON Lines rather than a JSON array: appending a line never rewrites the
    ones before it, so two runs landing in the same pull request conflict on
    the tail instead of on the whole file, and `git log -p` on this path reads
    as a list of events.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, sort_keys=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def read_history(path: Path = HISTORY_PATH) -> tuple[dict[str, object], ...]:
    """The ledger, oldest first. A malformed line is skipped, not fatal."""
    if not path.exists():
        return ()
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            records.append(parsed)
    return tuple(records)


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

    # Drop pages whose content is byte-identical to one already kept. A site
    # with /, /en and /km serves the same homepage under three URLs, and
    # paying to send it three times with every question buys nothing.
    #
    # The shortest URL wins, so the canonical page beats a language alias:
    # https://host beats https://host/en. Sorting by ID length instead would
    # pick "en" over "home", keeping the alias and discarding the real thing.
    # Manual entries are never dropped -- an override that deliberately
    # duplicates a page is the author's call.
    deduplicated: dict[str, KnowledgeEntry] = {}
    content_owner: dict[str, str] = {}
    for entry in sorted(by_id.values(), key=lambda item: (len(item.url), item.url)):
        existing = content_owner.get(entry.content)
        if existing is not None and not entry.is_manual:
            continue
        content_owner.setdefault(entry.content, entry.id)
        deduplicated[entry.id] = entry

    return tuple(sorted(deduplicated.values(), key=lambda entry: entry.id))


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
