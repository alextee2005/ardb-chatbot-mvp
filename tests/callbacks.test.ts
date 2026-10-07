import { describe, expect, it } from "vitest";

import { encodeCallback, parseCallback } from "../src/core/callbacks.js";

describe("callback encoding", () => {
  it("round-trips every action", () => {
    for (const action of ["send", "edit", "reject"] as const) {
      expect(parseCallback(encodeCallback(action, 42))).toEqual({ action, ticketId: 42 });
    }
  });

  it("stays inside Telegram's 64-byte callback_data limit", () => {
    // Even an implausibly large ticket ID must fit.
    expect(encodeCallback("reject", Number.MAX_SAFE_INTEGER).length).toBeLessThan(64);
  });

  it("rejects anything it did not generate", () => {
    for (const data of [
      undefined,
      "",
      "send",
      "send:",
      ":42",
      "delete:42",
      "send:abc",
      "send:0",
      "send:-1",
      "send:1.5",
    ]) {
      expect(parseCallback(data)).toBeNull();
    }
  });
});
