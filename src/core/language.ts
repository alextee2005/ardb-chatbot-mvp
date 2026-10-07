/**
 * Language detection for customer messages.
 *
 * Deliberately a cheap heuristic rather than a model call: it runs on every
 * inbound message and only has to be good enough to pick which canned text to
 * send. The actual answer language is decided by Claude, which sees the raw
 * question and is instructed to match it.
 */

export type Language = "km" | "en" | "mixed" | "unknown";

/** Khmer block U+1780–U+17FF, plus Khmer symbols U+19E0–U+19FF. */
const KHMER_RE = /[ក-៿᧠-᧿]/gu;
const LATIN_RE = /[A-Za-z]/gu;

/**
 * Classify a message by script.
 *
 * `mixed` is reported when both scripts carry real weight (each at least a
 * quarter of the letters). Khmer speakers routinely drop English banking terms
 * into a Khmer sentence, so `mixed` resolves toward Khmer for canned replies --
 * see `primaryLanguage`.
 */
export function detectLanguage(text: string): Language {
  const khmer = (text.match(KHMER_RE) ?? []).length;
  const latin = (text.match(LATIN_RE) ?? []).length;
  const total = khmer + latin;

  if (total === 0) return "unknown";

  const khmerShare = khmer / total;
  if (khmerShare >= 0.75) return "km";
  if (khmerShare <= 0.25) return "en";
  return "mixed";
}

/**
 * Collapse to the single language whose canned text should lead.
 *
 * Khmer wins ties and `mixed`: a Khmer speaker reading English is a worse
 * outcome than an English speaker reading Khmer, because every canned message
 * we send contains both.
 */
export function primaryLanguage(text: string): "km" | "en" {
  const detected = detectLanguage(text);
  return detected === "en" ? "en" : "km";
}

/**
 * Human-readable label for the moderator card, so a moderator can see at a
 * glance what language the draft should be in without reading the question.
 */
export function languageLabel(language: Language): string {
  switch (language) {
    case "km":
      return "Khmer";
    case "en":
      return "English";
    case "mixed":
      return "Mixed Khmer/English";
    case "unknown":
      return "Undetermined";
  }
}
