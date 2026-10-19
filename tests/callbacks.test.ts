import { describe, expect, it } from "vitest";

import {
  encodeCallback,
  encodeCustomerCallback,
  parseCallback,
  parseCustomerCallback,
} from "../src/core/callbacks.js";

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

describe("customer callbacks", () => {
  it("round-trips the three actions", () => {
    expect(parseCustomerCallback(encodeCustomerCallback("more", 12))).toEqual({
      action: "more",
      conversationId: 12,
    });
    expect(parseCustomerCallback(encodeCustomerCallback("done", 12))).toEqual({
      action: "done",
      conversationId: 12,
    });
    expect(parseCustomerCallback(encodeCustomerCallback("rate", 12, 4))).toEqual({
      action: "rate",
      conversationId: 12,
      score: 4,
    });
  });

  it("stays inside Telegram's 64-byte callback_data limit", () => {
    // Even for an implausible conversation id, because exceeding it is a
    // send-time error on a button a customer is waiting for.
    const longest = encodeCustomerCallback("rate", Number.MAX_SAFE_INTEGER, 5);
    expect(new TextEncoder().encode(longest).length).toBeLessThanOrEqual(64);
  });

  it("refuses a score outside 1-5", () => {
    expect(parseCustomerCallback("rate:12:0")).toBeNull();
    expect(parseCustomerCallback("rate:12:6")).toBeNull();
    expect(parseCustomerCallback("rate:12:99")).toBeNull();
  });

  it("refuses a rate with no score and a more/done with one", () => {
    // Extra parts are not ignored: "done:5:9" is not something we generated,
    // and reading it as "done:5" would act on a payload we do not recognize.
    expect(parseCustomerCallback("rate:12")).toBeNull();
    expect(parseCustomerCallback("done:12:3")).toBeNull();
    expect(parseCustomerCallback("more:12:3")).toBeNull();
  });

  it("refuses a non-numeric or non-positive conversation id", () => {
    // parseInt would read "1.5" and "1abc" as 1, acting on a different
    // conversation than the button named.
    for (const bad of ["more:1.5", "more:1abc", "more:0", "more:-1", "more:", "more"]) {
      expect(parseCustomerCallback(bad)).toBeNull();
    }
  });

  it("refuses moderator payloads and junk", () => {
    // The two namespaces must not overlap: a moderator action reaching the
    // customer parser would be acted on with the wrong authorization model.
    for (const bad of ["send:12", "edit:12", "reject:12", "", undefined, "rate", ":::"]) {
      expect(parseCustomerCallback(bad)).toBeNull();
    }
  });

  it("is refused by the moderator parser in turn", () => {
    for (const data of ["more:12", "done:12", "rate:12:5"]) {
      expect(parseCallback(data)).toBeNull();
    }
  });
});
