#!/usr/bin/env python3
"""Verify the Telegram bot and its deployment.

Checks the token is live, reports the bot's identity and its privacy setting,
reports webhook state, and lists the chats it can see so the moderator group
ID can be found.

The token comes from the ``TELEGRAM_BOT_TOKEN`` environment variable only --
never an argument, which would put it in shell history and process listings.

    TELEGRAM_BOT_TOKEN=... python tools/verify_bot.py
    TELEGRAM_BOT_TOKEN=... python tools/verify_bot.py --expect-webhook https://…

Exit codes: 0 all checks passed, 1 a check failed, 2 misconfigured.
"""

from __future__ import annotations

import argparse
import os
import sys

from ardb.telegram import TelegramClient, TelegramError


def _redact(token: str) -> str:
    """Show only the bot ID, which is public and appears in the username."""
    bot_id = token.split(":", 1)[0]
    return f"{bot_id}:<redacted>"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--expect-webhook",
        metavar="URL",
        help="Fail unless the webhook is registered at this exact URL.",
    )
    parser.add_argument(
        "--require-group-privacy-disabled",
        action="store_true",
        help=(
            "Fail unless the bot can read all group messages. Without this "
            "setting the bot cannot see moderator replies in the group, so "
            "the Edit flow silently does nothing."
        ),
    )
    args = parser.parse_args()

    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        print("TELEGRAM_BOT_TOKEN is not set.", file=sys.stderr)
        return 2

    try:
        client = TelegramClient(token)
    except ValueError as error:
        print(f"{error}", file=sys.stderr)
        return 2

    print(f"Token:   {_redact(token)}")

    failures: list[str] = []

    # --- identity ---------------------------------------------------------
    try:
        identity = client.get_me()
    except TelegramError as error:
        print(f"\nFAIL  getMe: {error}", file=sys.stderr)
        return 1

    print(f"Bot:     {identity.handle} ({identity.first_name}), id {identity.id}")
    print(f"Groups:  can join = {identity.can_join_groups}")
    print(f"Privacy: can read all group messages = {identity.can_read_all_group_messages}")

    if not identity.can_read_all_group_messages:
        message = (
            "group privacy is ENABLED, so the bot cannot read moderator "
            "replies in the group -- the Edit flow will appear to do nothing. "
            "Fix with /setprivacy -> Disable in BotFather, then remove and "
            "re-add the bot to the group."
        )
        if args.require_group_privacy_disabled:
            failures.append(message)
        else:
            print(f"\nWARNING: {message}")

    # --- webhook ----------------------------------------------------------
    try:
        webhook = client.get_webhook_status()
    except TelegramError as error:
        failures.append(f"getWebhookInfo: {error}")
        webhook = None

    if webhook is not None:
        print()
        if webhook.is_set:
            print(f"Webhook: {webhook.url}")
            print(f"Pending: {webhook.pending_update_count} update(s)")
            if webhook.allowed_updates:
                print(f"Updates: {', '.join(webhook.allowed_updates)}")
            if webhook.last_error_message:
                # Telegram keeps the last delivery failure, which is the
                # fastest way to spot a wrong secret or a crashing Worker.
                failures.append(
                    f"last webhook delivery failed: {webhook.last_error_message}"
                )
        else:
            print("Webhook: not registered")
            if args.expect_webhook:
                failures.append("expected a webhook to be registered, found none")

        if args.expect_webhook and webhook.url and webhook.url != args.expect_webhook:
            failures.append(
                f"webhook is {webhook.url}, expected {args.expect_webhook}"
            )

    # --- visible chats ----------------------------------------------------
    if webhook is not None and not webhook.is_set:
        try:
            chats = client.get_seen_chats()
        except TelegramError as error:
            print(f"\nCould not list chats: {error}")
            chats = []

        print()
        if chats:
            print("Chats the bot has seen (negative IDs are groups):")
            for chat in chats:
                print(f"  {chat.id:>16}  {chat.type:<10}  {chat.title}")
            print("\nUse the private group's negative ID as MODERATOR_CHAT_ID.")
        else:
            print(
                "No chats seen yet. Add the bot to your private moderator "
                "group, send a message there, and re-run."
            )
    elif webhook is not None:
        print(
            "\nSkipping chat discovery: Telegram does not allow getUpdates "
            "while a webhook is registered."
        )

    # --- result -----------------------------------------------------------
    print()
    if failures:
        for failure in failures:
            print(f"FAIL  {failure}", file=sys.stderr)
        return 1

    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
