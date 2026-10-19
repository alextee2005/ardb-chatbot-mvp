/**
 * Claude Code CLI adapter: a draft with no API key.
 *
 * The other Claude adapter calls the Messages API and is billed per token
 * against an Anthropic API account. This one interprets the output of
 * `claude -p --output-format json`, which authenticates with
 * CLAUDE_CODE_OAUTH_TOKEN -- a token minted by `claude setup-token` from a
 * Claude subscription -- and draws on that subscription instead.
 *
 * Only the parsing lives here. Running the CLI is a workflow step, not a
 * function call: the prompt and the question travel as files on the runner so
 * that neither reaches a process listing or an Actions log, and a step cannot
 * be invoked from the Worker by accident. What this module does is turn the
 * one JSON object the CLI prints into the same `DraftResult` every other
 * provider returns, so the moderator card does not know which produced it.
 */

import type { DraftResult } from "./claude.js";

/**
 * The fields of the CLI's `--output-format json` object that we rely on.
 *
 * Deliberately a subset: the real object carries several dozen keys of
 * timing and process telemetry that are not ours to depend on. Everything is
 * optional because this is parsed from a separate program's stdout, and a
 * version that renames a field should produce a readable failure rather than
 * a crash.
 */
export interface ClaudeCliResult {
  result?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  stop_reason?: unknown;
  api_error_status?: unknown;
  permission_denials?: unknown;
}

/** Keep a card-sized excerpt of whatever the CLI said went wrong. */
const MAX_DETAIL_CHARS = 300;

function excerpt(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > MAX_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_DETAIL_CHARS - 1)}…`
    : trimmed;
}

/**
 * Turn the CLI's JSON into a draft or a reason there isn't one.
 *
 * `raw` is the whole stdout, because a non-zero exit or a crash can leave
 * something that is not JSON at all, and "the CLI printed this instead" is
 * more useful to whoever is on call than a parse error.
 */
export function parseCliResult(raw: string): DraftResult {
  const text = raw.trim();
  if (!text) {
    return {
      ok: false,
      error:
        "The Claude CLI produced no output. Check the workflow log: an " +
        "expired CLAUDE_CODE_OAUTH_TOKEN is the usual cause.",
    };
  }

  let parsed: ClaudeCliResult;
  try {
    // The CLI prints one JSON object on the last line in --print mode, but a
    // warning on an earlier line would break a whole-string parse, so the
    // last non-empty line is tried as well.
    parsed = JSON.parse(text) as ClaudeCliResult;
  } catch {
    const lines = text.split("\n").filter((line) => line.trim());
    const last = lines[lines.length - 1] ?? "";
    try {
      parsed = JSON.parse(last) as ClaudeCliResult;
    } catch {
      return {
        ok: false,
        error: `The Claude CLI did not return JSON: ${excerpt(text)}`,
      };
    }
  }

  // `is_error` is the CLI's own verdict and is checked before the text,
  // because an errored run still carries a `result` string -- it holds the
  // error message, which must never be delivered as a draft.
  if (parsed.is_error === true || (parsed.subtype && parsed.subtype !== "success")) {
    const detail =
      typeof parsed.result === "string" && parsed.result.trim()
        ? excerpt(parsed.result)
        : `subtype ${String(parsed.subtype ?? "unknown")}`;
    const status = parsed.api_error_status ? ` (HTTP ${String(parsed.api_error_status)})` : "";
    return { ok: false, error: `The Claude CLI reported an error${status}: ${detail}` };
  }

  if (typeof parsed.result !== "string" || !parsed.result.trim()) {
    return { ok: false, error: "The Claude CLI returned an empty draft." };
  }

  // A turn that ran out of turns or tokens can still print partial text. A
  // half-written reply must not reach a moderator looking like a whole one.
  if (parsed.stop_reason === "max_tokens") {
    return {
      ok: false,
      error: "The draft was cut off before it finished. Write the answer manually.",
    };
  }

  return { ok: true, text: parsed.result.trim(), cacheRead: 0, cacheWrite: 0 };
}
