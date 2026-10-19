import { describe, expect, it, vi } from "vitest";

import Anthropic from "@anthropic-ai/sdk";

import { draftResponse, supportsServerSideFallback } from "../src/adapters/claude.js";
import type { KnowledgeBase } from "../src/core/knowledge.js";

const knowledge: KnowledgeBase = {
  version: "test-1",
  generatedAt: "2026-10-08T00:00:00Z",
  entries: [{ id: "x", title: "X", url: "https://example.test", content: "Nothing." }],
} as unknown as KnowledgeBase;

const request = { question: "What are the rates?", questionLanguage: "en", knowledge } as never;

/** Fail the API call with `error`, and return what the moderator card would show. */
async function failWith(error: unknown): Promise<string> {
  const spy = vi
    .spyOn(Anthropic.Beta.Messages.prototype, "create")
    .mockRejectedValue(error as Error);
  try {
    const result = await draftResponse(
      { apiKey: "sk-ant-test", model: "claude-haiku-5-5", effort: "low" },
      request,
    );
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.error;
  } finally {
    spy.mockRestore();
  }
}

/** A 400 as the SDK constructs it from a real response body. */
function badRequest(
  message: string,
  requestID: string | null = null,
): InstanceType<typeof Anthropic.APIError> {
  const body = { type: "error", error: { type: "invalid_request_error", message } };
  const headers = new Headers(requestID ? { "request-id": requestID } : {});
  return Anthropic.APIError.generate(400, body, undefined, headers);
}

describe("describeError", () => {
  it("carries the API's own explanation onto the card", async () => {
    // The regression this guards: a card reading only "HTTP 400
    // (invalid_request_error)" names no field and no constraint, so every
    // hypothesis about the cause costs a redeploy. The body says which
    // parameter was rejected; it must survive to the moderator and the log.
    const text = await failWith(
      badRequest("output_config.effort: Input should be a valid string"),
    );
    expect(text).toContain("400");
    expect(text).toContain("invalid_request_error");
    expect(text).toContain("output_config.effort");
  });

  it("includes the request ID when the response carries one", async () => {
    const text = await failWith(badRequest("bad thing", "req_abc123"));
    expect(text).toContain("req_abc123");
  });

  it("clamps a very long message so the card stays sendable", async () => {
    // Telegram rejects a message over 4096 characters, and the question
    // shares the card with this text. A union-validation error listing every
    // variant is easily thousands of characters.
    const text = await failWith(badRequest("x".repeat(5000)));
    expect(text.length).toBeLessThan(600);
    expect(text).toContain("…");
  });

  it("collapses newlines so the card keeps its shape", async () => {
    const text = await failWith(badRequest("first line\n\n  second line"));
    expect(text).toContain("first line second line");
    expect(text).not.toContain("\n");
  });

  it("falls back to the SDK message when the body is not the usual shape", async () => {
    // A gateway between us and the API can return an HTML error page, in
    // which case there is no `error.message` to read.
    const headers = new Headers();
    const error = Anthropic.APIError.generate(502, undefined, "Bad gateway", headers);
    const text = await failWith(error);
    expect(text).toContain("502");
    expect(text).toContain("Bad gateway");
  });

  it("keeps the specific messages for a bad key and a rate limit", async () => {
    // These two are actionable on their own and name the remedy, so they stay
    // as curated text rather than whatever the body happens to say.
    const auth = await failWith(
      Anthropic.APIError.generate(
        401,
        { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
        undefined,
        new Headers(),
      ),
    );
    expect(auth).toContain("ANTHROPIC_API_KEY");

    const limited = await failWith(
      Anthropic.APIError.generate(
        429,
        { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        undefined,
        new Headers(),
      ),
    );
    expect(limited).toContain("rate limiting");
  });

  it("reports a non-API error by its message", async () => {
    expect(await failWith(new TypeError("fetch failed"))).toContain("fetch failed");
  });
});

describe("supportsServerSideFallback", () => {
  it("excludes Haiku, which has no server-side fallback", () => {
    // Sending the parameter where it is unsupported fails the whole request,
    // and the draft a moderator was waiting on with it.
    expect(supportsServerSideFallback("claude-haiku-5-5")).toBe(false);
    expect(supportsServerSideFallback("claude-opus-5-5")).toBe(true);
    expect(supportsServerSideFallback("claude-sonnet-5-5")).toBe(true);
  });
});

describe("an exhausted Anthropic balance", () => {
  it("is named as a billing problem, not reported as a malformed request", async () => {
    // Anthropic returns this as a 400 invalid_request_error rather than a 402,
    // so by status and type it is indistinguishable from a bad parameter. It
    // is the one 400 that is not a bug in this repo: a moderator reading the
    // card should see the remedy, not be sent to debug a request that is fine.
    const spy = vi.spyOn(Anthropic.Beta.Messages.prototype, "create").mockRejectedValue(
      Anthropic.APIError.generate(
        400,
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "Your credit balance is too low to access the Anthropic API. " +
              "Please go to Plans & Billing to upgrade or purchase credits.",
          },
        },
        undefined,
        new Headers(),
      ),
    );
    try {
      const result = await draftResponse(
        { apiKey: "sk-ant-test", model: "claude-haiku-5-5", effort: "low" },
        request,
      );
      expect(result.ok).toBe(false);
      const text = result.ok ? "" : result.error;
      expect(text).toContain("out of credits");
      expect(text).toContain("workers-ai");
      // The raw 400 would send someone looking for a bad parameter.
      expect(text).not.toContain("invalid_request_error");
    } finally {
      spy.mockRestore();
    }
  });
});
