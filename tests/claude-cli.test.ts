import { describe, expect, it } from "vitest";

import { parseCliResult } from "../src/adapters/claude-cli.js";

/** A success envelope shaped like the real `--output-format json` output. */
function cli(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    result: "Our savings account pays 4.00% a year.",
    num_turns: 1,
    ...overrides,
  });
}

describe("parseCliResult", () => {
  it("reads the draft out of a successful run", () => {
    const result = parseCliResult(cli());
    expect(result.ok).toBe(true);
    expect(result.ok && result.text).toBe("Our savings account pays 4.00% a year.");
  });

  it("trims surrounding whitespace from the draft", () => {
    const result = parseCliResult(cli({ result: "  Answer.\n\n" }));
    expect(result.ok && result.text).toBe("Answer.");
  });

  it("tolerates a warning line printed before the JSON", () => {
    // npx and the CLI both write notices to stdout on occasion, and a
    // whole-string parse would fail on an otherwise perfectly good run.
    const result = parseCliResult(`npm warn exec something\n${cli()}`);
    expect(result.ok).toBe(true);
  });

  describe("failures", () => {
    it("never delivers the error text as a draft", () => {
      // The regression this guards: an errored run still carries a `result`
      // string, and it holds the error message. Reading the text before
      // checking is_error would send "Invalid API key" to a bank's customer
      // as though it were an answer about their loan.
      const result = parseCliResult(
        cli({ is_error: true, subtype: "error_during_execution", result: "Invalid API key" }),
      );
      expect(result.ok).toBe(false);
      expect(result.ok || result.error).toContain("Invalid API key");
      expect(result.ok || result.error).toContain("reported an error");
    });

    it("names the HTTP status when the CLI reports one", () => {
      const result = parseCliResult(cli({ is_error: true, api_error_status: 401, result: "nope" }));
      expect(result.ok || result.error).toContain("401");
    });

    it("treats a non-success subtype as a failure even without is_error", () => {
      const result = parseCliResult(cli({ subtype: "error_max_turns", is_error: false }));
      expect(result.ok).toBe(false);
    });

    it("rejects a truncated draft rather than passing half a reply on", () => {
      const result = parseCliResult(cli({ stop_reason: "max_tokens" }));
      expect(result.ok).toBe(false);
      expect(result.ok || result.error).toContain("cut off");
    });

    it("explains empty output, the shape an expired token leaves", () => {
      for (const empty of ["", "   \n "]) {
        const result = parseCliResult(empty);
        expect(result.ok).toBe(false);
        expect(result.ok || result.error).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      }
    });

    it("quotes non-JSON output instead of throwing", () => {
      // A crash or an auth prompt prints prose. The run must still end with a
      // readable card rather than an unhandled parse error.
      const result = parseCliResult("Error: not logged in. Run `claude setup-token`.");
      expect(result.ok).toBe(false);
      expect(result.ok || result.error).toContain("did not return JSON");
      expect(result.ok || result.error).toContain("setup-token");
    });

    it("reports a missing or non-string result as empty", () => {
      expect(parseCliResult(cli({ result: undefined })).ok).toBe(false);
      expect(parseCliResult(cli({ result: "" })).ok).toBe(false);
      expect(parseCliResult(cli({ result: 42 })).ok).toBe(false);
      const result = parseCliResult(cli({ result: "   " }));
      expect(result.ok || result.error).toContain("empty draft");
    });

    it("clamps a very long error so the card stays sendable", () => {
      const result = parseCliResult(cli({ is_error: true, result: "x".repeat(4000) }));
      expect(result.ok).toBe(false);
      expect(result.ok || result.error.length).toBeLessThan(400);
    });

    it("collapses newlines in a quoted error", () => {
      const result = parseCliResult(cli({ is_error: true, result: "line one\nline two" }));
      expect(result.ok || result.error).toContain("line one line two");
    });
  });
});
