"""Telegram Bot API calls needed to verify a deployment.

Read-only by default. Nothing here changes bot state unless explicitly asked,
because this runs in CI where an accidental `setWebhook` would silently point
production at the wrong URL.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import requests

API_BASE = "https://api.telegram.org"


class TelegramError(RuntimeError):
    """A Bot API call that came back ``ok: false``, or did not come back."""


@dataclass(frozen=True, slots=True)
class BotIdentity:
    id: int
    username: str
    first_name: str
    can_join_groups: bool
    can_read_all_group_messages: bool

    @property
    def handle(self) -> str:
        return f"@{self.username}"


@dataclass(frozen=True, slots=True)
class WebhookStatus:
    url: str
    pending_update_count: int
    last_error_message: str | None
    last_error_date: int | None
    allowed_updates: tuple[str, ...]
    has_custom_certificate: bool

    @property
    def is_set(self) -> bool:
        return bool(self.url)


@dataclass(frozen=True, slots=True)
class SeenChat:
    id: int
    type: str
    title: str


class TelegramClient:
    """Minimal Bot API client.

    The token is held only in memory and never logged. Callers must not
    interpolate it into messages: GitHub Actions masks registered secrets in
    log output, but only on exact matches, so the safe habit is to never emit
    it at all.
    """

    def __init__(self, token: str, *, timeout: int = 20) -> None:
        if not token or ":" not in token:
            raise ValueError(
                "Token does not look like a Telegram bot token "
                "(expected '<id>:<secret>')."
            )
        self._token = token
        self._timeout = timeout

    def _call(self, method: str) -> Any:
        url = f"{API_BASE}/bot{self._token}/{method}"
        try:
            response = requests.get(url, timeout=self._timeout)
        except requests.RequestException as error:
            raise TelegramError(f"{method}: could not reach Telegram ({error})") from error

        try:
            payload = response.json()
        except ValueError as error:
            raise TelegramError(
                f"{method}: Telegram returned non-JSON (HTTP {response.status_code})"
            ) from error

        if not payload.get("ok"):
            description = payload.get("description", "no description")
            # 401 is the one worth naming outright: it is almost always a
            # revoked or mistyped token, and the generic message sends people
            # looking at the wrong thing.
            if response.status_code == 401:
                raise TelegramError(
                    f"{method}: Telegram rejected the token (401 {description}). "
                    "It may have been revoked with /revoke in BotFather."
                )
            raise TelegramError(f"{method}: {description}")

        return payload.get("result")

    def get_me(self) -> BotIdentity:
        result = self._call("getMe")
        return BotIdentity(
            id=int(result["id"]),
            username=str(result.get("username", "")),
            first_name=str(result.get("first_name", "")),
            can_join_groups=bool(result.get("can_join_groups", False)),
            can_read_all_group_messages=bool(
                result.get("can_read_all_group_messages", False)
            ),
        )

    def get_webhook_status(self) -> WebhookStatus:
        result = self._call("getWebhookInfo")
        return WebhookStatus(
            url=str(result.get("url", "")),
            pending_update_count=int(result.get("pending_update_count", 0)),
            last_error_message=result.get("last_error_message"),
            last_error_date=result.get("last_error_date"),
            allowed_updates=tuple(result.get("allowed_updates", ())),
            has_custom_certificate=bool(result.get("has_custom_certificate", False)),
        )

    def get_seen_chats(self) -> list[SeenChat]:
        """Chats visible via ``getUpdates``, for discovering the group ID.

        Returns an empty list when a webhook is registered: Telegram refuses
        ``getUpdates`` in that case, which is expected rather than an error.
        """
        try:
            updates = self._call("getUpdates")
        except TelegramError as error:
            if "webhook is active" in str(error).lower():
                return []
            raise

        chats: dict[int, SeenChat] = {}
        for update in updates or []:
            message = update.get("message") or (
                update.get("callback_query") or {}
            ).get("message")
            chat = (message or {}).get("chat")
            if not chat:
                continue
            title = chat.get("title") or " ".join(
                part for part in (chat.get("first_name"), chat.get("last_name")) if part
            )
            chats[int(chat["id"])] = SeenChat(
                id=int(chat["id"]),
                type=str(chat.get("type", "unknown")),
                title=str(title or ""),
            )
        return sorted(chats.values(), key=lambda seen: seen.id)
