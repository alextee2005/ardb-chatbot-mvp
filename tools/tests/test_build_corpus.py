"""Tests for stage 2: building the English corpus from the raw archive.

Two things matter here and neither is about English prose. The first is that a
restatement whose figures do not match the published page is refused -- the
bot quoting an interest rate it invented is the failure this whole pipeline
exists to prevent. The second is provenance: a corpus must say which archive
it came from, so a corpus left behind by a newer scrape can be detected rather
than quietly served.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import build_corpus
from ardb import knowledge as kb

WHEN = datetime(2026, 10, 8, 12, 0, 0, tzinfo=timezone.utc)


def khmer_entry(**overrides) -> kb.KnowledgeEntry:
    base = {
        "id": "saving-deposit",
        "title": "ប្រាក់បញ្ញើសន្សំ",
        "url": "https://www.ardb.com.kh/product-service/deposits/saving-deposit",
        "language": "km",
        "category": "deposit-products",
        "content": "អត្រាការប្រាក់ ១,៥០% ក្នុងមួយឆ្នាំ។ ប្រាក់បញ្ញើតិចបំផុត ៤០,០០០ រៀល។",
    }
    return kb.KnowledgeEntry(**{**base, **overrides})


def archive(*entries: kb.KnowledgeEntry) -> kb.KnowledgeBase:
    return kb.KnowledgeBase(
        version="2026-10-08-1",
        generated_at="2026-10-08T03:00:00Z",
        source="https://www.ardb.com.kh",
        entries=entries or (khmer_entry(),),
        stage="raw",
    )


GOOD_ENGLISH = (
    "Savings deposit",
    "The interest rate is 1.50% a year. The minimum deposit is 40,000 riel.",
)


class TestBuild:
    def test_restates_a_page_and_retains_the_original(self):
        raw = archive()
        corpus, rejected = build_corpus.build(
            raw, {"saving-deposit": GOOD_ENGLISH}, {}, now=WHEN
        )

        assert rejected == []
        built = corpus.entries[0]
        assert built.language == "en"
        assert built.title == "Savings deposit"
        assert built.content == GOOD_ENGLISH[1]
        # The published page, kept verbatim. Without it the restatement is
        # unfalsifiable: nothing to check a disputed figure against.
        assert built.source_text == raw.entries[0].content
        assert built.source_language == "km"

    def test_records_the_archive_it_was_built_from(self):
        raw = archive()
        corpus, _ = build_corpus.build(
            raw, {"saving-deposit": GOOD_ENGLISH}, {}, now=WHEN
        )
        assert corpus.stage == "corpus"
        assert corpus.built_from == raw.provenance
        assert corpus.built_from.digest == raw.digest

    def test_version_is_dated_and_marked_english(self):
        corpus, _ = build_corpus.build(
            archive(), {"saving-deposit": GOOD_ENGLISH}, {}, now=WHEN
        )
        assert corpus.version == "2026-10-08-1-en"
        assert corpus.generated_at == "2026-10-08T12:00:00Z"

    def test_a_restatement_that_drops_a_figure_is_refused(self):
        # The minimum deposit is gone. Shipping this would have the bot state
        # a rate with no stated minimum, sourced from a page that has one.
        corpus, rejected = build_corpus.build(
            archive(),
            {"saving-deposit": ("Savings deposit", "The interest rate is 1.50% a year.")},
            {},
            now=WHEN,
        )
        assert [entry_id for entry_id, _, _ in rejected] == ["saving-deposit"]
        assert "40000" in rejected[0][1]
        # Refused, so the page keeps its published Khmer rather than shipping
        # a partial translation.
        assert corpus.entries[0].language == "km"
        assert corpus.entries[0].source_text is None

    def test_a_restatement_that_invents_a_figure_is_refused(self):
        corpus, rejected = build_corpus.build(
            archive(),
            {
                "saving-deposit": (
                    "Savings deposit",
                    "The interest rate is 1.50% a year. The minimum deposit is "
                    "40,000 riel. Loans up to 250,000 US dollars.",
                )
            },
            {},
            now=WHEN,
        )
        assert rejected and rejected[0][2]
        assert corpus.entries[0].language == "km"

    def test_allow_missing_lets_a_figure_be_dropped_deliberately(self):
        raw = archive(
            khmer_entry(
                id="home",
                content="អត្រាការប្រាក់ ១,៥០%។ ព័ត៌មានថ្ងៃទី ២២។",
            )
        )
        corpus, rejected = build_corpus.build(
            raw,
            {"home": ("Rates", "The interest rate is 1.50%.")},
            {"home": {"22"}},
            now=WHEN,
        )
        assert rejected == []
        assert corpus.entries[0].language == "en"

    def test_a_page_with_no_restatement_is_carried_through_unchanged(self):
        raw = archive(khmer_entry(), khmer_entry(id="other", content="អត្រា ៨%។"))
        corpus, rejected = build_corpus.build(
            raw, {"saving-deposit": GOOD_ENGLISH}, {}, now=WHEN
        )
        assert rejected == []
        carried = {entry.id: entry for entry in corpus.entries}["other"]
        assert carried == raw.entries[1]
        assert [entry.id for entry in corpus.pending] == ["other"]

    def test_entries_come_out_sorted(self):
        # Sorted order is what keeps the rendered corpus byte-identical
        # between requests, which the Worker's prompt cache depends on.
        raw = archive(
            khmer_entry(id="zebra"), khmer_entry(id="alpha"), khmer_entry(id="middle")
        )
        corpus, _ = build_corpus.build(raw, {}, {}, now=WHEN)
        ids = [entry.id for entry in corpus.entries]
        assert ids == sorted(ids)

    def test_an_english_page_needs_no_restatement_to_count(self):
        raw = archive(khmer_entry(id="en-page", language="en", content="Rates: 8%."))
        corpus, _ = build_corpus.build(raw, {}, {}, now=WHEN)
        assert corpus.english_count == 1
        assert corpus.pending == ()


class TestDiscoverRestatements:
    def test_finds_modules_in_order_and_skips_private(self, tmp_path):
        for name in ("english_batch2.py", "english_batch1.py", "__init__.py", "_wip.py"):
            (tmp_path / name).write_text("ENGLISH = {}\n")
        assert build_corpus.discover_restatements(tmp_path) == (
            "english_batch1",
            "english_batch2",
        )

    def test_missing_directory_is_empty(self, tmp_path):
        assert build_corpus.discover_restatements(tmp_path / "absent") == ()

    def test_the_committed_batches_are_discovered(self):
        # Discovery, not an argument list: a batch left off a command line
        # would leave pages in Khmer, and the symptom looks nothing like the
        # cause.
        assert build_corpus.discover_restatements() != ()


class TestCheck:
    def _corpus(self, raw: kb.KnowledgeBase, **overrides) -> kb.KnowledgeBase:
        fields = {
            "version": "2026-10-08-1-en",
            "generated_at": "2026-10-08T12:00:00Z",
            "source": raw.source,
            "entries": raw.entries,
            "stage": "corpus",
            "built_from": raw.provenance,
        }
        return kb.KnowledgeBase(**{**fields, **overrides})

    def test_current_corpus_passes(self):
        raw = archive()
        assert build_corpus.check(raw, self._corpus(raw)) == 0

    def test_corpus_built_from_an_older_archive_fails(self):
        old = archive()
        corpus = self._corpus(old)
        fresh = kb.KnowledgeBase(
            version="2026-11-01-1",
            generated_at="2026-11-01T03:00:00Z",
            source=old.source,
            entries=(khmer_entry(content="អត្រាការប្រាក់ ២,០០%។"),),
            stage="raw",
        )
        assert build_corpus.check(fresh, corpus) == 1

    def test_a_rescrape_that_found_nothing_new_is_still_current(self):
        # Same pages, new run: version and timestamp move, content does not.
        # Marking the corpus stale here would cry wolf every month.
        old = archive()
        corpus = self._corpus(old)
        rerun = kb.KnowledgeBase(
            version="2026-11-01-1",
            generated_at="2026-11-01T03:00:00Z",
            source=old.source,
            entries=old.entries,
            stage="raw",
        )
        assert build_corpus.check(rerun, corpus) == 0

    def test_a_corpus_with_no_provenance_fails(self):
        raw = archive()
        assert build_corpus.check(raw, self._corpus(raw, built_from=None)) == 1

    def test_no_corpus_fails(self):
        empty = kb.KnowledgeBase(version="", generated_at="", source="", entries=())
        assert build_corpus.check(archive(), empty) == 1

    def test_no_archive_fails(self):
        raw = archive()
        empty = kb.KnowledgeBase(version="", generated_at="", source="", entries=())
        assert build_corpus.check(empty, self._corpus(raw)) == 1


class TestMain:
    def _write(self, path, knowledge):
        path.parent.mkdir(parents=True, exist_ok=True)
        kb.dump(knowledge, path)

    def test_refuses_to_build_from_a_corpus(self, tmp_path, capsys):
        # Pointing stage 2 at its own output would restate a translation and
        # throw away the published original.
        source = archive()
        mislabelled = kb.KnowledgeBase(
            version=source.version,
            generated_at=source.generated_at,
            source=source.source,
            entries=source.entries,
            stage="corpus",
        )
        raw_path = tmp_path / "raw.json"
        self._write(raw_path, mislabelled)

        status = build_corpus.main(
            ["--raw", str(raw_path), "--corpus", str(tmp_path / "out.json")]
        )
        assert status == 2
        assert "not 'raw'" in capsys.readouterr().err

    def test_missing_archive_is_configuration_not_corpus(self, tmp_path, capsys):
        status = build_corpus.main(
            [
                "--raw",
                str(tmp_path / "absent.json"),
                "--corpus",
                str(tmp_path / "out.json"),
            ]
        )
        assert status == 2
        assert "stage 1" in capsys.readouterr().err

    def test_nothing_restated_is_a_hard_failure(self, tmp_path, capsys):
        # A corpus of untranslated Khmer is not a degraded corpus: the Worker's
        # prompt tells Claude the source material is English, so every draft
        # would be built on a false premise. Better no write at all.
        raw_path = tmp_path / "raw.json"
        self._write(raw_path, archive())
        out = tmp_path / "out.json"
        status = build_corpus.main(
            [
                "--raw",
                str(raw_path),
                "--corpus",
                str(out),
                "--restatements",
                str(tmp_path / "none"),
                "--history",
                str(tmp_path / "HISTORY.jsonl"),
            ]
        )
        assert status == 3
        assert not out.exists()

    def test_writes_the_corpus_and_logs_the_run(self, tmp_path):
        raw_path = tmp_path / "raw.json"
        self._write(raw_path, archive())
        restatements = tmp_path / "restatements"
        restatements.mkdir()
        (restatements / "batch.py").write_text(
            "ENGLISH = {'saving-deposit': ("
            "'Savings deposit', "
            "'The interest rate is 1.50% a year. The minimum deposit is 40,000 riel.'"
            ")}\n",
            encoding="utf-8",
        )
        out = tmp_path / "corpus" / "out.json"
        history = tmp_path / "HISTORY.jsonl"

        status = build_corpus.main(
            [
                "--raw",
                str(raw_path),
                "--corpus",
                str(out),
                "--restatements",
                str(restatements),
                "--history",
                str(history),
            ]
        )

        assert status == 0
        written = kb.load(out)
        assert written.stage == "corpus"
        assert written.english_count == 1
        assert written.built_from.digest == kb.load(raw_path).digest

        record = kb.read_history(history)[-1]
        assert record["stage"] == "corpus"
        assert record["builtFrom"]["digest"] == written.built_from.digest
        assert record["restatements"] == ["batch"]
        assert record["pending"] == []

    def test_outstanding_pages_report_as_exit_one_but_still_write(self, tmp_path):
        raw_path = tmp_path / "raw.json"
        self._write(raw_path, archive(khmer_entry(), khmer_entry(id="other")))
        restatements = tmp_path / "restatements"
        restatements.mkdir()
        (restatements / "batch.py").write_text(
            "ENGLISH = {'saving-deposit': ("
            "'Savings deposit', "
            "'The interest rate is 1.50% a year. The minimum deposit is 40,000 riel.'"
            ")}\n",
            encoding="utf-8",
        )
        out = tmp_path / "out.json"

        status = build_corpus.main(
            [
                "--raw",
                str(raw_path),
                "--corpus",
                str(out),
                "--restatements",
                str(restatements),
                "--history",
                str(tmp_path / "HISTORY.jsonl"),
            ]
        )

        # Partial is useful: one page restated beats none, and the untranslated
        # one is named rather than hidden.
        assert status == 1
        assert [entry.id for entry in kb.load(out).pending] == ["other"]


class TestCommittedPipeline:
    """The archive and corpus actually in the repository.

    These are the assertions CI makes, kept here so the same failure is caught
    before a push rather than after one.
    """

    def test_the_archive_holds_only_published_text(self):
        raw = kb.load(kb.RAW_PATH)
        assert raw.stage == "raw"
        assert not any(entry.is_consolidated for entry in raw.entries)

    def test_the_committed_corpus_is_what_a_build_produces(self):
        raw = kb.load(kb.RAW_PATH)
        english, allow = build_corpus.load_restatements(
            build_corpus.discover_restatements()
        )
        rebuilt, rejected = build_corpus.build(raw, english, allow)
        committed = kb.load(kb.CORPUS_PATH)

        assert rejected == []
        assert rebuilt.digest == committed.digest

    def test_the_committed_corpus_is_current(self):
        assert build_corpus.check(kb.load(kb.RAW_PATH), kb.load(kb.CORPUS_PATH)) == 0

    def test_every_committed_page_is_english(self):
        assert kb.load(kb.CORPUS_PATH).pending == ()


class TestStageOneGuard:
    """Stage 1's mirror image of the guard above.

    The two files differ by one path component, and a workflow that pointed
    the scraper at the corpus would replace every reviewed English page with
    raw Khmer -- while leaving the Worker's prompt insisting the source
    material is English. The guard refuses before the crawl starts, so it
    costs nothing to check.
    """

    def test_scraper_refuses_to_overwrite_a_corpus(self, tmp_path, capsys):
        import scrape_knowledge

        corpus = tmp_path / "corpus.json"
        kb.dump(
            kb.KnowledgeBase(
                version="2026-10-08-1-en",
                generated_at="2026-10-08T12:00:00Z",
                source="https://www.ardb.com.kh",
                entries=(khmer_entry(language="en", content="Rates: 8%."),),
                stage="corpus",
            ),
            corpus,
        )

        before = corpus.read_text(encoding="utf-8")
        # No --dry-run: the guard has to hold on a real run, and it has to
        # hold before the crawler touches the network.
        status = scrape_knowledge.main(["--output", str(corpus)])

        assert status == 2
        assert "Refusing to overwrite a corpus" in capsys.readouterr().err
        assert corpus.read_text(encoding="utf-8") == before
