#!/usr/bin/env python3
"""Stage 1: archive ARDB's public pages exactly as published.

    python tools/scrape_knowledge.py --dry-run
    python tools/scrape_knowledge.py --max-pages 80

Writes ``knowledge/raw/ardb-raw.json``: the pages as ARDB wrote them, Khmer
where ARDB wrote Khmer, nothing translated or rewritten. This file is the
archive and the evidence -- every English sentence the bot sends is traceable
to a page in here.

It is deliberately *not* what the bot reads. Stage 2
(``tools/build_corpus.py``) converts this archive into the single-language
corpus the Worker imports. Keeping the two apart means a re-scrape can never
silently replace reviewed English with raw Khmer, which is exactly what
happened when one file served both purposes.

Hand-written entries (``"url": "manual"``) in the archive are preserved.

Output is meant to be reviewed in a pull request: the crawler is a heuristic
over a WordPress theme and will occasionally keep a navigation blob or miss a
page.

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

REPO_ROOT = kb.REPO_ROOT
DEFAULT_OUTPUT = kb.RAW_PATH


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


#: The review this file actually needs. Everything the bot eventually says is
#: traced back to this archive, so the review is about fidelity to the site
#: rather than formatting -- and about what the crawler dragged in alongside
#: the content.
_REVIEW_CHECKLIST = (
    "No navigation menus, cookie banners or footer boilerplate kept as content",
    "Interest rates, fees and loan ceilings match what ARDB actually publishes",
    "No page lost that a customer would ask about",
    'Hand-written entries ("url": "manual") still present',
    "Khmer text is readable, not escape sequences",
    "Nothing here is a translation -- this file is the published original",
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
            "Stage 1 of the knowledge pipeline: re-scrape ARDB's public pages "
            "into `knowledge/raw/ardb-raw.json`, as published.",
            "",
            "**The bot does not read this file.** Merging this changes nothing "
            "a customer sees. Run the **Build corpus** workflow afterwards to "
            "turn this archive into the English corpus the bot answers from "
            "— it runs automatically once this lands on the default branch.",
            "",
            "```",
            summary,
            "```",
            "",
            "## Review checklist",
            "",
            checklist,
            "",
            f"Archive: {len(knowledge.entries)} entries, "
            f"{knowledge.total_chars:,} characters. The corpus built from it "
            "is sent in full with every question, so growth here becomes a "
            "standing cost on every draft.",
        ]
    )


def _summarize(report, knowledge: kb.KnowledgeBase) -> str:
    lines = [
        f"Visited {report.visited} page(s), kept {report.kept}.",
        f"Archive {knowledge.version}: {len(knowledge.entries)} entries, "
        f"{knowledge.total_chars:,} characters, digest {knowledge.digest}.",
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default=DEFAULT_ORIGIN)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--history", type=Path, default=kb.HISTORY_PATH)
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
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    existing = kb.load(args.output)
    if existing.entries and existing.stage != "raw":
        # Writing a scrape over the corpus would throw away every reviewed
        # restatement and leave the Worker sending Khmer from a prompt that
        # says the source material is English.
        print(
            f"{_display_path(args.output)} is marked stage "
            f"{existing.stage!r}, not 'raw'. Refusing to overwrite a corpus "
            "with a scrape. Stage 1 writes the archive; stage 2 "
            "(tools/build_corpus.py) writes the corpus.",
            file=sys.stderr,
        )
        return 2

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
        stage="raw",
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
            f"\nFAIL  the archive is {result.total_chars:,} characters, over "
            f"the {args.max_chars:,} limit. The corpus built from it is sent "
            "with every question, so this becomes a standing cost on every "
            "draft. Tighten DROP_PATTERNS in tools/ardb/scraper.py, or raise "
            "--max-chars deliberately.",
            file=sys.stderr,
        )
        return 1

    if args.dry_run:
        print("\nDry run -- nothing written.")
        return 0

    # Nothing changed on the site. Leave the committed file exactly as it is,
    # timestamps included.
    #
    # Rewriting it would move `version` and `generatedAt` and nothing else,
    # which looks like a change to `git diff` and so opens a pull request
    # whose entire content is a newer timestamp on identical pages. A monthly
    # scrape that found nothing would do that every month, and a reviewer who
    # has dismissed three such pull requests will skim the fourth -- the one
    # where a rate moved. The digest covers the entries alone precisely so
    # this comparison is possible.
    if existing.entries and existing.digest == result.digest:
        print(
            f"\nUnchanged: {_display_path(args.output)} already holds digest "
            f"{result.digest}. ARDB's pages have not moved, so the archive is "
            "left untouched and nothing needs reviewing."
        )
        if step_output := os.environ.get("GITHUB_OUTPUT"):
            with open(step_output, "a", encoding="utf-8") as handle:
                handle.write(f"version={existing.version}\n")
                handle.write(f"entries={len(existing.entries)}\n")
                handle.write(f"digest={existing.digest}\n")
                handle.write("changed=false\n")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    kb.dump(result, args.output)
    kb.append_history(
        {
            "at": result.generated_at,
            "stage": "raw",
            "version": result.version,
            "entries": len(result.entries),
            "chars": result.total_chars,
            "digest": result.digest,
            "source": result.source,
            "visited": report.visited,
            "kept": report.kept,
        },
        args.history,
    )
    print(f"\nWrote {_display_path(args.output)} at version {result.version}.")
    print(f"Logged to {_display_path(args.history)}.")
    print(
        "Review the diff, then run stage 2 (tools/build_corpus.py) to rebuild "
        "the corpus the bot answers from. Until then the bot keeps using the "
        "previous corpus."
    )

    # Surface the version to a workflow without re-parsing the file.
    if step_output := os.environ.get("GITHUB_OUTPUT"):
        with open(step_output, "a", encoding="utf-8") as handle:
            handle.write(f"version={result.version}\n")
            handle.write(f"entries={len(result.entries)}\n")
            handle.write(f"digest={result.digest}\n")
            handle.write("changed=true\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
