"""Apply hand-written English restatements to the knowledge file.

Same contract as the automated consolidator: `content` becomes the English
text, the verbatim Khmer is kept as `sourceText`, and an entry is only
replaced if its figures survive. Entries without a restatement keep their
Khmer text, which is a supported mixed corpus.

The restatement modules live in `knowledge/restatements/`; name them without
the `.py`:

    python tools/apply_restatements.py english_batch1 english_batch2

Re-running is safe. An entry that already carries a restatement is checked
against its retained `sourceText`, not against the English now in `content`,
and keeps the original Khmer and its language -- so a second pass cannot
quietly overwrite the audit trail with the translation.
"""
import importlib
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "tools"))
sys.path.insert(0, str(REPO_ROOT / "knowledge" / "restatements"))

from ardb import knowledge as kb
from ardb.normalize import numbers_match

KB = REPO_ROOT / "knowledge" / "ardb-knowledge.json"


def main(names: list[str]) -> int:
    if not names:
        print(__doc__)
        return 2

    english, allow = {}, {}
    for name in names:
        mod = importlib.import_module(name)
        english.update(mod.ENGLISH)
        allow.update(getattr(mod, "ALLOW_MISSING", {}))

    base = kb.load(KB)
    out, failed, applied = [], [], 0

    for entry in base.entries:
        if entry.id not in english:
            out.append(entry)
            continue
        title, text = english[entry.id]
        # The source of truth is the retained original where there is one, so
        # that a re-run compares the restatement against the Khmer rather than
        # against itself.
        source_text = entry.source_text or entry.content
        source_language = entry.source_language or entry.language
        ok, missing, invented = numbers_match(source_text, text)
        missing = [m for m in missing if m not in allow.get(entry.id, set())]
        if missing or invented:
            failed.append((entry.id, missing, invented))
            out.append(entry)
            continue
        out.append(
            kb.KnowledgeEntry(
                id=entry.id, title=title, url=entry.url, language="en",
                category=entry.category, content=text,
                source_text=source_text, source_language=source_language,
            )
        )
        applied += 1

    now = datetime.now(timezone.utc)
    result = kb.KnowledgeBase(
        version=f"{kb.build_version(len(out), now)}-en",
        generated_at=now.isoformat().replace("+00:00", "Z"),
        source=base.source,
        entries=kb.merge_entries(out, ()),
    )
    kb.dump(result, KB)

    print(f"applied {applied}, failed {len(failed)}, untouched {len(out)-applied-len(failed)}")
    for eid, m, i in failed:
        print(f"  FAILED {eid} missing={m} invented={i}")
    print(f"\ncorpus: {len(result.entries)} entries, {result.consolidated_count} English")
    print(f"  sent per question : {result.total_chars:,} chars (~{result.estimated_tokens:,} tokens)")
    print(f"  retained, not sent: {result.archived_chars:,} chars")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
