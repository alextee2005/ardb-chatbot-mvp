#!/usr/bin/env node
/**
 * Discover the moderator group's chat ID.
 *
 *   1. Create a private Telegram group.
 *   2. Add the bot to it.
 *   3. Send any message in the group.
 *   4. TELEGRAM_BOT_TOKEN=... node scripts/get-chat-id.mjs
 *
 * Only works while no webhook is registered -- getUpdates and a webhook are
 * mutually exclusive. Run `npm run set-webhook -- --delete` first if needed.
 */

import { env, exit } from "node:process";

const token = env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set.");
  exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const payload = await response.json();

if (!payload.ok) {
  console.error(`getUpdates failed: ${payload.description}`);
  if (/webhook is active/i.test(payload.description ?? "")) {
    console.error("Delete the webhook first: npm run set-webhook -- --delete");
  }
  exit(1);
}

const chats = new Map();
for (const update of payload.result) {
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  if (chat) chats.set(chat.id, chat);
}

if (chats.size === 0) {
  console.log("No updates found. Send a message in the group, then re-run.");
  exit(0);
}

console.log("Chats the bot has seen:\n");
for (const chat of chats.values()) {
  const label = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  console.log(`  ${chat.id}\t${chat.type}\t${label ?? ""}`);
}
console.log("\nThe negative ID of your private group is MODERATOR_CHAT_ID.");
