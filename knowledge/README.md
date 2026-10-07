# ARDB knowledge base

`ardb-knowledge.json` is the only thing grounding Claude's drafts in ARDB
reality. Everything in it is sent with every question, behind a prompt-cache
breakpoint, so there is no retrieval step that can miss the relevant page.

**The file in git is a placeholder with zero entries.** Until it is populated,
Claude is instructed to say it does not have ARDB-specific details, so drafts
will be honest but close to useless. Populate it before any real use.

## Regenerating

```bash
npm run scrape
```

`scripts/scrape-ardb.mjs` walks the public pages of www.ardb.com.kh, keeps the
product, service, FAQ and contact pages, strips the chrome, and rewrites this
file sorted by entry ID. Sorted output matters: the rendered corpus has to be
byte-identical between requests or the prompt cache misses on every question.

Review the diff before committing. The scraper is a heuristic over a WordPress
theme and will occasionally pick up a navigation blob or miss a page.

## Editing by hand

Hand-editing is expected and supported — it is often the fastest way to fix a
bad answer. Add an entry with a `source` of `manual` and the scraper will
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

## Coverage worth having

Judging by the site's navigation, the drafts will be weakest without:

- Loan products, with eligibility and required documents per product
- Current interest rates and fees
- Deposit and savings products
- Digital banking: what the app does, how to enrol, how to reset a password
- Branch and mobile-unit locations with opening hours
- Phone numbers and the complaints process
