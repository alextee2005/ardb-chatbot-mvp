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
