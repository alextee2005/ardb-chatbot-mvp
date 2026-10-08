/**
 * The grounding corpus: ARDB's own published content, restated in one
 * language, reviewed and versioned alongside the code.
 *
 * This is the second of two files. `knowledge/raw/ardb-raw.json` archives the
 * pages exactly as ARDB published them; `knowledge/corpus/ardb-corpus.json`,
 * the one imported here, is built from that archive by
 * `tools/build_corpus.py`. The Worker never reads the archive. The split is
 * what stops a re-scrape from replacing reviewed English with raw Khmer: a
 * scrape writes the archive and nothing a customer sees changes until a
 * corpus is built from it and merged.
 *
 * Shape is deliberately flat. Everything is sent to Claude on every request
 * behind a cache breakpoint, so there is no retrieval step to tune or get
 * wrong -- and no chance of the right page being the one retrieval missed.
 * Revisit this only if the corpus outgrows the context window.
 */

export interface KnowledgeEntry {
  /** Stable slug, so a reviewer can refer to an entry in a code review. */
  id: string;
  title: string;
  /** Page the text came from, quoted back to moderators for verification. */
  url: string;
  language: "km" | "en" | "mixed";
  category: string;
  /** The English reference text. This, and only this, goes into the prompt. */
  content: string;
  /**
   * Verbatim Khmer source, present when `content` was rewritten from it.
   *
   * Deliberately never rendered into the prompt. It exists so a reviewer can
   * check a consolidation, and so a bad answer can be traced back months
   * later to what ARDB actually published. Including it would double the
   * tokens on every question and defeat the point of consolidating.
   */
  sourceText?: string;
  sourceLanguage?: "km" | "en" | "mixed";
}

/** Which snapshot a file was built from. */
export interface Provenance {
  version: string;
  generatedAt: string;
  /** Content fingerprint of that snapshot's entries. */
  digest: string;
  source: string;
}

export interface KnowledgeBase {
  /** Bumped on every build. Logged with each draft. */
  version: string;
  /** When this corpus was built -- not when ARDB's pages were read. */
  generatedAt: string;
  source: string;
  /** `"corpus"` for the file the Worker imports; `"raw"` for the archive. */
  stage?: "raw" | "corpus";
  /**
   * The raw snapshot this corpus was built from, which is where `generatedAt`
   * stops being the useful date: a corpus rebuilt today from a scrape taken
   * in March is three months stale, and only this field says so.
   */
  builtFrom?: Provenance;
  entries: KnowledgeEntry[];
}

export function isPlaceholder(kb: KnowledgeBase): boolean {
  return kb.entries.length === 0 || kb.version.includes("placeholder");
}

/**
 * Render the corpus as the stable tail of the system prompt.
 *
 * Entry order is the file's order and the scraper writes it sorted, which
 * keeps the rendered string byte-identical between requests -- the condition
 * for the prompt cache to hit.
 */
export function renderKnowledge(kb: KnowledgeBase): string {
  if (kb.entries.length === 0) {
    return "No ARDB source material has been loaded yet. You therefore do not know any ARDB-specific product details, rates, fees or requirements.";
  }

  // `sourceText` is pointedly absent: the corpus is sent in full with every
  // question, so carrying the Khmer original alongside the English would
  // double the cost of every draft for material the model does not read.
  const sections = kb.entries.map((entry) =>
    [
      `<document id="${entry.id}">`,
      `<title>${entry.title}</title>`,
      `<url>${entry.url}</url>`,
      `<category>${entry.category}</category>`,
      entry.content.trim(),
      "</document>",
    ].join("\n"),
  );

  // The scrape date, not the build date. A moderator asking "how old is this
  // rate?" is asking when ARDB's page was read, and rebuilding the corpus
  // does not make the underlying pages any fresher.
  const scrapedAt = kb.builtFrom?.generatedAt ?? kb.generatedAt;

  return [
    `ARDB published source material (knowledge base version ${kb.version}, scraped from ${kb.source} on ${scrapedAt}):`,
    "",
    sections.join("\n\n"),
  ].join("\n");
}
