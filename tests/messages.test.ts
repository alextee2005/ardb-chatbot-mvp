import { describe, expect, it } from "vitest";

import { bilingual, CUSTOMER_MESSAGES } from "../src/core/messages.js";

const KHMER = /[ក-៿]/u;
const LATIN = /[A-Za-z]/u;

describe("customer messages", () => {
  it("renders every customer-facing string in both languages", () => {
    for (const [name, text] of Object.entries(CUSTOMER_MESSAGES)) {
      expect(KHMER.test(text), `${name} is missing Khmer`).toBe(true);
      expect(LATIN.test(text), `${name} is missing English`).toBe(true);
    }
  });

  it("leads with Khmer in every message", () => {
    for (const [name, text] of Object.entries(CUSTOMER_MESSAGES)) {
      const firstKhmer = text.search(KHMER);
      const firstLatin = text.search(LATIN);
      expect(firstKhmer, `${name} does not lead with Khmer`).toBeLessThan(firstLatin);
    }
  });

  it("carries the exact English wording the spec asked for", () => {
    expect(CUSTOMER_MESSAGES.greeting).toContain(
      "Hi, my name is ARDB Bot. How can I help you today?",
    );
    expect(CUSTOMER_MESSAGES.acknowledgement).toContain(
      "Please give me some time to respond to you.",
    );
  });

  it("stays well inside Telegram's message limit", () => {
    for (const text of Object.values(CUSTOMER_MESSAGES)) {
      expect(text.length).toBeLessThan(4096);
    }
  });
});

describe("bilingual", () => {
  it("separates the two languages visibly", () => {
    const joined = bilingual("ខ្មែរ", "English");
    expect(joined.indexOf("ខ្មែរ")).toBeLessThan(joined.indexOf("English"));
    expect(joined).toContain("—");
  });
});
