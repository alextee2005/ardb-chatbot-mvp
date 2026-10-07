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
