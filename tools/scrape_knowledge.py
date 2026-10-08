#!/usr/bin/env python3
"""Scrape ARDB's public pages into the knowledge file.

    python tools/scrape_knowledge.py --dry-run
    python tools/scrape_knowledge.py --max-pages 80

Writes ``knowledge/ardb-knowledge.json`` in the schema
``src/core/knowledge.ts`` expects, preserving hand-written entries. Output is
meant to be reviewed in a pull request: the crawler is a heuristic over a
WordPress theme and will occasionally keep a navigation blob or miss a page.

Exit codes: 0 wrote (or would write), 1 nothing usable found or a guard
tripped, 2 misconfigured.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from ardb import knowledge as kb
from ardb.scraper import DEFAULT_ORIGIN, crawl

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "knowledge" / "ardb-knowledge.json"


def _display_path(path: Path) -> str:
    """Repo-relative inside the repo, absolute otherwise; never raises."""
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)

#: Guard against a crawl that balloons. The whole corpus is sent with every
#: question, so an accidental ingest of the news archive is a standing cost on
#: every draft, not a one-off. Tripping this fails the run rather than
#: quietly making every question more expensive.
DEFAULT_MAX_CHARS = 400_000


#: The review this file actually needs. It is the only thing grounding the
#: drafts, and the Worker is forbidden from stating a number that is not in
#: it, so the review is about accuracy rather than formatting.
_REVIEW_CHECKLIST = (
    "No navigation menus, cookie banners or footer boilerplate kept as content",
    "Interest rates, fees and loan ceilings match what ARDB actually publishes",
    "No page lost that a customer would ask about",
    'Hand-written entries ("url": "manual") still present',
    "Khmer text is readable, not escape sequences",
)


def build_pr_body(summary: str, knowledge: kb.KnowledgeBase) -> str:
    """Markdown body for the pull request.

    Built here rather than in the workflow because YAML heredocs mangle
    indentation, and because this text is the only thing that tells a reviewer
    what they are actually checking for.
    """
    checklist = "\n".join(f"- [ ] {item}" for item in _REVIEW_CHECKLIST)
    return "\n".join(
        [
            "Automated re-scrape of ARDB's public pages into "
            "`knowledge/ardb-knowledge.json`.",
            "",
            "```",
            summary,
            "```",
            "",
            "## Review checklist",
            "",
            checklist,
            "",
            f"Corpus: {len(knowledge.entries)} entries, "
            f"~{knowledge.estimated_tokens:,} tokens. Every question sends the "
            "whole corpus, so growth here is a standing cost on every draft.",
        ]
    )


def _summarize(report, knowledge: kb.KnowledgeBase) -> str:
    lines = [
        f"Visited {report.visited} page(s), kept {report.kept}.",
        f"Corpus: {len(knowledge.entries)} entries, "
        f"{knowledge.total_chars:,} characters, "
        f"~{knowledge.estimated_tokens:,} tokens per question.",
    ]

    by_category: dict[str, int] = {}
    for entry in knowledge.entries:
        by_category[entry.category] = by_category.get(entry.category, 0) + 1
    if by_category:
        breakdown = ", ".join(
            f"{name} {count}" for name, count in sorted(by_category.items())
        )
        lines.append(f"Categories: {breakdown}")

    if report.skipped_thin:
        lines.append(f"Skipped {len(report.skipped_thin)} page(s) as too thin.")
    if report.skipped_robots:
        lines.append(f"robots.txt disallowed {len(report.skipped_robots)} page(s).")
    if report.errors:
        lines.append(f"{len(report.errors)} error(s): {report.errors[0]}")

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default=DEFAULT_ORIGIN)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--max-pages", type=int, default=60)
    parser.add_argument("--delay", type=float, default=0.5, metavar="SECONDS")
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument(
        "--ignore-robots",
        action="store_true",
        help="Crawl regardless of robots.txt. Defensible only on ARDB's own site.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--summary-file",
        type=Path,
        help="Also write the plain-text summary here, for a run summary.",
    )
    parser.add_argument(
        "--pr-body-file",
        type=Path,
        help="Write the pull-request body here, for `gh pr create --body-file`.",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    existing = kb.load(args.output)
    manual = tuple(entry for entry in existing.entries if entry.is_manual)
    if manual:
        print(f"Preserving {len(manual)} hand-written entr{'y' if len(manual) == 1 else 'ies'}.")

    scraped, report = crawl(
        args.origin,
        max_pages=args.max_pages,
        delay_seconds=args.delay,
        respect_robots=not args.ignore_robots,
    )

    entries = kb.merge_entries(scraped, manual)
    if not entries:
        print(
            "\nNothing usable found. The site structure may have changed, or "
            "robots.txt may be blocking the crawl (try --ignore-robots on "
            "ARDB's own site).",
            file=sys.stderr,
        )
        for error in report.errors[:5]:
            print(f"  {error}", file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc)
    result = kb.KnowledgeBase(
        version=kb.build_version(len(entries), now),
        generated_at=now.isoformat().replace("+00:00", "Z"),
        source=args.origin,
        entries=entries,
    )

    summary = _summarize(report, result)
    print("\n" + summary)

    if args.summary_file:
        args.summary_file.write_text(summary + "\n", encoding="utf-8")
    if args.pr_body_file:
        args.pr_body_file.write_text(
            build_pr_body(summary, result) + "\n", encoding="utf-8"
        )

    if result.total_chars > args.max_chars:
        print(
            f"\nFAIL  corpus is {result.total_chars:,} characters, over the "
            f"{args.max_chars:,} limit. Every question pays for all of it. "
            "Tighten DROP_PATTERNS in tools/ardb/scraper.py, or raise "
            "--max-chars deliberately.",
            file=sys.stderr,
        )
        return 1

    if args.dry_run:
        print("\nDry run -- nothing written.")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    kb.dump(result, args.output)
    print(f"\nWrote {_display_path(args.output)} at version {result.version}.")
    print("Review the diff before merging.")

    # Surface the version to a workflow without re-parsing the file.
    if step_output := os.environ.get("GITHUB_OUTPUT"):
        with open(step_output, "a", encoding="utf-8") as handle:
            handle.write(f"version={result.version}\n")
            handle.write(f"entries={len(result.entries)}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
