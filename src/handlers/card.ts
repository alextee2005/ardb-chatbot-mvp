/**
 * Rewriting a moderator card in place.
 *
 * Three places now need this -- the moderator handler after a claim or a
 * resolution, the drafting step when a draft lands, and the SLA sweep when a
 * draft is given up on -- and they must produce the same card. A second
 * implementation drifts: the conversation banner was already lost once by a
 * refresh that did not re-read the thread.
 */

import type { Store } from "../adapters/store.js";
import type { TelegramClient } from "../adapters/telegram.js";
import { MAX_HISTORY_TURNS } from "../core/conversations.js";
import { renderCard, renderKeyboard } from "../core/moderator-card.js";
import type { Ticket } from "../core/tickets.js";

export interface CardContextDeps {
  telegram: TelegramClient;
  store: Store;
  moderatorChatId: number;
}

/**
 * Rewrite the card for `ticket` so the group shows its current state.
 *
 * The conversation thread is re-read rather than passed in, because omitting
 * it makes the banner vanish -- taking the context away at exactly the point
 * a moderator is deciding what to do.
 *
 * A ticket whose card never posted has nothing to refresh and is skipped.
 */
export async function refreshCard(ctx: CardContextDeps, ticket: Ticket): Promise<void> {
  if (ticket.cardMessageId === null) return;

  const turns =
    ticket.conversationId !== null
      ? await ctx.store.getConversationHistory(
          ticket.conversationId,
          ticket.id,
          MAX_HISTORY_TURNS,
        )
      : [];

  await ctx.telegram.editMessageText({
    chatId: ctx.moderatorChatId,
    messageId: ticket.cardMessageId,
    text: renderCard(ticket, { turns }),
    parseMode: "HTML",
    replyMarkup: renderKeyboard(ticket),
  });
}
