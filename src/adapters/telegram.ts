/**
 * Telegram Bot API client, narrowed to the handful of methods this bot uses.
 *
 * Errors are returned rather than thrown: every call site here is reacting to
 * a webhook that has already been acknowledged, so a failed send is something
 * to log and work around, not an exception that aborts a request nobody is
 * waiting on.
 */

import type { InlineKeyboard } from "../core/moderator-card.js";

const API_BASE = "https://api.telegram.org";

export interface TelegramResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  from?: { id: number; first_name: string; last_name?: string; username?: string };
  reply_to_message?: { message_id: number };
}

export class TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, body: unknown): Promise<TelegramResult<T>> {
    try {
      const response = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await response.json()) as TelegramResult<T>;
    } catch (error) {
      return {
        ok: false,
        description: error instanceof Error ? error.message : "fetch failed",
      };
    }
  }

  sendMessage(options: {
    chatId: number;
    text: string;
    parseMode?: "HTML";
    replyMarkup?: InlineKeyboard | { force_reply: true; selective: true };
    replyToMessageId?: number;
  }): Promise<TelegramResult<TelegramMessage>> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: options.chatId,
      text: options.text,
      parse_mode: options.parseMode,
      reply_markup: options.replyMarkup,
      reply_parameters: options.replyToMessageId
        ? { message_id: options.replyToMessageId, allow_sending_without_reply: true }
        : undefined,
      link_preview_options: { is_disabled: true },
    });
  }

  editMessageText(options: {
    chatId: number;
    messageId: number;
    text: string;
    parseMode?: "HTML";
    replyMarkup?: InlineKeyboard;
  }): Promise<TelegramResult<TelegramMessage>> {
    return this.call<TelegramMessage>("editMessageText", {
      chat_id: options.chatId,
      message_id: options.messageId,
      text: options.text,
      parse_mode: options.parseMode,
      // Omitting reply_markup leaves the old buttons in place, so a resolved
      // ticket would keep live buttons. Send an empty keyboard to clear them.
      reply_markup: options.replyMarkup ?? { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    });
  }

  /**
   * Telegram shows the spinner on a tapped button until this is called, and
   * retries the callback if it never is. Always answer, even on failure.
   */
  answerCallbackQuery(options: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
  }): Promise<TelegramResult<boolean>> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: options.callbackQueryId,
      text: options.text,
      show_alert: options.showAlert ?? false,
    });
  }

  sendChatAction(chatId: number): Promise<TelegramResult<boolean>> {
    return this.call<boolean>("sendChatAction", { chat_id: chatId, action: "typing" });
  }
}

/** Display name for a Telegram user, falling back through what is populated. */
export function displayName(
  from: { first_name?: string; last_name?: string; username?: string } | undefined,
): string {
  if (!from) return "Unknown";
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return full || from.username || "Unknown";
}
