# ARDB knowledge base

Two files, written by two separate steps, and the separation is the point.

```
www.ardb.com.kh ──1──▶ raw/ardb-raw.json ──2──▶ corpus/ardb-corpus.json ──▶ the bot
                       as published              one language, reviewed
```

| | file | what it is | who writes it | does the bot read it? |
| --- | --- | --- | --- | --- |
| **1** | `raw/ardb-raw.json` | ARDB's pages exactly as published — Khmer where ARDB wrote Khmer, nothing translated | `tools/scrape_knowledge.py` | no |
| **2** | `corpus/ardb-corpus.json` | the same material restated in one language, built from the archive | `tools/build_corpus.py` | **yes** |

`HISTORY.jsonl` is the ledger over both: one line per run, with its timestamp,
version, entry count and content digest, and for a build the archive it came
from. Git versions the files; this is the readable index over that history, so
answering "when did this rate last change, and which scrape introduced it?"
does not mean checking out old commits.

It records runs that *changed* something. Both stages compare content
digests and leave the file untouched — timestamps and all — when the result
matches what is already committed, so an unchanged run writes no file, adds no
ledger line and opens no pull request. A gap in the dates means nothing
changed, not that nothing ran; the workflow run log is the record of every
attempt.

That idempotence is deliberate. Without it a monthly scrape of untouched pages,
and a rebuild after any restatement edit, would each open a pull request whose
whole content is a newer timestamp — and a reviewer who has waved through three
of those will skim the fourth, which is the one where a rate moved.

## Why two files

While one file served both purposes, every re-scrape overwrote reviewed
English with raw Khmer — and the Worker's prompt went on telling Claude the
source material was English. Nothing failed loudly; the bot just got worse.

Separated, a scrape cannot change anything a customer sees. It writes the
archive, and the corpus the bot answers from is unchanged until a build runs
and that build is merged. The archive also stops being disposable: it is the
evidence behind every English sentence the bot sends.

Three guards keep the two from being confused, because they differ by one path
component and the mistake is a one-word typo in a workflow:

- each file records its own `stage`, and both tools refuse to write over the
  other one — the scraper will not overwrite a corpus, the builder will not
  build from one
- CI asserts the archive contains no restated entry
- CI rebuilds the corpus from the committed archive and fails if the result
  differs, so a hand-edit to the corpus cannot survive unnoticed

## What is in it now

33 entries: 9 loan products, 4 deposit products, 3 digital-banking pages, the
FAQ, and 16 service, contact and corporate pages.

Every corpus entry's `content` is English. ARDB publishes in Khmer and English
and not always the same material in each, so the corpus is normalized to one
language: `content` is the English text, `sourceText` keeps the page verbatim,
and `sourceLanguage` says which it was. **`sourceText` is never sent to
Claude** — it is there so a moderator can check a draft against the original
wording without opening the archive.

Current size: 79,769 characters, roughly 22,791 tokens, sent with every
question. That is the point of the prompt-cache breakpoint — cheap on every
request after the first — but it is also why the corpus is curated rather than
everything the crawler found.

## Stage 1 — refresh the archive

On GitHub (this repository's sandbox cannot reach www.ardb.com.kh):

```
Actions → Scrape ARDB pages (stage 1) → Run workflow
```

Locally, with network access:

```bash
python tools/scrape_knowledge.py --dry-run   # see what it would keep
python tools/scrape_knowledge.py             # write the archive
```

`tools/ardb/scraper.py` walks the public pages, keeps the product, service,
FAQ, contact and corporate pages, renders rate tables one row per line, strips
the chrome, and writes the file sorted by entry ID. Sorted output matters: the
rendered corpus has to be byte-identical between requests or the prompt cache
misses on every question.

Review the diff before merging. The scraper is a heuristic over a WordPress
theme and will occasionally pick up a navigation blob or miss a page.

## Stage 2 — rebuild the corpus

Runs automatically once a stage 1 pull request lands on the default branch, or
by hand:

```
Actions → Build corpus (stage 2) → Run workflow
```

```bash
python tools/build_corpus.py           # build it
python tools/build_corpus.py --check   # is the committed corpus current?
python tools/build_corpus.py --dry-run # report without writing
```

No network, no API key. The English comes from the modules in
[`restatements/`](restatements/README.md), discovered automatically, and a
restatement is accepted only if every figure ARDB published survives it —
checked mechanically by `ardb.normalize.numbers_match`. A page whose figures
do not survive, or that no module covers, is carried into the corpus in its
published language and named in the output. Better a Khmer page the bot can
still quote than an unverified translation of an interest rate.

`--check` answers the one question a two-stage pipeline makes possible to get
wrong: the corpus records the digest of the archive it was built from, so a
corpus left behind by a newer scrape is detectable rather than quietly served.
CI reports that as a warning, not a failure — a merged scrape legitimately
sits ahead of the corpus until stage 2 runs.

For a page no restatement module covers, `tools/consolidate_knowledge.py`
restates it with Claude under the same figure check. It needs an API key; the
hand-written route does not, and is reproducible without one.

## Editing by hand

Hand-editing the **archive** is expected and supported — it is often the
fastest way to fix a bad answer. Add an entry with a `url` of `manual` and the
scraper will preserve it across re-scrapes:

```json
{
  "id": "manual-loan-eligibility",
  "title": "Who can apply for an ARDB agricultural loan",
  "url": "manual",
  "language": "en",
  "category": "loan-products",
  "content": "Plain text. No markup. State facts, not marketing copy."
}
```

Then run stage 2 to carry it into the corpus.

Do **not** hand-edit the corpus. It is generated, CI checks it against a fresh
build of the archive, and the next stage 2 run would revert the edit. Edit the
archive, or add a restatement module.

Two rules, both load-bearing:

1. **Only facts ARDB has published or approved.** Claude is forbidden from
   stating a number that does not appear verbatim in the corpus, which makes
   these files the single point where a wrong rate becomes a wrong answer.
2. **No customer data, ever.** Both files are in git.

## Where ARDB's own figures disagree

The FAQ and the product pages publish **different interest rates for the same
products**. Each entry restates its own page as published; neither was
reconciled against the other, because the bank's own site is what a moderator
is answering from.

| product | product page | FAQ |
| --- | --- | --- |
| agricultural community credit | 7%–9% | 10.5% working capital, 9.5% investment |
| small-scale agriculture credit | 10% / 11% and 8% / 9% | 8%–11% |

A moderator reviewing a draft about either product should check the rate
against the bank's current internal schedule before sending it. A manual entry
overriding both would be the clean fix once that schedule is known.

## Coverage still worth adding

The scraped pages do not cover:

- Branch and mobile-office opening hours
- The complaints process
- How to enrol in the mobile app, and how to reset a password
- Fees that are not on the trade finance or transfer pages
- Rates current as of today, as opposed to as published on the website
