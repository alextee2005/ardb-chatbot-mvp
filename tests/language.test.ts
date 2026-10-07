import { describe, expect, it } from "vitest";

import { detectLanguage, languageLabel, primaryLanguage } from "../src/core/language.js";

describe("detectLanguage", () => {
  it("identifies pure Khmer", () => {
    expect(detectLanguage("តើខ្ញុំអាចស្នើសុំកម្ចីបានដោយរបៀបណា?")).toBe("km");
  });

  it("identifies pure English", () => {
    expect(detectLanguage("How do I apply for an agricultural loan?")).toBe("en");
  });

  it("treats a Khmer sentence with an English banking term as Khmer", () => {
    // The common real case: Khmer speakers keep product names in English.
    expect(detectLanguage("តើ ARDB មានកម្ចីសម្រាប់កសិករទេ?")).toBe("km");
  });

  it("reports a genuinely balanced sentence as mixed", () => {
    expect(detectLanguage("loan requirements តើត្រូវការឯកសារអ្វីខ្លះសម្រាប់ការស្នើសុំ")).toBe(
      "mixed",
    );
  });

  it("returns unknown when there are no letters at all", () => {
    expect(detectLanguage("12345 !!! 🙏")).toBe("unknown");
    expect(detectLanguage("")).toBe("unknown");
  });

  it("ignores digits and punctuation when weighing the scripts", () => {
    // 1,000,000 riel of digits must not tip an otherwise-Khmer question.
    expect(detectLanguage("ខ្ញុំចង់ខ្ចី 1,000,000 រៀល")).toBe("km");
  });
});

describe("primaryLanguage", () => {
  it("resolves mixed and unknown toward Khmer", () => {
    expect(primaryLanguage("loan តើត្រូវការឯកសារអ្វីខ្លះសម្រាប់ការស្នើសុំកម្ចី")).toBe("km");
    expect(primaryLanguage("?????")).toBe("km");
  });

  it("keeps English for an English question", () => {
    expect(primaryLanguage("What are your interest rates?")).toBe("en");
  });
});

describe("languageLabel", () => {
  it("labels every variant for the moderator card", () => {
    expect(languageLabel("km")).toBe("Khmer");
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel("mixed")).toBe("Mixed Khmer/English");
    expect(languageLabel("unknown")).toBe("Undetermined");
  });
});
