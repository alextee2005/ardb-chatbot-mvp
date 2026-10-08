/**
 * The grounding corpus: ARDB's own published content, scraped into a file that
 * is reviewed and versioned alongside the code.
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

export interface KnowledgeBase {
  /** Bumped by the scraper on every run. Logged with each draft. */
  version: string;
  generatedAt: string;
  source: string;
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

  return [
    `ARDB published source material (knowledge base version ${kb.version}, scraped from ${kb.source} on ${kb.generatedAt}):`,
    "",
    sections.join("\n\n"),
  ].join("\n");
}
