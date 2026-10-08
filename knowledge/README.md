# ARDB knowledge base

`ardb-knowledge.json` is the only thing grounding Claude's drafts in ARDB
reality. Everything in it is sent with every question, behind a prompt-cache
breakpoint, so there is no retrieval step that can miss the relevant page.

## What is in it now

33 entries scraped from www.ardb.com.kh: 9 loan products, 4 deposit products,
3 digital-banking pages, the FAQ, and 16 service, contact and corporate pages.

Every entry's `content` is English. ARDB publishes in Khmer and English and
not always the same material in each, so the corpus was normalized to one
language: `content` is the English text and `sourceText` keeps the page
verbatim as published, with `sourceLanguage` saying which it was. **`sourceText`
is never sent to Claude** — it is there so a moderator can check a draft
against the original wording.

The English was written by reading each page, not by machine translation, and
every entry had to pass a mechanical figure check before it was accepted. See
[`restatements/README.md`](restatements/README.md), which also records the two
products where **ARDB's own FAQ and product pages publish different interest
rates**.

Current size: 79,769 characters, roughly 22,791 tokens, sent with every
question. That is the point of the cache breakpoint — it is cheap on every
request after the first, but it is also why the corpus is curated rather than
simply everything the scraper found.

## Regenerating

Scraping runs on GitHub Actions, because this repository's development sandbox
cannot reach www.ardb.com.kh:

```
Actions -> Scrape knowledge base -> Run workflow
```

It opens a pull request with the new corpus. Locally, with network access:

```bash
python tools/scrape_knowledge.py --output knowledge/ardb-knowledge.json
```

`tools/ardb/scraper.py` walks the public pages, keeps the product, service,
FAQ, contact and corporate pages, renders rate tables one row per line, strips
the chrome, and writes the file sorted by entry ID. Sorted output matters: the
rendered corpus has to be byte-identical between requests or the prompt cache
misses on every question.

**A re-scrape replaces `content` with fresh Khmer and drops `sourceText`, so it
undoes the English normalization.** Re-apply it afterwards:

```bash
python tools/apply_restatements.py english_batch1 english_batch2 english_batch3 english_batch4
```

Where a page has changed, the figure check fails that entry and leaves the
Khmer in place rather than letting a stale rate through. A failure there is the
signal to re-read the page, not to loosen the check.

Review the diff before committing. The scraper is a heuristic over a WordPress
theme and will occasionally pick up a navigation blob or miss a page.

## Editing by hand

Hand-editing is expected and supported — it is often the fastest way to fix a
bad answer. Add an entry with a `url` of `manual` and the scraper will
preserve it:

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

Two rules, both load-bearing:

1. **Only facts ARDB has published or approved.** Claude is forbidden from
   stating a number that does not appear verbatim here, which makes this file
   the single point where a wrong rate becomes a wrong answer.
2. **No customer data, ever.** This file is in git.

## Coverage still worth adding

The scraped pages do not cover:

- Branch and mobile-office opening hours
- The complaints process
- How to enrol in the mobile app, and how to reset a password
- Fees that are not on the trade finance or transfer pages
- Rates current as of today, as opposed to as published on the website
