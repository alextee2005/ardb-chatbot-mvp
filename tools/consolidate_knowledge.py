#!/usr/bin/env python3
"""Consolidate the scraped corpus into one normalized English knowledge base.

    ANTHROPIC_API_KEY=... python tools/consolidate_knowledge.py
    ANTHROPIC_API_KEY=... python tools/consolidate_knowledge.py --only faq
    ANTHROPIC_API_KEY=... python tools/consolidate_knowledge.py --dry-run

Reads knowledge/ardb-knowledge.json, restates each page in English, verifies
every published figure survived, and writes the file back with the English
text as `content` and the Khmer original retained as `sourceText`.

Already-consolidated entries are skipped unless --force is given, so a re-run
after a partial failure costs only the entries that failed.

Set ANTHROPIC_WORKSPACE_ID when the API key is an organization-level key
rather than one scoped to a workspace; the Messages API rejects every request
from an unscoped key unless the workspace is named.

Exit codes: 0 all entries verified, 1 some entries failed but others
succeeded (the file is written, failures left at their previous text), 2
misconfigured or the credentials were rejected, 3 every entry failed, which
is systematic rather than a corpus problem.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from ardb import knowledge as kb
from ardb.consolidate import (
    DEFAULT_MODEL,
    FatalConsolidationError,
    TRANSPORT_FAILURE,
    VERIFICATION_FAILURE,
    build_client,
    consolidate_entry,
    verify_credentials,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = REPO_ROOT / "knowledge" / "ardb-knowledge.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--effort",
        default="high",
        choices=("low", "medium", "high", "xhigh", "max"),
        help="Defaults to high: this runs once per page in a batch, and a "
        "figure dropped here is wrong for every answer afterwards.",
    )
    parser.add_argument(
        "--only",
        action="append",
        metavar="ID",
        help="Consolidate only these entry IDs. Repeatable.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-consolidate entries that already have sourceText.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--summary-file", type=Path)
    parser.add_argument("--pr-body-file", type=Path)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set.", file=sys.stderr)
        return 2

    output = args.output or args.input
    base = kb.load(args.input)
    if not base.entries:
        print(f"{args.input} has no entries. Run the scraper first.", file=sys.stderr)
        return 2

    client = build_client(workspace_id=os.environ.get("ANTHROPIC_WORKSPACE_ID"))

    selected = [
        entry
        for entry in base.entries
        if (args.only is None or entry.id in args.only)
        and (args.force or not entry.is_consolidated)
    ]

    if not selected:
        print("Nothing to consolidate. Use --force to redo existing entries.")
        return 0

    # One minimal request first. A credential problem found here costs a
    # second; found at entry 33 it costs a run and a misleading report.
    try:
        verify_credentials(client, model=args.model)
    except FatalConsolidationError as error:
        print(f"{error}", file=sys.stderr)
        print(
            "\nNothing was sent and no entry was consolidated. "
            "No entry failed verification.",
            file=sys.stderr,
        )
        return 2

    print(f"Consolidating {len(selected)} of {len(base.entries)} entries with {args.model}…\n")

    results = {}
    failures = []

    for index, entry in enumerate(selected, start=1):
        print(f"[{index}/{len(selected)}] {entry.id}", flush=True)
        try:
            result = consolidate_entry(
                client, entry, model=args.model, effort=args.effort
            )
        except FatalConsolidationError as error:
            # A run-level problem, not an entry-level one. Reporting it per
            # entry as a verification failure -- which an earlier version did
            # -- sends people looking for translation faults that do not
            # exist, so say plainly what is wrong and stop.
            print(f"\n{error}", file=sys.stderr)
            print(
                f"\nStopped at entry {index} of {len(selected)}. "
                "Nothing was written and no entry failed verification.",
                file=sys.stderr,
            )
            return 2

        results[entry.id] = result

        if result.ok:
            detail = f" ({result.note})" if result.note else ""
            print(
                f"    verified · {len(entry.content):,} Khmer chars → "
                f"{len(result.entry.content):,} English{detail}"
            )
        else:
            problems = []
            if result.missing_numbers:
                problems.append(f"dropped {', '.join(result.missing_numbers)}")
            if result.invented_numbers:
                problems.append(f"invented {', '.join(result.invented_numbers)}")
            if result.note:
                problems.append(result.note)
            reason = "; ".join(problems) or "unknown"
            label = "FIGURE MISMATCH" if result.failed_verification else "NOT CONSOLIDATED"
            print(f"    {label} · {reason}")
            failures.append((entry.id, result.failure_kind, reason))

    # A failed entry keeps whatever it had. Replacing ARDB's own words with an
    # unverified rewrite is the one outcome worth refusing outright.
    merged = tuple(
        results[entry.id].entry
        if entry.id in results and results[entry.id].ok
        else entry
        for entry in base.entries
    )

    now = datetime.now(timezone.utc)
    result_kb = kb.KnowledgeBase(
        version=f"{kb.build_version(len(merged), now)}-en",
        generated_at=now.isoformat().replace("+00:00", "Z"),
        source=base.source,
        entries=merged,
    )

    summary = _summarize(result_kb, selected, failures)
    print("\n" + summary)

    if args.summary_file:
        args.summary_file.write_text(summary + "\n", encoding="utf-8")
    if args.pr_body_file:
        args.pr_body_file.write_text(
            _pr_body(summary, failures) + "\n", encoding="utf-8"
        )

    if args.dry_run:
        print("\nDry run — nothing written.")
    else:
        kb.dump(result_kb, output)
        print(f"\nWrote {output.relative_to(REPO_ROOT)} at version {result_kb.version}.")

    # Nothing consolidated at all is not a partial result. The credential
    # pre-flight passed, so this is something systematic that it did not
    # cover, and reporting it as a warning on a green run -- which is what
    # happened before -- hides a total failure behind a success.
    if len(failures) == len(selected):
        print(
            f"\nEvery one of the {len(selected)} entries failed. That is a "
            "systematic problem rather than a corpus one; the causes are "
            "listed above.",
            file=sys.stderr,
        )
        return 3

    return 1 if failures else 0


def _summarize(result: kb.KnowledgeBase, selected, failures) -> str:
    lines = [
        f"Consolidated {len(selected) - len(failures)} of {len(selected)} entries.",
        f"Corpus: {len(result.entries)} entries, "
        f"{result.consolidated_count} in English, "
        f"{result.total_chars:,} characters sent per question "
        f"(~{result.estimated_tokens:,} tokens).",
        f"Retained Khmer source: {result.archived_chars:,} characters, never sent.",
    ]
    if not failures:
        return "\n".join(lines)

    # Grouped by cause, because the responses differ: a figure mismatch needs
    # the translation reviewed, a transport failure needs a re-run, and a
    # model failure usually needs the page split or written by hand.
    by_kind: dict[str | None, list[tuple[str, str]]] = {}
    for entry_id, kind, reason in failures:
        by_kind.setdefault(kind, []).append((entry_id, reason))

    headings = {
        VERIFICATION_FAILURE: "failed figure verification (review the translation)",
        TRANSPORT_FAILURE: "could not reach Claude (re-run to retry)",
        None: "were not consolidated",
    }

    for kind, entries in by_kind.items():
        lines.append("")
        heading = headings.get(kind, "could not be consolidated (model output unusable)")
        lines.append(
            f"{len(entries)} entr{'y' if len(entries) == 1 else 'ies'} {heading}, "
            "and kept their Khmer text:"
        )
        lines.extend(f"  - {entry_id}: {reason}" for entry_id, reason in entries)

    return "\n".join(lines)


def _pr_body(summary: str, failures) -> str:
    checklist = [
        "Rates, fees and ceilings match `sourceText` figure for figure",
        "Each rate is still attached to the right term and currency",
        "No product's eligibility or document list lost an item",
        "No sentence states something ARDB does not publish",
        "Entries that failed verification are either fixed or left in Khmer",
    ]
    parts = [
        "Consolidated the ARDB corpus into one normalized English knowledge base.",
        "",
        "```",
        summary,
        "```",
        "",
        "## What changed",
        "",
        "Each entry's `content` is now English reference text; the verbatim Khmer "
        "page is retained as `sourceText`, which is **not** sent to Claude at "
        "draft time and exists so any answer can be traced back to what ARDB "
        "published.",
        "",
        "Figures were converted from Khmer numerals and ARDB's separator "
        "convention mechanically, before the model saw them, and every entry was "
        "checked for figure preservation — a dropped or invented number fails the "
        "entry rather than shipping it.",
        "",
        "## Review checklist",
        "",
        *(f"- [ ] {item}" for item in checklist),
    ]
    mismatches = [f for f in failures if f[1] == VERIFICATION_FAILURE]
    others = [f for f in failures if f[1] != VERIFICATION_FAILURE]

    if mismatches:
        parts += [
            "",
            "## Figure mismatches — review these first",
            "",
            "These entries kept their Khmer text because the English draft "
            "dropped or invented a figure.",
            "",
            *(f"- `{entry_id}`: {reason}" for entry_id, _, reason in mismatches),
        ]
    if others:
        parts += [
            "",
            "## Not consolidated",
            "",
            "These failed before verification, so nothing is wrong with the "
            "translation — they kept their Khmer text and a re-run will retry them.",
            "",
            *(f"- `{entry_id}`: {reason}" for entry_id, _, reason in others),
        ]
    return "\n".join(parts)


if __name__ == "__main__":
    sys.exit(main())
