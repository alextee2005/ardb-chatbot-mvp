"""Tests for consolidation, with the model stubbed out.

The point of these is the verification guard, not the model: a dropped or
invented figure must fail the entry rather than ship it. No network.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from ardb.consolidate import (
    FatalConsolidationError,
    TRANSPORT_FAILURE,
    VERIFICATION_FAILURE,
    build_user_message,
    consolidate_entry,
)
from ardb.knowledge import KnowledgeEntry


@dataclass
class _Block:
    text: str
    type: str = "text"


@dataclass
class _Response:
    content: list
    stop_reason: str = "end_turn"
    stop_details: object = None


class _StubMessages:
    def __init__(self, payload, *, stop_reason="end_turn", error=None):
        self.payload = payload
        self.stop_reason = stop_reason
        self.error = error
        self.last_request = None

    def create(self, **kwargs):
        self.last_request = kwargs
        if self.error is not None:
            raise self.error
        body = (
            self.payload
            if isinstance(self.payload, str)
            else json.dumps(self.payload)
        )
        return _Response(content=[_Block(text=body)], stop_reason=self.stop_reason)


class _StubClient:
    def __init__(self, payload, *, stop_reason="end_turn", error=None):
        self.messages = _StubMessages(payload, stop_reason=stop_reason, error=error)


def khmer_entry(**overrides) -> KnowledgeEntry:
    base = {
        "id": "fixed-deposit",
        "title": "ប្រាក់បញ្ញើមានកាលកំណត់",
        "url": "https://www.ardb.com.kh/product-service/deposits/fixed-deposit",
        "language": "km",
        "category": "deposit-products",
        # Real shape: a 12-month term at 4.00%, written in Khmer numerals with
        # a comma for the decimal point.
        "content": "រយៈពេល ១២ខែ អត្រាការប្រាក់ ៤,០០% ក្នុងមួយឆ្នាំ។",
    }
    return KnowledgeEntry(**{**base, **overrides})


def payload(content: str, *, title="Fixed deposit", substantive=True):
    return {"title": title, "content": content, "substantive": substantive}


class TestVerificationPasses:
    def test_a_faithful_restatement_is_accepted(self):
        client = _StubClient(
            payload("For a 12-month term the annual interest rate is 4.00%.")
        )
        result = consolidate_entry(client, khmer_entry())

        assert result.ok
        assert result.missing_numbers == ()
        assert result.invented_numbers == ()
        assert result.entry.language == "en"
        assert "4.00%" in result.entry.content

    def test_the_khmer_source_is_retained_verbatim(self):
        # Without this the consolidation is unfalsifiable: nobody could check
        # a bad answer against what ARDB actually published.
        original = khmer_entry()
        client = _StubClient(payload("A 12-month term earns 4.00% a year."))
        result = consolidate_entry(client, original)

        assert result.entry.source_text == original.content
        assert result.entry.source_language == "km"
        assert result.entry.is_consolidated

    def test_identity_fields_are_preserved(self):
        original = khmer_entry()
        client = _StubClient(payload("A 12-month term earns 4.00% a year."))
        result = consolidate_entry(client, original)

        assert result.entry.id == original.id
        assert result.entry.url == original.url
        assert result.entry.category == original.category

    def test_dropping_a_trailing_zero_is_still_faithful(self):
        client = _StubClient(payload("A 12-month term earns 4% a year."))
        assert consolidate_entry(client, khmer_entry()).ok


class TestVerificationCatchesFigureErrors:
    def test_a_dropped_rate_fails_the_entry(self):
        client = _StubClient(payload("Fixed deposits are available for 12 months."))
        result = consolidate_entry(client, khmer_entry())

        assert not result.ok
        assert result.failure_kind == VERIFICATION_FAILURE
        assert result.failed_verification
        assert "4" in result.missing_numbers

    def test_an_invented_rate_fails_the_entry(self):
        # The dangerous failure: a figure from nowhere reads exactly like a
        # real one, so a moderator approving by eye cannot tell.
        client = _StubClient(
            payload("A 12-month term earns 4.00%, and a 24-month term earns 5.50%.")
        )
        result = consolidate_entry(client, khmer_entry())

        assert not result.ok
        assert "5.5" in result.invented_numbers

    def test_a_misread_separator_fails_the_entry(self):
        # If anything turned 4,00% into 400%, this is the backstop.
        client = _StubClient(payload("A 12-month term earns 400% a year."))
        result = consolidate_entry(client, khmer_entry())

        assert not result.ok
        assert "400" in result.invented_numbers

    def test_a_term_swapped_for_another_number_fails(self):
        client = _StubClient(payload("A 24-month term earns 4.00% a year."))
        result = consolidate_entry(client, khmer_entry())

        assert not result.ok
        assert "12" in result.missing_numbers
        assert "24" in result.invented_numbers


class TestFailureModes:
    def test_a_refusal_fails_rather_than_producing_an_entry(self):
        client = _StubClient(payload("..."), stop_reason="refusal")
        result = consolidate_entry(client, khmer_entry())
        assert not result.ok
        assert "declined" in result.note

    def test_truncated_output_fails(self):
        # A cut-off entry would silently lose whatever came after the cut.
        client = _StubClient(payload("A 12-month term earns 4.00%"), stop_reason="max_tokens")
        result = consolidate_entry(client, khmer_entry())
        assert not result.ok
        assert "cut off" in result.note

    def test_unparseable_output_fails(self):
        client = _StubClient("not json at all")
        result = consolidate_entry(client, khmer_entry())
        assert not result.ok
        assert "structured output" in result.note

    def test_a_transport_error_fails_the_entry_without_raising(self):
        import anthropic

        error = anthropic.APIError("boom", request=None, body=None)
        client = _StubClient(payload("x"), error=error)
        result = consolidate_entry(client, khmer_entry())

        assert not result.ok
        assert result.failure_kind == TRANSPORT_FAILURE
        # Not a verification failure: nothing is wrong with the translation,
        # because there is no translation.
        assert not result.failed_verification

    def test_a_rejected_credential_aborts_the_whole_run(self):
        # The real first-run failure: an invalid key produced 33 sequential
        # 401s, every one reported as "failed verification", which sent the
        # reader looking for translation faults that did not exist.
        import anthropic
        import httpx2

        error = anthropic.AuthenticationError(
            "invalid x-api-key",
            response=httpx2.Response(401, request=httpx2.Request("POST", "https://x")),
            body=None,
        )
        client = _StubClient(payload("x"), error=error)

        with pytest.raises(FatalConsolidationError, match="ANTHROPIC_API_KEY"):
            consolidate_entry(client, khmer_entry())

    def test_a_permission_error_also_aborts(self):
        import anthropic
        import httpx2

        error = anthropic.PermissionDeniedError(
            "no access",
            response=httpx2.Response(403, request=httpx2.Request("POST", "https://x")),
            body=None,
        )
        client = _StubClient(payload("x"), error=error)

        with pytest.raises(FatalConsolidationError):
            consolidate_entry(client, khmer_entry())

    def test_a_refusal_is_not_reported_as_a_figure_mismatch(self):
        client = _StubClient(payload("..."), stop_reason="refusal")
        result = consolidate_entry(client, khmer_entry())
        assert not result.failed_verification

    def test_a_non_substantive_page_is_noted_but_not_failed(self):
        client = _StubClient(
            payload("This page lists links only.", substantive=False),
            # No figures in source or output, so verification passes.
        )
        entry = khmer_entry(content="សូមមើលទំព័រផ្សេងទៀត។")
        result = consolidate_entry(client, entry)
        assert result.ok
        assert "no usable information" in result.note


class TestRequestShape:
    def test_figures_are_normalized_before_the_model_sees_them(self):
        # The whole safety argument rests on this: the model is never asked to
        # interpret ៤,០០%.
        client = _StubClient(payload("A 12-month term earns 4.00% a year."))
        consolidate_entry(client, khmer_entry())

        sent = client.messages.last_request["messages"][0]["content"]
        assert "4.00%" in sent
        assert "៤,០០%" not in sent
        assert "១២" not in sent

    def test_effort_and_structured_output_are_requested(self):
        client = _StubClient(payload("A 12-month term earns 4.00% a year."))
        consolidate_entry(client, khmer_entry(), effort="max")

        config = client.messages.last_request["output_config"]
        assert config["effort"] == "max"
        assert config["format"]["type"] == "json_schema"

    def test_the_prompt_forbids_inventing_figures(self):
        from ardb.consolidate import CONSOLIDATION_SYSTEM

        assert "State no figure that is not in the source" in CONSOLIDATION_SYSTEM
        assert "Never guess which row or column" in CONSOLIDATION_SYSTEM


class TestUserMessage:
    def test_carries_the_title_url_and_page_body(self):
        message = build_user_message(khmer_entry(), "A 12-month term earns 4.00%.")
        assert "fixed-deposit" in message
        assert "<page>" in message and "</page>" in message
        assert "4.00%" in message


def _status_error(cls, status: int, message: str):
    """Build a real SDK error carrying an API-shaped body."""
    import httpx2

    return cls(
        message,
        response=httpx2.Response(
            status, request=httpx2.Request("POST", "https://api.anthropic.com")
        ),
        body={"type": "error", "error": {"type": "invalid_request_error", "message": message}},
    )


WORKSPACE_MESSAGE = (
    "This API key is not scoped to a workspace, so this request must include "
    "the anthropic-workspace-id header with the ID of the workspace to use. "
    "Add the header, or use an API key that is scoped to a workspace."
)


class TestWorkspaceScoping:
    """The real second-run failure: the key authenticated, then every request
    was rejected for want of a workspace."""

    def test_an_unscoped_key_aborts_instead_of_advising_a_re_run(self):
        import anthropic

        error = _status_error(anthropic.BadRequestError, 400, WORKSPACE_MESSAGE)
        client = _StubClient(payload("x"), error=error)

        with pytest.raises(FatalConsolidationError) as caught:
            consolidate_entry(client, khmer_entry())

        # Must carry the API's own words, which name the remedy.
        assert "not scoped to a workspace" in str(caught.value)
        assert "re-running will not help" in str(caught.value)

    def test_the_client_sends_the_workspace_header_when_given_one(self):
        from ardb.consolidate import build_client

        client = build_client(api_key="sk-ant-test", workspace_id="wrkspc_123")
        assert client.default_headers["anthropic-workspace-id"] == "wrkspc_123"

    def test_no_header_when_no_workspace_is_configured(self):
        from ardb.consolidate import build_client

        client = build_client(api_key="sk-ant-test")
        assert "anthropic-workspace-id" not in client.default_headers

    @pytest.mark.parametrize(
        "message",
        [
            WORKSPACE_MESSAGE,
            "Your credit balance is too low to access the Claude API.",
            "model: claude-nonexistent not found",
            "Your organization has been disabled.",
        ],
    )
    def test_account_level_400s_are_all_fatal(self, message):
        # None of these describe the page, so none are worth 33 attempts.
        import anthropic

        client = _StubClient(
            payload("x"), error=_status_error(anthropic.BadRequestError, 400, message)
        )
        with pytest.raises(FatalConsolidationError):
            consolidate_entry(client, khmer_entry())

    def test_a_page_specific_400_still_fails_only_that_entry(self):
        # A request too large for the model is about this page, so the rest of
        # the corpus should still be attempted.
        import anthropic

        client = _StubClient(
            payload("x"),
            error=_status_error(
                anthropic.BadRequestError, 400, "prompt is too long: 500000 tokens"
            ),
        )
        result = consolidate_entry(client, khmer_entry())
        assert not result.ok
        assert not result.failed_verification


class TestCredentialPreflight:
    def test_passes_on_a_working_credential(self):
        from ardb.consolidate import verify_credentials

        client = _StubClient(payload("ok"))
        verify_credentials(client)  # must not raise

    def test_sends_no_page_content(self):
        # The point of the pre-flight is that nothing about the corpus can be
        # blamed for its failure.
        from ardb.consolidate import verify_credentials

        client = _StubClient(payload("ok"))
        verify_credentials(client)

        sent = client.messages.last_request["messages"][0]["content"]
        assert sent == "ok"
        assert client.messages.last_request["max_tokens"] == 1

    def test_surfaces_the_workspace_error_before_any_entry_is_sent(self):
        import anthropic
        from ardb.consolidate import verify_credentials

        client = _StubClient(
            payload("x"),
            error=_status_error(anthropic.BadRequestError, 400, WORKSPACE_MESSAGE),
        )
        with pytest.raises(FatalConsolidationError, match="not scoped to a workspace"):
            verify_credentials(client)

    def test_surfaces_a_rejected_key(self):
        import anthropic
        from ardb.consolidate import verify_credentials

        client = _StubClient(
            payload("x"),
            error=_status_error(anthropic.AuthenticationError, 401, "invalid x-api-key"),
        )
        with pytest.raises(FatalConsolidationError, match="ANTHROPIC_API_KEY"):
            verify_credentials(client)
