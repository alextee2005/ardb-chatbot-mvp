#!/usr/bin/env python3
"""Stage 2: build the English corpus from the latest raw scrape.

    python tools/build_corpus.py              # build knowledge/corpus/
    python tools/build_corpus.py --check      # is the corpus current? (no write)
    python tools/build_corpus.py --dry-run

Reads ``knowledge/raw/ardb-raw.json`` -- ARDB's pages exactly as published --
and writes ``knowledge/corpus/ardb-corpus.json``, the single-language corpus
the Worker imports and sends to Claude. Nothing here touches the network: the
raw snapshot in git is the only input, which is what makes a build
reproducible and reviewable.

Each page's English comes from a restatement module in
``knowledge/restatements/``, discovered automatically so a new batch needs no
argument here. A restatement is accepted only if every figure ARDB published
survives it, checked mechanically by ``ardb.normalize.numbers_match``. A page
with no restatement, or one whose figures do not survive, is carried into the
corpus unchanged in its published language and reported as outstanding --
better a Khmer page the bot can still quote than an unverified translation of
an interest rate.

The corpus records ``builtFrom``: the version, timestamp and digest of the raw
snapshot it came from. That is what lets ``--check`` tell you the corpus is
behind the archive, which is the one failure mode of a two-stage pipeline that
is otherwise invisible.

Exit codes: 0 every page is English (or, with --check, the corpus is current),
1 some pages are outstanding (or the corpus is behind the raw snapshot),
2 misconfigured, 3 nothing was restated at all.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from ardb import knowledge as kb
from ardb.normalize import numbers_match

RESTATEMENTS_DIR = kb.REPO_ROOT / "knowledge" / "restatements"


def _display_path(path: Path) -> str:
    """Repo-relative inside the repo, absolute otherwise; never raises."""
    try:
        return str(path.resolve().relative_to(kb.REPO_ROOT))
    except ValueError:
        return str(path)


def discover_restatements(directory: Path = RESTATEMENTS_DIR) -> tuple[str, ...]:
    """Module names in the restatements directory, in a stable order.

    Discovered rather than listed on the command line: a batch that exists but
    was left off the argument list would silently leave pages in Khmer, and
    the symptom -- a bot answering a Khmer question from Khmer source -- looks
    nothing like the cause.
    """
    if not directory.exists():
        return ()
    return tuple(
        sorted(
            path.stem
            for path in directory.glob("*.py")
            if not path.stem.startswith("_")
        )
    )


def load_restatements(
    names: tuple[str, ...],
    directory: Path = RESTATEMENTS_DIR,
) -> tuple[dict[str, tuple[str, str]], dict[str, set[str]]]:
    """Collect ``ENGLISH`` and ``ALLOW_MISSING`` from each module."""
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

    english: dict[str, tuple[str, str]] = {}
    allow: dict[str, set[str]] = {}
    for name in names:
        module = importlib.import_module(name)
        english.update(module.ENGLISH)
        for entry_id, figures in getattr(module, "ALLOW_MISSING", {}).items():
            allow.setdefault(entry_id, set()).update(figures)
    return english, allow


def build(
    raw: kb.KnowledgeBase,
    english: dict[str, tuple[str, str]],
    allow: dict[str, set[str]],
    now: datetime | None = None,
) -> tuple[kb.KnowledgeBase, list[tuple[str, list[str], list[str]]]]:
    """Restate every page we have English for; carry the rest through.

    Returns the corpus and the list of restatements rejected by the figure
    check, as ``(entry_id, missing, invented)``.
    """
    moment = now or datetime.now(timezone.utc)
    entries: list[kb.KnowledgeEntry] = []
    rejected: list[tuple[str, list[str], list[str]]] = []

    for entry in raw.entries:
        restatement = english.get(entry.id)
        if restatement is None:
            entries.append(entry)
            continue

        title, text = restatement
        _, missing, invented = numbers_match(entry.content, text)
        missing = [figure for figure in missing if figure not in allow.get(entry.id, set())]
        if missing or invented:
            rejected.append((entry.id, missing, invented))
            entries.append(entry)
            continue

        entries.append(
            kb.KnowledgeEntry(
                id=entry.id,
                title=title,
                url=entry.url,
                language="en",
                category=entry.category,
                content=text,
                # The page as ARDB published it, carried alongside the English
                # so a moderator can check a draft against the original. Never
                # sent to Claude.
                source_text=entry.content,
                source_language=entry.language,
            )
        )

    corpus = kb.KnowledgeBase(
        version=f"{kb.build_version(len(entries), moment)}-en",
        generated_at=moment.isoformat().replace("+00:00", "Z"),
        source=raw.source,
        entries=tuple(sorted(entries, key=lambda item: item.id)),
        stage="corpus",
        built_from=raw.provenance,
    )
    return corpus, rejected


def summarize(
    corpus: kb.KnowledgeBase,
    raw: kb.KnowledgeBase,
    rejected: list[tuple[str, list[str], list[str]]],
) -> str:
    lines = [
        f"Built from raw {raw.version} ({raw.generated_at}, digest {raw.digest}).",
        f"Corpus {corpus.version}: {len(corpus.entries)} entries, "
        f"{corpus.english_count} English.",
        f"  sent per question : {corpus.total_chars:,} chars "
        f"(~{corpus.estimated_tokens:,} tokens)",
        f"  retained, not sent: {corpus.archived_chars:,} chars",
    ]
    if rejected:
        lines.append(f"{len(rejected)} restatement(s) rejected by the figure check:")
        for entry_id, missing, invented in rejected:
            detail = []
            if missing:
                detail.append(f"missing {missing}")
            if invented:
                detail.append(f"invented {invented}")
            lines.append(f"  {entry_id}: {'; '.join(detail)}")
    pending = corpus.pending
    if pending:
        lines.append(
            f"{len(pending)} page(s) still in their published language: "
            + ", ".join(entry.id for entry in pending)
        )
    return "\n".join(lines)


_REVIEW_CHECKLIST = (
    "Every figure in an English entry matches the raw page it came from",
    "No page restated into a language ARDB did not publish it in",
    "`builtFrom` names the raw snapshot currently committed",
    'Hand-written entries ("url": "manual") still present',
    "Outstanding pages, if any, are ones nobody asks about",
)


def build_pr_body(summary: str, corpus: kb.KnowledgeBase) -> str:
    checklist = "\n".join(f"- [ ] {item}" for item in _REVIEW_CHECKLIST)
    return "\n".join(
        [
            "Stage 2 of the knowledge pipeline: rebuild "
            "`knowledge/corpus/ardb-corpus.json` from the raw snapshot in "
            "`knowledge/raw/ardb-raw.json`.",
            "",
            "The bot answers from this file. The raw archive is unchanged by "
            "this pull request.",
            "",
            "```",
            summary,
            "```",
            "",
            "## Review checklist",
            "",
            checklist,
            "",
            f"Corpus: {len(corpus.entries)} entries, "
            f"~{corpus.estimated_tokens:,} tokens. Every question sends the "
            "whole corpus, so growth here is a standing cost on every draft.",
        ]
    )


def check(raw: kb.KnowledgeBase, corpus: kb.KnowledgeBase) -> int:
    """Report whether the committed corpus was built from the committed raw."""
    if not corpus.entries:
        print("No corpus has been built yet. Run stage 2.", file=sys.stderr)
        return 1
    if not raw.entries:
        print(
            "No raw snapshot is committed, so the corpus cannot be verified "
            "against one. Run stage 1.",
            file=sys.stderr,
        )
        return 1

    built_from = corpus.built_from
    if built_from is None:
        print(
            "The corpus does not record which raw snapshot it came from. It "
            "predates the split; rebuild it.",
            file=sys.stderr,
        )
        return 1

    if built_from.digest == raw.digest:
        print(
            f"Corpus {corpus.version} is current: built from raw "
            f"{raw.version} (digest {raw.digest})."
        )
        return 0

    print(
        f"STALE  corpus {corpus.version} was built from digest "
        f"{built_from.digest} ({built_from.version}, {built_from.generated_at}), "
        f"but the committed raw snapshot is {raw.digest} ({raw.version}, "
        f"{raw.generated_at}).\n"
        "The bot is answering from the older scrape. Run stage 2 to rebuild.",
        file=sys.stderr,
    )
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=kb.RAW_PATH)
    parser.add_argument("--corpus", type=Path, default=kb.CORPUS_PATH)
    parser.add_argument("--history", type=Path, default=kb.HISTORY_PATH)
    parser.add_argument(
        "--restatements",
        type=Path,
        default=RESTATEMENTS_DIR,
        help="Directory of restatement modules.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Report whether the committed corpus matches the committed raw, and stop.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--summary-file", type=Path)
    parser.add_argument("--pr-body-file", type=Path)
    args = parser.parse_args(argv)

    raw = kb.load(args.raw)

    if args.check:
        return check(raw, kb.load(args.corpus))

    if not raw.entries:
        print(
            f"No raw snapshot at {_display_path(args.raw)}. Run stage 1 "
            "(tools/scrape_knowledge.py, or the 'Scrape ARDB pages' workflow) "
            "first -- the corpus is built from the archive, not from the site.",
            file=sys.stderr,
        )
        return 2

    if raw.stage != "raw":
        print(
            f"{_display_path(args.raw)} is marked stage {raw.stage!r}, not "
            "'raw'. Building a corpus from a corpus would restate a "
            "translation and lose the published original.",
            file=sys.stderr,
        )
        return 2

    names = discover_restatements(args.restatements)
    if not names:
        print(
            f"No restatement modules in {_display_path(args.restatements)}. "
            "Without them every page stays in its published language.",
            file=sys.stderr,
        )
    else:
        print(f"Restatements: {', '.join(names)}")

    english, allow = load_restatements(names, args.restatements)
    corpus, rejected = build(raw, english, allow)

    summary = summarize(corpus, raw, rejected)
    print("\n" + summary)

    if args.summary_file:
        args.summary_file.write_text(summary + "\n", encoding="utf-8")
    if args.pr_body_file:
        args.pr_body_file.write_text(
            build_pr_body(summary, corpus) + "\n", encoding="utf-8"
        )

    if corpus.english_count == 0:
        print(
            "\nFAIL  not one page was restated. The corpus would be the raw "
            "snapshot under another name, and the Worker's prompt tells Claude "
            "the source material is English. Refusing to write it.",
            file=sys.stderr,
        )
        return 3

    if args.dry_run:
        print("\nDry run -- nothing written.")
        return 1 if (rejected or corpus.pending) else 0

    # Same inputs, same output -- including the timestamp. A build whose only
    # difference from the committed corpus is a newer `generatedAt` opens a
    # pull request that changes nothing the bot reads, and teaches whoever
    # reviews corpus pull requests that they are noise. Stage 2 runs on every
    # merged scrape and on every restatement edit, so that would be often.
    #
    # Both halves have to match. An identical corpus built from a *different*
    # archive still needs writing: ARDB changing only the title of a page
    # whose body is restated leaves the corpus identical while moving the
    # archive's digest, and without the rewrite `--check` would report the
    # corpus stale forever.
    existing = kb.load(args.corpus)
    if (
        existing.entries
        and existing.digest == corpus.digest
        and existing.built_from is not None
        and existing.built_from.digest == raw.digest
    ):
        print(
            f"\nUnchanged: {_display_path(args.corpus)} already holds digest "
            f"{corpus.digest}, built from this same archive. Nothing written."
        )
        if step_output := os.environ.get("GITHUB_OUTPUT"):
            with open(step_output, "a", encoding="utf-8") as handle:
                handle.write(f"version={existing.version}\n")
                handle.write(f"entries={len(existing.entries)}\n")
                handle.write(f"english={existing.english_count}\n")
                handle.write(f"pending={len(existing.pending)}\n")
                handle.write("changed=false\n")
        return 1 if (rejected or corpus.pending) else 0

    args.corpus.parent.mkdir(parents=True, exist_ok=True)
    kb.dump(corpus, args.corpus)
    kb.append_history(
        {
            "at": corpus.generated_at,
            "stage": "corpus",
            "version": corpus.version,
            "entries": len(corpus.entries),
            "english": corpus.english_count,
            "chars": corpus.total_chars,
            "digest": corpus.digest,
            "builtFrom": raw.provenance.to_dict(),
            "restatements": list(names),
            "pending": [entry.id for entry in corpus.pending],
        },
        args.history,
    )
    print(f"\nWrote {_display_path(args.corpus)} at version {corpus.version}.")
    print(f"Logged to {_display_path(args.history)}.")

    if step_output := os.environ.get("GITHUB_OUTPUT"):
        with open(step_output, "a", encoding="utf-8") as handle:
            handle.write(f"version={corpus.version}\n")
            handle.write(f"entries={len(corpus.entries)}\n")
            handle.write(f"english={corpus.english_count}\n")
            handle.write(f"pending={len(corpus.pending)}\n")
            handle.write("changed=true\n")

    return 1 if (rejected or corpus.pending) else 0


if __name__ == "__main__":
    sys.exit(main())
