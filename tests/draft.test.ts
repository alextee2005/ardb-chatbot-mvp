import { describe, expect, it } from "vitest";

import { buildSystemBlocks, buildUserMessage } from "../src/core/draft.js";
import { isPlaceholder, renderKnowledge, type KnowledgeBase } from "../src/core/knowledge.js";

const empty: KnowledgeBase = {
  version: "0.0.0-placeholder",
  generatedAt: "1970-01-01T00:00:00.000Z",
  source: "https://www.ardb.com.kh",
  entries: [],
};

const populated: KnowledgeBase = {
  version: "2026-10-07-2",
  generatedAt: "2026-10-07T00:00:00.000Z",
  source: "https://www.ardb.com.kh",
  entries: [
    {
      id: "agricultural-loan",
      title: "Agricultural loan",
      url: "https://www.ardb.com.kh/agricultural-loan/",
      language: "en",
      category: "loan-products",
      content: "Available to farmers and agricultural cooperatives.",
    },
    {
      id: "branches",
      title: "Branches",
      url: "https://www.ardb.com.kh/branches/",
      language: "en",
      category: "branches-and-contact",
      content: "Battambang branch and 14 mobile units.",
    },
  ],
};

describe("isPlaceholder", () => {
  it("flags the committed placeholder so /health can report it", () => {
    expect(isPlaceholder(empty)).toBe(true);
    expect(isPlaceholder(populated)).toBe(false);
  });
});

describe("renderKnowledge", () => {
  it("states the absence of source material rather than rendering nothing", () => {
    // Silence here would let Claude fall back on general banking knowledge.
    expect(renderKnowledge(empty)).toContain("No ARDB source material");
  });

  it("includes every entry with its provenance", () => {
    const rendered = renderKnowledge(populated);
    expect(rendered).toContain("agricultural-loan");
    expect(rendered).toContain("https://www.ardb.com.kh/branches/");
    expect(rendered).toContain("Battambang branch and 14 mobile units.");
    expect(rendered).toContain("2026-10-07-2");
  });

  it("is byte-stable across calls, so the prompt cache can hit", () => {
    expect(renderKnowledge(populated)).toBe(renderKnowledge(populated));
  });

  it("dates the material by the scrape, not by the corpus build", () => {
    // A moderator asking how old a rate is wants to know when ARDB's page was
    // read. Rebuilding the corpus -- which happens whenever a restatement is
    // edited -- does not make the underlying pages any fresher, so reporting
    // the build date would overstate the freshness of every figure.
    const rebuilt: KnowledgeBase = {
      ...populated,
      version: "2026-12-01-2-en",
      generatedAt: "2026-12-01T00:00:00.000Z",
      stage: "corpus",
      builtFrom: {
        version: "2026-10-07-2",
        generatedAt: "2026-10-07T00:00:00.000Z",
        digest: "43dade5c8902820e",
        source: "https://www.ardb.com.kh",
      },
    };

    const rendered = renderKnowledge(rebuilt);
    expect(rendered).toContain("scraped from https://www.ardb.com.kh on 2026-10-07T00:00:00.000Z");
    expect(rendered).not.toContain("2026-12-01T00:00:00.000Z");
    // The corpus version still identifies which build produced a draft.
    expect(rendered).toContain("2026-12-01-2-en");
  });

  it("falls back to generatedAt when there is no provenance", () => {
    expect(renderKnowledge(populated)).toContain("on 2026-10-07T00:00:00.000Z");
  });
});

describe("buildSystemBlocks", () => {
  it("puts the cache breakpoint on the last block, covering the whole prefix", () => {
    const blocks = buildSystemBlocks(populated);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("keeps the instructions free of anything that varies per request", () => {
    // A timestamp or ticket ID in the prefix would invalidate the cache on
    // every single question.
    const instructions = buildSystemBlocks(populated)[0]?.text ?? "";
    expect(instructions).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(buildSystemBlocks(populated)[0]?.text).toBe(
      buildSystemBlocks(empty)[0]?.text,
    );
  });

  it("forbids inventing numbers and account access", () => {
    const instructions = buildSystemBlocks(populated)[0]?.text ?? "";
    expect(instructions).toMatch(/never estimate/i);
    expect(instructions).toMatch(/no access to any customer's account/i);
    expect(instructions).toMatch(/never promise/i);
  });

  it("explains that ARDB's comma means both things, by group size", () => {
    // The corpus is normalized English, but a failed consolidation leaves an
    // entry in Khmer -- where the same comma is a decimal point in "១,៥០%"
    // and a thousands separator in "៤០,០០០". Reading it one way only is how
    // 4.00% becomes 400%, or 40,000 riel becomes 40.
    const instructions = buildSystemBlocks(populated)[0]?.text ?? "";
    expect(instructions).toMatch(/full stop is the decimal point/i);
    expect(instructions).toMatch(/comma BOTH ways/);
    expect(instructions).toMatch(/size of the group after it/i);
    expect(instructions).toContain("400%");
    expect(instructions).toContain("40,000 riel becomes 40");
  });

  it("stops an English corpus from pulling answers into English", () => {
    // Every entry is English now, which is a standing nudge toward replying
    // in English to Khmer-speaking farmers.
    const instructions = buildSystemBlocks(populated)[0]?.text ?? "";
    expect(instructions).toMatch(/not a hint about what language to reply in/i);
    expect(instructions).toMatch(/reply in Khmer/i);
  });

  it("never renders retained source text into the prompt", () => {
    // sourceText doubles the corpus and the model does not read it.
    const withSource = {
      ...populated,
      entries: [
        { ...populated.entries[0]!, sourceText: "កម្ចីកសិកម្ម ១,៥០%", sourceLanguage: "km" as const },
      ],
    };
    const rendered = buildSystemBlocks(withSource)[1]?.text ?? "";
    expect(rendered).not.toContain("កម្ចីកសិកម្ម");
    expect(rendered).not.toContain("១,៥០%");
  });
});

describe("buildUserMessage", () => {
  it("carries the question and the detection hint", () => {
    const message = buildUserMessage({
      question: "  តើអត្រាការប្រាក់ប៉ុន្មាន?  ",
      questionLanguage: "km",
      knowledge: populated,
    });
    expect(message).toContain("តើអត្រាការប្រាក់ប៉ុន្មាន?");
    expect(message).toContain("Khmer");
    expect(message).toContain("Trust the question itself");
  });
});
