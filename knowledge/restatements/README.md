# Hand-written English restatements

These are the English reference texts for the ARDB corpus, written by reading
each Khmer page directly rather than by calling the Claude API. They exist
because `tools/consolidate_knowledge.py` needs API credits, and the work does
not: the pages are already in this repository.

Apply them with:

```bash
python tools/apply_restatements.py english_batch1 english_batch2 english_batch3
```

The same contract as the automated consolidator applies, and is enforced the
same way:

- an entry's `content` becomes the English text
- the verbatim Khmer is retained as `sourceText`, which is never sent to Claude
- **an entry is only replaced if every published figure survives**, checked by
  `ardb.normalize.numbers_match`

That last point is why this is not simply trusting a translation. The figure
check is mechanical and independent of whoever wrote the English, and it has
already caught a real omission: the agro-enterprise page has five loan
variants, and the first draft of that entry described four, dropping the
overdraft facility capped at 1,000,000 US dollars.

## ALLOW_MISSING

A batch may declare figures it deliberately leaves out, with the reason. The
homepage is the only current case: it carries a rolling news feed whose
headline dates and a rice export tonnage would be sent with every customer
question and go stale within weeks, so the entry keeps the contact details —
the page's lasting content — and drops the news.

This is an escape hatch for editorial judgement, not for silence. Every figure
not listed is still enforced, and anything listed shows up in the apply
output.

## Updating

Re-scraping replaces `content` with fresh Khmer and drops `sourceText`, so a
re-scrape undoes these restatements and they must be re-applied. If the page
changed, the figure check will fail the stale entry rather than let an
out-of-date rate through — which is the behaviour we want.
