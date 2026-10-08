"""Apply hand-written English restatements to the knowledge file.

Same contract as the automated consolidator: `content` becomes the English
text, the verbatim Khmer is kept as `sourceText`, and an entry is only
replaced if its figures survive. Entries without a restatement keep their
Khmer text, which is a supported mixed corpus.
"""
import importlib, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/home/user/ardb-chatbot-mvp/tools")
sys.path.insert(0, "/tmp/claude-0/-home-user-ardb-chatbot-mvp/25e145e0-9483-59bc-a4a0-e39e9e3b7224/scratchpad")

from ardb import knowledge as kb
from ardb.normalize import numbers_match

KB = Path("/home/user/ardb-chatbot-mvp/knowledge/ardb-knowledge.json")

english, allow = {}, {}
for name in sys.argv[1:]:
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
    ok, missing, invented = numbers_match(entry.content, text)
    missing = [m for m in missing if m not in allow.get(entry.id, set())]
    if missing or invented:
        failed.append((entry.id, missing, invented))
        out.append(entry)
        continue
    out.append(
        kb.KnowledgeEntry(
            id=entry.id, title=title, url=entry.url, language="en",
            category=entry.category, content=text,
            source_text=entry.content, source_language=entry.language,
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
