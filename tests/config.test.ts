import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, type Env } from "../src/config.js";

/** The four secrets without which nothing can work. */
const required: Env = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_WEBHOOK_SECRET: "a-long-random-string",
  MODERATOR_CHAT_ID: "-1001234567890",
  DATABASE_URL: "postgresql://user:pass@host/db?sslmode=require",
};

describe("loadConfig", () => {
  it("accepts the four required secrets with no Claude key", () => {
    const config = loadConfig(required);
    expect(config.moderatorChatId).toBe(-1001234567890);
    expect(config.anthropicApiKey).toBeNull();
  });

  describe("draft provider", () => {
    const ai = {} as Ai;

    it("defaults to Workers AI when the binding is present", () => {
      expect(loadConfig({ ...required, AI: ai }).draftProvider).toBe("workers-ai");
      expect(loadConfig({ ...required, AI: ai }).workersAiModel).toBe("@cf/openai/gpt-oss-20b");
    });

    it("degrades to none when the chosen provider cannot run", () => {
      // The queue is the product. A provider that cannot run must not take
      // the bot down with it -- a question still reaches a moderator, who
      // writes the answer. Both directions of the mistake are covered:
      expect(loadConfig({ ...required, DRAFT_PROVIDER: "workers-ai" }).draftProvider).toBe("none");
      expect(loadConfig({ ...required, DRAFT_PROVIDER: "claude" }).draftProvider).toBe("none");
    });

    it("uses the provider when it can run", () => {
      expect(
        loadConfig({ ...required, DRAFT_PROVIDER: "claude", ANTHROPIC_API_KEY: "sk-ant-x" })
          .draftProvider,
      ).toBe("claude");
      expect(
        loadConfig({ ...required, DRAFT_PROVIDER: "workers-ai", AI: ai }).draftProvider,
      ).toBe("workers-ai");
    });

    it("honours an explicit none even with a provider available", () => {
      expect(
        loadConfig({ ...required, DRAFT_PROVIDER: "none", AI: ai, ANTHROPIC_API_KEY: "sk-ant-x" })
          .draftProvider,
      ).toBe("none");
    });

    it("needs both a token and a repository for the github route", () => {
      // Half-configured is the dangerous shape: a token with no repository
      // has nowhere to aim, and a repository with no token cannot
      // authenticate. Either way the card would never fill in, so both
      // resolve to moderator-only instead.
      const token = { GITHUB_DISPATCH_TOKEN: "ghp_x" };
      const repo = { GITHUB_REPOSITORY: "owner/repo" };
      expect(loadConfig({ ...required, DRAFT_PROVIDER: "github" }).draftProvider).toBe("none");
      expect(
        loadConfig({ ...required, DRAFT_PROVIDER: "github", ...token }).draftProvider,
      ).toBe("none");
      expect(
        loadConfig({ ...required, DRAFT_PROVIDER: "github", ...repo }).draftProvider,
      ).toBe("none");
      expect(
        loadConfig({ ...required, DRAFT_PROVIDER: "github", ...token, ...repo }).draftProvider,
      ).toBe("github");
    });

    it("defaults the dispatch event type and trims the repository", () => {
      const config = loadConfig({
        ...required,
        DRAFT_PROVIDER: "github",
        GITHUB_DISPATCH_TOKEN: "ghp_x",
        GITHUB_REPOSITORY: "  owner/repo  ",
      });
      expect(config.githubDispatch).toEqual({
        token: "ghp_x",
        repository: "owner/repo",
        eventType: "draft-ticket",
      });
    });

    it("rejects an unknown provider name", () => {
      // A typo is a mistake, not a missing optional dependency, and silently
      // falling back would hide it for as long as nobody reads /health.
      expect(() => loadConfig({ ...required, DRAFT_PROVIDER: "cloudflare" })).toThrow(ConfigError);
    });

    it("carries the binding through on config, not the raw env", () => {
      expect(loadConfig({ ...required, AI: ai }).ai).toBe(ai);
      expect(loadConfig(required).ai).toBeNull();
    });
  });

  it("names every missing secret at once", () => {
    // One pass, not one error per deploy: someone setting up five secrets
    // should not have to redeploy four times to discover the list.
    expect(() => loadConfig({} as Env)).toThrow(ConfigError);
    try {
      loadConfig({} as Env);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("TELEGRAM_BOT_TOKEN");
      expect(message).toContain("TELEGRAM_WEBHOOK_SECRET");
      expect(message).toContain("MODERATOR_CHAT_ID");
      expect(message).toContain("DATABASE_URL");
    }
  });

  it("does not require ANTHROPIC_API_KEY", () => {
    // The supervised queue is the product; drafting is an accelerator on top
    // of it. A bot with no Claude key must still take questions and still put
    // them in front of a moderator, who writes the answer by hand.
    expect(() => loadConfig(required)).not.toThrow();
  });

  it("treats a blank Claude key as absent", () => {
    // A secret set to an empty string is the shape a half-finished `secret
    // put` leaves behind, and an empty key would otherwise reach the API and
    // fail once per question.
    for (const blank of ["", "   "]) {
      expect(loadConfig({ ...required, ANTHROPIC_API_KEY: blank }).anthropicApiKey).toBeNull();
    }
  });

  it("carries the Claude key through when it is set", () => {
    const config = loadConfig({ ...required, ANTHROPIC_API_KEY: "sk-ant-xyz" });
    expect(config.anthropicApiKey).toBe("sk-ant-xyz");
  });

  it("accepts a negative moderator chat id", () => {
    // Groups are negative. A positive-only parse would reject every real
    // moderator group and accept only a private chat, which is the one place
    // a card must never go.
    expect(loadConfig(required).moderatorChatId).toBeLessThan(0);
  });

  it("rejects a moderator chat id that is not an integer", () => {
    expect(() => loadConfig({ ...required, MODERATOR_CHAT_ID: "@ardb_moderators" })).toThrow(
      ConfigError,
    );
  });

  it("defaults the model and effort, and rejects an unknown effort", () => {
    const config = loadConfig(required);
    expect(config.claudeModel).toBe("claude-sonnet-5-5");
    expect(config.claudeEffort).toBe("low");
    expect(() => loadConfig({ ...required, CLAUDE_EFFORT: "maximum" })).toThrow(ConfigError);
  });

  it("falls back to the default SLA policy for a blank or invalid var", () => {
    const config = loadConfig({ ...required, SLA_NUDGE_AFTER_MINUTES: "soon" });
    expect(config.sla.nudgeAfterMinutes).toBe(10);
  });
});
