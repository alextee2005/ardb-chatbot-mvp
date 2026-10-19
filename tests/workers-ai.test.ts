import { describe, expect, it } from "vitest";

import { draftWithWorkersAi } from "../src/adapters/workers-ai.js";
import type { KnowledgeBase } from "../src/core/knowledge.js";

const knowledge: KnowledgeBase = {
  version: "2026-10-08-1-en",
  generatedAt: "2026-10-08T00:00:00.000Z",
  source: "https://www.ardb.com.kh",
  entries: [
    {
      id: "saving-deposit",
      title: "Savings deposit",
      url: "https://www.ardb.com.kh/product-service/deposits/saving-deposit",
      language: "en",
      category: "deposit-products",
      content: "The interest rate is 1.50% a year.",
    },
  ],
};

const request = {
  question: "តើការប្រាក់សន្សំប៉ុន្មាន?",
  questionLanguage: "km" as const,
  knowledge,
};

/** A binding that records what it was called with and returns `result`. */
function fakeBinding(result: unknown) {
  const calls: { model: unknown; inputs: Record<string, unknown> }[] = [];
  const firstCall = () => {
    const call = calls[0];
    if (!call) throw new Error("the binding was never called");
    return call;
  };
  const binding = {
    run: async (model: unknown, inputs: Record<string, unknown>) => {
      calls.push({ model, inputs });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { binding: binding as unknown as Ai, calls, firstCall };
}

describe("draftWithWorkersAi", () => {
  it("returns the draft text", async () => {
    const { binding } = fakeBinding({ response: "  អត្រាការប្រាក់គឺ ១,៥០% ក្នុងមួយឆ្នាំ។  " });
    const result = await draftWithWorkersAi({ binding, model: "@cf/openai/gpt-oss-20b" }, request);

    expect(result).toEqual({
      ok: true,
      text: "អត្រាការប្រាក់គឺ ១,៥០% ក្នុងមួយឆ្នាំ។",
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("sends the corpus as a system message and the question as the user turn", async () => {
    const { binding, firstCall } = fakeBinding({ response: "ok" });
    await draftWithWorkersAi({ binding, model: "@cf/openai/gpt-oss-20b" }, request);

    const messages = firstCall().inputs.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    // The grounding material has to actually be in the prompt; a provider
    // swap that quietly dropped it would still produce fluent drafts.
    expect(messages[0]?.content).toContain("The interest rate is 1.50% a year.");
    expect(messages[1]?.content).toContain(request.question);
  });

  it("sets max_tokens, because the Workers AI default of 256 truncates a draft", async () => {
    const { binding, firstCall } = fakeBinding({ response: "ok" });
    await draftWithWorkersAi({ binding, model: "@cf/openai/gpt-oss-20b" }, request);

    expect(firstCall().inputs.max_tokens).toBe(4000);
    expect(firstCall().model).toBe("@cf/openai/gpt-oss-20b");
  });

  describe("output shapes", () => {
    // WORKERS_AI_MODEL is configuration, and model families answer in
    // different shapes. Reading only `response` is what made gpt-oss report
    // an empty draft on every question while answering perfectly well.
    it("reads the chat-completions shape that gpt-oss returns", async () => {
      const { binding } = fakeBinding({
        choices: [{ message: { content: "  ១,៥០% ក្នុងមួយឆ្នាំ។  " }, finish_reason: "stop" }],
      });
      const result = await draftWithWorkersAi({ binding, model: "@cf/openai/gpt-oss-20b" }, request);
      expect(result).toMatchObject({ ok: true, text: "១,៥០% ក្នុងមួយឆ្នាំ។" });
    });

    it("reads the responses shape's output_text", async () => {
      const { binding } = fakeBinding({ output_text: "1.50% a year." });
      const result = await draftWithWorkersAi({ binding, model: "@cf/openai/gpt-oss-20b" }, request);
      expect(result).toMatchObject({ ok: true, text: "1.50% a year." });
    });

    it("takes text items from a responses output array and skips reasoning", async () => {
      const { binding } = fakeBinding({
        output: [
          { content: [{ type: "reasoning", text: "the user asks about savings" }] },
          { content: [{ type: "output_text", text: "1.50% a year." }] },
        ],
      });
      const result = await draftWithWorkersAi({ binding, model: "@cf/openai/gpt-oss-20b" }, request);
      expect(result).toMatchObject({ ok: true, text: "1.50% a year." });
    });

    it("prefers the plain text-generation field when a model sets it", async () => {
      const { binding } = fakeBinding({ response: "from response", output_text: "from output" });
      const result = await draftWithWorkersAi({ binding, model: "@cf/meta/llama-3.1-8b" }, request);
      expect(result).toMatchObject({ ok: true, text: "from response" });
    });
  });

  describe("reasoning models", () => {
    it("turns reasoning effort down on models that cannot disable it", async () => {
      // gpt-oss reasons on every request at "medium" by default, drawn from
      // the same output budget as the answer.
      const { binding, firstCall } = fakeBinding({ response: "ok" });
      await draftWithWorkersAi({ binding, model: "@cf/openai/gpt-oss-20b" }, request);
      expect(firstCall().inputs.reasoning_effort).toBe("low");
    });

    it("sends no reasoning_effort to a model that has no such parameter", async () => {
      const { binding, firstCall } = fakeBinding({ response: "ok" });
      await draftWithWorkersAi(
        { binding, model: "@cf/meta/llama-3.1-8b-instruct-fp8-fast" },
        request,
      );
      expect(firstCall().inputs.reasoning_effort).toBeUndefined();
    });

    it("says so when the budget went on reasoning rather than an answer", async () => {
      // A different fix from an unread output shape: this one wants a bigger
      // budget or a smaller model, and saying "empty draft" would send
      // someone looking in the wrong place.
      const { binding } = fakeBinding({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
      });
      const result = await draftWithWorkersAi({ binding, model: "@cf/openai/gpt-oss-20b" }, request);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("output budget");
    });
  });

  it("treats an empty response as a failure rather than an empty answer", async () => {
    const { binding } = fakeBinding({ response: "   " });
    const result = await draftWithWorkersAi({ binding, model: "m" }, request);
    expect(result.ok).toBe(false);
  });

  it("names the keys it did get when no shape yields text", async () => {
    // The diagnostic that would have found the gpt-oss bug in one reading
    // rather than in a debugging session.
    const { binding } = fakeBinding({ id: "x", object: "chat.completion" });
    const result = await draftWithWorkersAi({ binding, model: "m" }, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("id, object");
  });

  it("explains the daily neuron limit and when it resets", async () => {
    // Not a fault: it is the free plan working as sold. The moderator needs to
    // know to write the answer, and that it will be drafting again tomorrow.
    for (const message of [
      "Error: you have exceeded your daily neuron quota",
      "429 Too Many Requests",
      "AiError: limit exceeded for account",
    ]) {
      const { binding } = fakeBinding(new Error(message));
      const result = await draftWithWorkersAi({ binding, model: "m" }, request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Tap Edit");
        expect(result.error).toContain("00:00 UTC");
      }
    }
  });

  it("names the context window when the corpus does not fit", async () => {
    // The whole corpus goes with every question, so a model whose window is
    // smaller than the corpus fails every request identically -- worth saying
    // once, clearly, rather than leaving someone to hunt.
    const { binding } = fakeBinding(
      new Error("input is too long: 24000 tokens exceeds maximum context of 8192"),
    );
    const result = await draftWithWorkersAi({ binding, model: "m" }, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("WORKERS_AI_MODEL");
  });

  it("passes an unrecognised failure through rather than swallowing it", async () => {
    const { binding } = fakeBinding(new Error("upstream connect error"));
    const result = await draftWithWorkersAi({ binding, model: "m" }, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("upstream connect error");
  });
});
