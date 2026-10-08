"""Tests for the knowledge-file contract.

The Worker imports knowledge/corpus/ardb-corpus.json directly, so a drift
between this schema and src/core/knowledge.ts breaks the deployed bot at build
time. These tests pin the shape, and the two-stage provenance that tells a
corpus apart from the archive it was built from.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from ardb import knowledge as kb


def entry(**overrides) -> kb.KnowledgeEntry:
    base = {
        "id": "agricultural-loan",
        "title": "Agricultural loan",
        "url": "https://www.ardb.com.kh/agricultural-loan/",
        "language": "en",
        "category": "loan-products",
        "content": "Available to farmers and agricultural cooperatives.",
    }
    return kb.KnowledgeEntry(**{**base, **overrides})


class TestClassifyLanguage:
    def test_pure_khmer(self):
        assert kb.classify_language("តើខ្ញុំអាចស្នើសុំកម្ចីបានដោយរបៀបណា?") == "km"

    def test_pure_english(self):
        assert kb.classify_language("How do I apply for a loan?") == "en"

    def test_khmer_with_an_english_product_name_stays_khmer(self):
        assert kb.classify_language("តើ ARDB មានកម្ចីសម្រាប់កសិករទេ?") == "km"

    def test_balanced_page_is_mixed(self):
        assert kb.classify_language("loan requirements តើត្រូវការឯកសារអ្វីខ្លះសម្រាប់ការ") == "mixed"

    def test_no_letters_defaults_to_english(self):
        # A numbers-only page has no language; English is the safe default
        # because the schema has no "unknown" and the Worker never reads this
        # field to choose a reply language.
        assert kb.classify_language("12345 !!!") == "en"
        assert kb.classify_language("") == "en"

    def test_thresholds_match_the_typescript_detector(self):
        # src/core/language.ts uses the same 0.75 / 0.25 boundaries. Khmer
        # script is 3 of 4 letters here.
        assert kb.classify_language("កកកa") == "km"
        assert kb.classify_language("abcក") == "en"


class TestCategorize:
    @pytest.mark.parametrize(
        "url,expected",
        [
            ("https://x/agricultural-loan/", "loan-products"),
            ("https://x/credit-requirements/", "loan-products"),
            ("https://x/fixed-deposit/", "deposit-products"),
            ("https://x/savings-account/", "deposit-products"),
            ("https://x/service-tariff/", "rates-and-fees"),
            ("https://x/mobile-banking/", "digital-banking"),
            ("https://x/branch-locations/", "branches-and-contact"),
            ("https://x/faq/", "faq"),
            ("https://x/profile/", "about"),
            ("https://x/something-else/", "general"),
        ],
    )
    def test_assignment(self, url, expected):
        assert kb.categorize(url) == expected

    def test_loans_win_over_rates(self):
        # A customer asking about loan interest asks about loans, so filing it
        # under loan-products is where a reviewer looks for it.
        assert kb.categorize("https://x/loan-interest-rate/") == "loan-products"


class TestSlugify:
    def test_readable_slug_from_path(self):
        assert kb.slugify("https://www.ardb.com.kh/agricultural-loan/") == "agricultural-loan"

    def test_homepage(self):
        assert kb.slugify("https://www.ardb.com.kh/") == "home"
        assert kb.slugify("https://www.ardb.com.kh") == "home"

    def test_nested_path_flattens(self):
        assert kb.slugify("https://x/products/loans/short-term/") == "products-loans-short-term"

    def test_punctuation_and_query_dropped(self):
        assert kb.slugify("https://x/?p=110") == "home"
        assert kb.slugify("https://x/loan_%20type/") == "loan-type"

    def test_khmer_url_slugs_do_not_collide_with_each_other_or_home(self):
        # A Cambodian bank's CMS can easily produce Khmer URL slugs. These
        # have no ASCII alphanumerics, so a naive slug is empty and every
        # such page would overwrite the next -- and the homepage with it.
        loan = kb.slugify("https://www.ardb.com.kh/កម្ចី/")
        deposit = kb.slugify("https://www.ardb.com.kh/ប្រាក់បញ្ញើ/")
        home = kb.slugify("https://www.ardb.com.kh/")

        assert loan != deposit
        assert loan != home and deposit != home
        assert loan.startswith("page-")

    def test_percent_encoded_khmer_matches_its_decoded_form(self):
        # The crawler sees whichever form the site links with; both must land
        # on the same entry rather than producing a duplicate.
        assert kb.slugify(
            "https://www.ardb.com.kh/%E1%9E%80%E1%9E%98%E1%9F%92%E1%9E%85%E1%9E%B8/"
        ) == kb.slugify("https://www.ardb.com.kh/កម្ចី/")

    def test_digest_fallback_is_stable(self):
        url = "https://www.ardb.com.kh/សេវាកម្ម/"
        assert kb.slugify(url) == kb.slugify(url)

    def test_bounded_length(self):
        slug = kb.slugify("https://x/" + "a" * 200)
        assert len(slug) <= 60
        assert not slug.endswith("-")

    def test_stable_across_calls(self):
        # A changing ID would churn the file on every scrape.
        url = "https://www.ardb.com.kh/deposit/"
        assert kb.slugify(url) == kb.slugify(url)


class TestMergeEntries:
    def test_sorted_by_id_for_cache_stability(self):
        # Distinct content, so this exercises ordering rather than the
        # identical-content dedupe below.
        merged = kb.merge_entries(
            [
                entry(id="zebra", content="third"),
                entry(id="alpha", content="first"),
                entry(id="middle", content="second"),
            ],
            [],
        )
        assert [item.id for item in merged] == ["alpha", "middle", "zebra"]

    def test_manual_entries_are_preserved(self):
        manual = entry(id="manual-rates", url=kb.MANUAL_URL, content="hand-written")
        merged = kb.merge_entries([entry(id="scraped", content="scraped")], [manual])
        assert {item.id for item in merged} == {"manual-rates", "scraped"}

    def test_manual_overrides_a_scraped_page_of_the_same_id(self):
        # This is what lets staff correct a badly-read page without touching
        # the scraper.
        scraped = entry(id="faq", content="garbled navigation blob")
        manual = entry(id="faq", url=kb.MANUAL_URL, content="the correct answer")
        merged = kb.merge_entries([scraped], [manual])
        assert len(merged) == 1
        assert merged[0].content == "the correct answer"
        assert merged[0].is_manual

    def test_duplicate_scraped_ids_collapse(self):
        merged = kb.merge_entries([entry(id="same"), entry(id="same")], [])
        assert len(merged) == 1


class TestSchemaContract:
    def test_serializes_to_the_camelcase_shape_typescript_reads(self):
        base = kb.KnowledgeBase(
            version="2026-10-07-1",
            generated_at="2026-10-07T00:00:00Z",
            source="https://www.ardb.com.kh",
            entries=(entry(),),
        )
        payload = base.to_dict()

        assert set(payload) == {"version", "generatedAt", "source", "stage", "entries"}
        assert set(payload["entries"][0]) == {
            "id",
            "title",
            "url",
            "language",
            "category",
            "content",
        }

    def test_round_trips_through_json(self):
        original = kb.KnowledgeBase(
            version="v",
            generated_at="t",
            source="s",
            entries=(entry(content="ភាសាខ្មែរ"),),
        )
        restored = kb.KnowledgeBase.from_dict(json.loads(json.dumps(original.to_dict())))
        assert restored == original

    def test_rejects_an_entry_missing_fields(self):
        with pytest.raises(ValueError, match="missing fields"):
            kb.KnowledgeEntry.from_dict({"id": "x", "title": "y"})

    def test_unknown_language_coerced_rather_than_crashing(self):
        # A hand-edited file with a typo should not take the scraper down.
        restored = kb.KnowledgeEntry.from_dict({**entry().to_dict(), "language": "fr"})
        assert restored.language == "en"

    def test_committed_files_match_the_schema(self):
        for path in (kb.RAW_PATH, kb.CORPUS_PATH):
            parsed = kb.load(path)
            assert parsed.entries, f"{path} is empty"
            assert parsed.source.startswith("https://")

    def test_written_file_keeps_khmer_readable(self, tmp_path):
        # Escaped Khmer would make a pull request unreviewable.
        path = tmp_path / "kb.json"
        kb.dump(
            kb.KnowledgeBase(
                version="v", generated_at="t", source="s",
                entries=(entry(content="សួស្តី"),),
            ),
            path,
        )
        raw = path.read_text(encoding="utf-8")
        assert "សួស្តី" in raw
        assert raw.endswith("\n")


class TestVersion:
    def test_date_and_count(self):
        moment = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
        assert kb.build_version(23, moment) == "2026-10-07-23"


class TestCostEstimate:
    def test_estimates_tokens_from_content_only(self):
        base = kb.KnowledgeBase(
            version="v", generated_at="t", source="s",
            entries=(entry(content="x" * 3500),),
        )
        assert base.total_chars == 3500
        assert base.estimated_tokens == 1000


class TestPullRequestBody:
    def test_carries_the_summary_and_the_accuracy_checklist(self):
        from scrape_knowledge import build_pr_body

        base = kb.KnowledgeBase(
            version="2026-10-07-3",
            generated_at="2026-10-07T00:00:00Z",
            source="https://www.ardb.com.kh",
            entries=(entry(),),
        )
        body = build_pr_body("Visited 10 page(s), kept 3.", base)

        assert "Visited 10 page(s), kept 3." in body
        # The review that matters is accuracy, not formatting.
        assert "Interest rates, fees and loan ceilings" in body
        assert '"url": "manual"' in body
        assert "- [ ]" in body

    def test_is_not_indented_so_markdown_renders(self):
        from scrape_knowledge import build_pr_body

        base = kb.KnowledgeBase(version="v", generated_at="t", source="s", entries=())
        for line in build_pr_body("summary", base).splitlines():
            assert line == line.lstrip(), f"indented line would render as code: {line!r}"


class TestDeduplication:
    def test_drops_a_page_served_under_several_urls(self):
        # ARDB serves the same homepage at /, /en and /km. Sending it three
        # times with every question buys nothing and costs tokens.
        shared = "Welcome to ARDB."
        merged = kb.merge_entries(
            [
                entry(id="home", url="https://x", content=shared),
                entry(id="en", url="https://x/en", content=shared),
                entry(id="km", url="https://x/km", content=shared),
            ],
            [],
        )
        assert len(merged) == 1

    def test_keeps_the_canonical_page_not_the_language_alias(self):
        # The real case from ardb.com.kh: / and /en serve identical content.
        # Keying on ID length would keep "en" and discard "home".
        shared = "Welcome to ARDB."
        merged = kb.merge_entries(
            [
                entry(id="en", url="https://www.ardb.com.kh/en", content=shared),
                entry(id="home", url="https://www.ardb.com.kh", content=shared),
            ],
            [],
        )
        assert [item.id for item in merged] == ["home"]

    def test_keeps_pages_that_merely_overlap(self):
        merged = kb.merge_entries(
            [
                entry(id="a", content="Loans are available."),
                entry(id="b", content="Loans are available. Terms apply."),
            ],
            [],
        )
        assert len(merged) == 2

    def test_never_drops_a_manual_entry(self):
        # When a hand-written entry and a scraped page carry byte-identical
        # content, the hand-written one is the keeper: it is the version a
        # person vouched for, and the scraped copy adds nothing.
        shared = "The correct answer."
        merged = kb.merge_entries(
            [entry(id="scraped", content=shared)],
            [entry(id="manual-note", url=kb.MANUAL_URL, content=shared)],
        )
        assert [item.id for item in merged] == ["manual-note"]

    def test_result_stays_sorted_after_dropping(self):
        shared = "same"
        merged = kb.merge_entries(
            [entry(id="zz", content=shared), entry(id="aa", content="other"),
             entry(id="bb", content=shared)],
            [],
        )
        ids = [item.id for item in merged]
        assert ids == sorted(ids)


class TestDisplayPath:
    """`--output` accepts any path, and Path.relative_to raises instead of
    falling back -- so printing the result crashed *after* the file had been
    written, turning a finished run into a traceback and a failing exit."""

    def test_repo_relative_inside_the_repo(self):
        from consolidate_knowledge import REPO_ROOT, _display_path

        shown = _display_path(REPO_ROOT / "knowledge" / "corpus" / "ardb-corpus.json")
        assert shown == "knowledge/corpus/ardb-corpus.json"

    def test_absolute_outside_the_repo_rather_than_raising(self, tmp_path):
        from consolidate_knowledge import _display_path

        target = tmp_path / "elsewhere.json"
        assert _display_path(target) == str(target)

    def test_the_scraper_has_the_same_guard(self, tmp_path):
        from scrape_knowledge import _display_path

        assert _display_path(tmp_path / "x.json") == str(tmp_path / "x.json")


class TestStageAndProvenance:
    """The two files are told apart by a field, not by their path.

    A path mix-up is the failure this guards: scraping over the corpus, or
    building a corpus from a corpus. Both are a one-word mistake in a
    workflow, and both are silent without `stage`.
    """

    def test_stage_defaults_to_raw(self):
        base = kb.KnowledgeBase(
            version="1", generated_at="now", source="https://x", entries=(entry(),)
        )
        assert base.stage == "raw"
        assert base.to_dict()["stage"] == "raw"

    def test_built_from_is_omitted_when_absent(self):
        base = kb.KnowledgeBase(
            version="1", generated_at="now", source="https://x", entries=(entry(),)
        )
        assert "builtFrom" not in base.to_dict()

    def test_round_trip_preserves_stage_and_provenance(self):
        corpus = kb.KnowledgeBase(
            version="2026-10-08-1-en",
            generated_at="2026-10-08T00:00:00Z",
            source="https://www.ardb.com.kh",
            entries=(entry(),),
            stage="corpus",
            built_from=kb.Provenance(
                version="2026-10-08-1",
                generated_at="2026-10-07T00:00:00Z",
                digest="abc123",
                source="https://www.ardb.com.kh",
            ),
        )
        reloaded = kb.KnowledgeBase.from_dict(json.loads(json.dumps(corpus.to_dict())))
        assert reloaded.stage == "corpus"
        assert reloaded.built_from == corpus.built_from

    def test_an_unknown_stage_reads_as_raw(self):
        # Treating a corrupt value as "corpus" would let a scrape be
        # mistaken for reviewed English. "raw" is the safe reading.
        parsed = kb.KnowledgeBase.from_dict({"stage": "nonsense", "entries": []})
        assert parsed.stage == "raw"

    def test_a_file_without_a_stage_reads_as_raw(self):
        parsed = kb.KnowledgeBase.from_dict({"entries": []})
        assert parsed.stage == "raw"


class TestDigest:
    def test_digest_ignores_version_and_timestamp(self):
        # A re-scrape that finds the site unchanged must produce the same
        # digest, or every re-run would mark the corpus stale.
        first = kb.KnowledgeBase(
            version="2026-10-08-1", generated_at="A", source="s", entries=(entry(),)
        )
        second = kb.KnowledgeBase(
            version="2026-11-01-1", generated_at="B", source="s", entries=(entry(),)
        )
        assert first.digest == second.digest

    def test_digest_changes_with_content(self):
        first = kb.KnowledgeBase(
            version="1", generated_at="A", source="s", entries=(entry(),)
        )
        second = kb.KnowledgeBase(
            version="1",
            generated_at="A",
            source="s",
            entries=(entry(content="Rates have changed."),),
        )
        assert first.digest != second.digest

    def test_provenance_carries_this_file_s_digest(self):
        base = kb.KnowledgeBase(
            version="v", generated_at="t", source="s", entries=(entry(),)
        )
        assert base.provenance == kb.Provenance(
            version="v", generated_at="t", digest=base.digest, source="s"
        )


class TestPendingAndEnglishCount:
    def test_counts_by_language(self):
        base = kb.KnowledgeBase(
            version="v",
            generated_at="t",
            source="s",
            entries=(
                entry(id="a", language="en"),
                entry(id="b", language="km"),
                entry(id="c", language="mixed"),
            ),
        )
        assert base.english_count == 1
        assert [item.id for item in base.pending] == ["b", "c"]


class TestHistory:
    def test_append_then_read(self, tmp_path):
        path = tmp_path / "HISTORY.jsonl"
        kb.append_history({"stage": "raw", "version": "1"}, path)
        kb.append_history({"stage": "corpus", "version": "1-en"}, path)
        records = kb.read_history(path)
        assert [record["stage"] for record in records] == ["raw", "corpus"]

    def test_appending_leaves_earlier_lines_byte_identical(self, tmp_path):
        # The point of JSON Lines over a JSON array: two runs landing in one
        # pull request conflict on the tail, not on the whole file.
        path = tmp_path / "HISTORY.jsonl"
        kb.append_history({"stage": "raw"}, path)
        first = path.read_text(encoding="utf-8")
        kb.append_history({"stage": "corpus"}, path)
        assert path.read_text(encoding="utf-8").startswith(first)

    def test_a_malformed_line_is_skipped_not_fatal(self, tmp_path):
        path = tmp_path / "HISTORY.jsonl"
        path.write_text('{"stage": "raw"}\nnot json\n{"stage": "corpus"}\n')
        assert [record["stage"] for record in kb.read_history(path)] == [
            "raw",
            "corpus",
        ]

    def test_missing_file_is_empty(self, tmp_path):
        assert kb.read_history(tmp_path / "absent.jsonl") == ()
