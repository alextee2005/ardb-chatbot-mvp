# Hand-written English restatements

These are the English reference texts for the ARDB corpus, written by reading
each Khmer page directly rather than by calling the Claude API. They exist
because `tools/consolidate_knowledge.py` needs API credits, and the work does
not: the pages are already in this repository.

Apply them with:

```bash
python tools/apply_restatements.py english_batch1 english_batch2 english_batch3 english_batch4
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

Re-running is safe. An entry that already carries a restatement is checked
against its retained `sourceText` rather than against the English now in
`content`, and keeps the original Khmer, so a second pass cannot overwrite the
audit trail with the translation.

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

Re-scraping replaces `content` with fresh Khmer and drops `sourceText`, so a
re-scrape undoes these restatements and they must be re-applied. If the page
changed, the figure check will fail the stale entry rather than let an
out-of-date rate through — which is the behaviour we want.
