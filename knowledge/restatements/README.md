# Hand-written English restatements

These are the English reference texts for the ARDB corpus, written by reading
each Khmer page directly rather than by calling the Claude API. They exist
because `tools/consolidate_knowledge.py` needs API credits, and the work does
not: the pages are already in this repository.

They are stage 2 of the knowledge pipeline, applied by:

```bash
python tools/build_corpus.py
```

Modules here are **discovered automatically** — a new batch needs no argument
and no registration. Listing them on a command line was how a batch got left
off, and a batch left off means pages stay Khmer in a corpus the prompt
describes as English.

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

Re-running is safe, and re-running is in fact the only way the corpus is ever
written. Every build starts from `knowledge/raw/ardb-raw.json` — the pages as
published — rather than from the previous corpus, so a build can never restate
a translation or compare a restatement against itself. CI asserts that
rebuilding the committed archive reproduces the committed corpus exactly.

## The four batches

| batch | entries |
| --- | --- |
| `english_batch1` | the deposit and loan products, and their two index pages |
| `english_batch2` | services, contact details, the board, management, partners |
| `english_batch3` | the FAQ page -- a third of the corpus on its own |
| `english_batch4` | the bank profile, the two statements, social responsibility, the Cam-IE platform, ASPIRE-AT |

All 33 entries are now English.

## Where ARDB's own figures disagree

The FAQ and the product pages publish **different interest rates for the same
products**. Each entry restates its own page as published; neither was
reconciled against the other, because the bank's own site is what a moderator
is answering from.

| product | product page | FAQ |
| --- | --- | --- |
| agricultural community credit | 7%-9% | 10.5% working capital, 9.5% investment |
| small-scale agriculture credit | 10% / 11% and 8% / 9% | 8%-11% |

A moderator reviewing a draft about either product should check the rate
against the bank's current internal schedule before sending it.

## ALLOW_MISSING

A batch may declare figures it deliberately leaves out, with the reason. The
homepage, and its Khmer alias, is the only current case: it carries a rolling
news feed whose headline dates and a rice export tonnage would be sent with
every customer question and go stale within weeks, so the entry keeps the contact details —
the page's lasting content — and drops the news.

This is an escape hatch for editorial judgement, not for silence. Every figure
not listed is still enforced, and anything listed shows up in the apply
output.

## Updating

A re-scrape writes the archive and leaves the corpus alone, so these
restatements are never undone by one. What a re-scrape can do is make one
*stale*: if ARDB changed a figure on a page, the figure check fails that
restatement on the next build, and the page is carried into the corpus in its
published Khmer rather than with an out-of-date English rate. That failure is
the signal to re-read the page and rewrite the entry — the check is doing its
job, not getting in the way.
