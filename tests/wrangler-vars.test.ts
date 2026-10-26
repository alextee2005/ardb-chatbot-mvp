import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * wrangler.jsonc is the Worker's configuration and nothing else in this repo
 * validates it. It is not TypeScript, so `tsc` never sees it; it holds no
 * logic, so no unit test exercised it; and `wrangler deploy` accepts a file
 * with a setting missing, because a missing var is indistinguishable from one
 * that was never wanted.
 *
 * That combination cost a working bot. An edit to a *comment* in this file
 * deleted three live settings along with it, including GITHUB_REPOSITORY --
 * and because src/config.ts treats a half-configured provider as "degrade to
 * moderator-only rather than fail the webhook", the Worker came up healthy
 * and quietly stopped drafting anything. Tests passed, the deploy passed, and
 * /health reported the provider it had been asked for.
 *
 * So this test reads the var names out of src/config.ts and asserts the file
 * declares each one. It is deliberately derived from the source rather than a
 * hand-written list, because a hand-written list is one more thing to forget.
 */

const wrangler = readFileSync("wrangler.jsonc", "utf8");
const config = readFileSync("src/config.ts", "utf8");

/** Every `env.FOO` the config reads. */
function varsReadByConfig(): string[] {
  return [...new Set([...config.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]!))];
}

/** Every key declared in the `vars` block of wrangler.jsonc. */
function varsDeclared(): string[] {
  const body = /"vars"\s*:\s*\{([\s\S]*?)\n  \}/.exec(wrangler)?.[1];
  expect(body, "wrangler.jsonc should have a vars block").toBeDefined();
  return [...body!.matchAll(/"([A-Z][A-Z0-9_]*)"\s*:/g)].map((m) => m[1] ?? "");
}

/**
 * Secrets, set with `wrangler secret put` and never in this file, plus the
 * one binding. Listing them here is the point: anything NOT on this list and
 * not declared is a var the code reads and the file forgot.
 */
/**
 * Vars the code reads but that need no declaration, because `src/config.ts`
 * supplies a working default. This list is short on purpose and each entry
 * needs a reason: an entry added carelessly reopens exactly the hole that
 * lost GITHUB_REPOSITORY, which has no default and silently disables the
 * github route when absent.
 *
 * GITHUB_DISPATCH_EVENT defaults to "draft-ticket", which is asserted below
 * to match the event the workflow actually listens for.
 */
const OPTIONAL_WITH_DEFAULT = new Set(["GITHUB_DISPATCH_EVENT"]);

const SECRETS_AND_BINDINGS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "MODERATOR_CHAT_ID",
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "GITHUB_DISPATCH_TOKEN",
  "AI",
]);

describe("wrangler.jsonc vars", () => {
  it("declares every non-secret var the Worker reads", () => {
    const declared = new Set(varsDeclared());
    const missing = varsReadByConfig().filter(
      (name) =>
        !declared.has(name) &&
        !SECRETS_AND_BINDINGS.has(name) &&
        !OPTIONAL_WITH_DEFAULT.has(name),
    );
    expect(missing, "vars read by src/config.ts but absent from wrangler.jsonc").toEqual([]);
  });

  it("declares the settings the github drafting route cannot work without", () => {
    // GITHUB_REPOSITORY is the one that was lost. Without it the Worker has
    // nowhere to send the dispatch, so config.ts resolves the provider to
    // "none" and the bot stops drafting without any error anywhere.
    const declared = new Set(varsDeclared());
    for (const name of ["DRAFT_PROVIDER", "GITHUB_REPOSITORY"]) {
      expect(declared.has(name), `wrangler.jsonc must declare ${name}`).toBe(true);
    }
  });

  it("names a repository that looks like one, not a placeholder", () => {
    // A wrong repository would send a ticket id to a stranger's workflow, so
    // the shape is worth asserting even though the value is not secret.
    const repo = /"GITHUB_REPOSITORY"\s*:\s*"([^"]*)"/.exec(wrangler)?.[1];
    expect(repo, "GITHUB_REPOSITORY should have a value").toBeTruthy();
    expect(repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  it("defaults the dispatch event to the one the workflow listens for", () => {
    // The var is allowed to be absent only because config.ts defaults it. If
    // that default and the workflow's trigger ever drift apart, the Worker
    // fires an event nothing is listening to -- and the symptom is the same
    // silence that started all this: a card that never refreshes.
    const fallback = /GITHUB_DISPATCH_EVENT[^\n]*(?:\?\?|\|\|)\s*"([^"]+)"/.exec(config)?.[1];
    expect(fallback, "config.ts should default GITHUB_DISPATCH_EVENT").toBeTruthy();

    const workflow = readFileSync(".github/workflows/draft-ticket.yml", "utf8");
    const listensFor = /repository_dispatch:\s*\n\s*types:\s*\[([^\]]+)\]/.exec(workflow)?.[1];
    expect(listensFor, "draft-ticket.yml should declare repository_dispatch types").toBeTruthy();
    expect(listensFor!.split(",").map((t) => t.trim())).toContain(fallback);
  });

  it("still parses as JSON once comments are stripped", () => {
    // The file is JSONC. A botched comment edit can leave a dangling comma or
    // an unterminated block, and `wrangler deploy` is the next thing that
    // would find out.
    const stripped = wrangler
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    expect(() => JSON.parse(stripped)).not.toThrow();
  });
});
