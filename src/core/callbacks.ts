/**
 * Inline-keyboard callback payloads.
 *
 * Telegram caps callback_data at 64 bytes, so these stay terse: an action verb
 * and a ticket ID. Everything else is looked up from the database.
 */

export const CALLBACK_ACTIONS = ["send", "edit", "reject"] as const;
export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

export interface ParsedCallback {
  action: CallbackAction;
  ticketId: number;
}

export function encodeCallback(action: CallbackAction, ticketId: number): string {
  return `${action}:${ticketId}`;
}

/** Returns null for anything we did not generate, rather than throwing. */
export function parseCallback(data: string | undefined): ParsedCallback | null {
  if (!data) return null;
  const [action, rawId] = data.split(":");
  if (!action || !rawId) return null;
  if (!(CALLBACK_ACTIONS as readonly string[]).includes(action)) return null;

  // Must be digits and nothing else. parseInt is too lenient here: it reads
  // "1.5" and "1abc" as 1, which would silently act on a different ticket
  // than the button named.
  if (!/^[0-9]+$/.test(rawId)) return null;

  const ticketId = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) return null;

  return { action: action as CallbackAction, ticketId };
}

// ---------------------------------------------------------------------
// Customer-side callbacks
// ---------------------------------------------------------------------
//
// A separate namespace and a separate parser from the moderator actions
// above, rather than one union, because the two are authorized completely
// differently: a moderator action is trusted because the tap came from the
// moderator group, and a customer action is trusted because the tap came from
// the private chat that owns the conversation. Keeping the parsers apart means
// a customer payload can never be read as a moderator one even if the routing
// is later changed by someone who has not read this comment.
//
// Scoped to a conversation, not a ticket: "anything else?" and a satisfaction
// score are about the interaction, not one question in it.

export const CUSTOMER_CALLBACK_ACTIONS = ["more", "done", "rate"] as const;
export type CustomerCallbackAction = (typeof CUSTOMER_CALLBACK_ACTIONS)[number];

export type ParsedCustomerCallback =
  /** "Yes, I have another question." */
  | { action: "more"; conversationId: number }
  /** "No, nothing else" -- ends the interaction. */
  | { action: "done"; conversationId: number }
  /** A satisfaction score, 1 to 5. */
  | { action: "rate"; conversationId: number; score: number };

export function encodeCustomerCallback(
  action: "more" | "done",
  conversationId: number,
): string;
export function encodeCustomerCallback(
  action: "rate",
  conversationId: number,
  score: number,
): string;
export function encodeCustomerCallback(
  action: CustomerCallbackAction,
  conversationId: number,
  score?: number,
): string {
  // Telegram caps callback_data at 64 bytes. "rate:9007199254740991:5" is 23,
  // so there is room to spare even for an implausible conversation id.
  return action === "rate"
    ? `rate:${conversationId}:${score}`
    : `${action}:${conversationId}`;
}

/** Returns null for anything we did not generate, rather than throwing. */
export function parseCustomerCallback(data: string | undefined): ParsedCustomerCallback | null {
  if (!data) return null;
  const parts = data.split(":");
  const [action, rawId, rawScore] = parts;
  if (!action || !rawId || !isCustomerAction(action)) return null;

  const conversationId = parsePositiveInt(rawId);
  if (conversationId === null) return null;

  if (action === "rate") {
    // A score is required, and only for rate. Checking the part count rather
    // than ignoring extras: "done:5:9" is not something we generated, and
    // acting on it as "done:5" would be acting on a payload we do not
    // recognize.
    if (parts.length !== 3) return null;
    const score = parsePositiveInt(rawScore);
    if (score === null || score > 5) return null;
    return { action: "rate", conversationId, score };
  }

  if (parts.length !== 2) return null;
  return { action, conversationId };
}

/** A predicate rather than `includes`, which does not narrow the type. */
function isCustomerAction(value: string): value is CustomerCallbackAction {
  return (CUSTOMER_CALLBACK_ACTIONS as readonly string[]).includes(value);
}

/**
 * Digits only.
 *
 * parseInt is too lenient here: it reads "1.5" and "1abc" as 1, which would
 * silently act on a different conversation than the button named.
 */
function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
