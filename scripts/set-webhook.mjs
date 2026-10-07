#!/usr/bin/env node
/**
 * Point the bot's webhook at the deployed Worker.
 *
 * Needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and WORKER_URL, e.g.
 *   WORKER_URL=https://ardb-chatbot.<subdomain>.workers.dev npm run set-webhook
 *
 * Pass --delete to remove the webhook (useful before running `wrangler dev`,
 * since a bot can only have one webhook at a time).
 */

import { argv, env, exit } from "node:process";

const token = env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set.");
  exit(1);
}

const api = `https://api.telegram.org/bot${token}`;

async function call(method, body) {
  const response = await fetch(`${api}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json();
  if (!payload.ok) {
    console.error(`${method} failed: ${payload.description}`);
    exit(1);
  }
  return payload.result;
}

if (argv.includes("--delete")) {
  await call("deleteWebhook", { drop_pending_updates: false });
  console.log("Webhook deleted.");
  exit(0);
}

const workerUrl = env.WORKER_URL;
const secret = env.TELEGRAM_WEBHOOK_SECRET;

if (!workerUrl || !secret) {
  console.error("WORKER_URL and TELEGRAM_WEBHOOK_SECRET must both be set.");
  exit(1);
}

const me = await call("getMe");
console.log(`Bot: @${me.username} (${me.first_name})`);

await call("setWebhook", {
  url: `${workerUrl.replace(/\/$/, "")}/telegram/webhook`,
  secret_token: secret,
  // Everything else (edits, joins, reactions) is noise this bot ignores.
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});

const info = await call("getWebhookInfo");
console.log(`Webhook set to ${info.url}`);
console.log(`Pending updates: ${info.pending_update_count}`);
if (info.last_error_message) {
  console.warn(`Last error: ${info.last_error_message}`);
}
