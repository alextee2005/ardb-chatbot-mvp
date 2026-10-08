"""Tests for number normalization.

This is the safety-critical piece: it is what stops a 4.00% deposit rate
being published as 400%. Cases are taken from the real scraped corpus.
"""

from __future__ import annotations

import pytest

from ardb.normalize import (
    extract_numbers,
    khmer_digits_to_arabic,
    normalize_numbers,
    numbers_match,
)


class TestKhmerDigits:
    def test_maps_every_digit(self):
        assert khmer_digits_to_arabic("០១២៣៤៥៦៧៨៩") == "0123456789"

    def test_leaves_khmer_letters_alone(self):
        assert khmer_digits_to_arabic("ខែ") == "ខែ"

    def test_leaves_ascii_alone(self):
        assert khmer_digits_to_arabic("12 months") == "12 months"


class TestSeparatorConvention:
    @pytest.mark.parametrize(
        "source,expected",
        [
            # Real deposit rates. Misreading the comma turns 1.50% into 150%.
            ("១,៥០%", "1.50%"),
            ("២,០០%", "2.00%"),
            ("២,៧៥%", "2.75%"),
            ("៤,០០%", "4.00%"),
            ("០,៥០%", "0.50%"),
            ("០,៧៥%", "0.75%"),
            # Real loan ceilings. The dot groups thousands.
            ("១០០.០០០", "100,000"),
            ("២០.០០០", "20,000"),
            ("៥.០០០", "5,000"),
            ("១.០០០.០០០", "1,000,000"),
            ("៥.០០០.០០០", "5,000,000"),
        ],
    )
    def test_converts_real_corpus_figures(self, source, expected):
        assert normalize_numbers(source) == expected

    def test_a_four_percent_rate_never_becomes_four_hundred(self):
        # The failure this module exists to prevent.
        assert "400" not in normalize_numbers("៤,០០%")
        assert normalize_numbers("៤,០០%") == "4.00%"

    def test_plain_integers_pass_through(self):
        assert normalize_numbers("២៤ខែ") == "24ខែ"
        assert normalize_numbers("ឆ្នាំ១៩៩៨") == "ឆ្នាំ1998"
        assert normalize_numbers("អនុក្រឹត្យលេខ ១២៤") == "អនុក្រឹត្យលេខ 124"

    def test_mixed_notation_resolves_comma_as_decimal(self):
        assert normalize_numbers("១.០០០,៥០") == "1,000.50"

    @pytest.mark.parametrize(
        "source,expected",
        [
            # The savings account minimum, written with a comma grouping
            # thousands. Reading the comma as a decimal point made this 40
            # riel instead of 40,000 -- a 1000x error on a real published
            # figure, in the function written to prevent exactly that.
            ("៤០,០០០", "40,000"),
            ("៥,០០០", "5,000"),
            ("១,០០០,០០០", "1,000,000"),
        ],
    )
    def test_a_comma_can_also_group_thousands(self, source, expected):
        assert normalize_numbers(source) == expected

    def test_the_group_size_decides_what_a_comma_means(self):
        # ARDB uses the comma both ways, so the separator alone cannot say.
        # A one or two digit group is a fraction; three digits is thousands.
        assert normalize_numbers("៤,០០%") == "4.00%"      # two digits -> decimal
        assert normalize_numbers("៤,០០០") == "4,000"      # three digits -> thousands

    def test_an_unreadable_grouping_is_left_alone(self):
        # Neither a 1-2 digit fraction nor 3-digit blocks: do not guess.
        assert normalize_numbers("១២,៣៤៥៦") == "12,3456"


class TestProseIsUntouched:
    def test_sentence_punctuation_survives(self):
        source = "Loans are available, subject to assessment. Terms apply."
        assert normalize_numbers(source) == source

    def test_a_comma_between_words_is_not_a_decimal_point(self):
        assert normalize_numbers("rice, maize and cassava") == "rice, maize and cassava"

    def test_khmer_prose_with_an_embedded_rate(self):
        out = normalize_numbers("អត្រាការប្រាក់ ១,៥០% ក្នុងមួយឆ្នាំ។")
        assert "1.50%" in out
        assert "ក្នុងមួយឆ្នាំ។" in out


class TestDatesAreNotMangled:
    def test_a_dotted_date_is_left_alone(self):
        # Groups are not all three digits, so these are not thousands.
        assert normalize_numbers("២៧.០៨.២០១៩") == "27.08.2019"

    def test_a_two_part_date_is_left_alone(self):
        assert normalize_numbers("២០១៩.០៨") == "2019.08"


class TestExtractNumbers:
    def test_reads_ardb_notation_when_told_to(self):
        assert extract_numbers("១,៥០% and ១០០.០០០", convention="ardb") == [
            "1.50",
            "100000",
        ]

    def test_reads_english_notation_when_told_to(self):
        # The same digits mean different things under the two conventions.
        # Reading an English "100,000" as ARDB would yield 100.0.
        assert extract_numbers("100,000", convention="english") == ["100000"]
        assert extract_numbers("1.50%", convention="english") == ["1.50"]

    def test_english_is_the_default(self):
        assert extract_numbers("100,000") == ["100000"]

    def test_rejects_an_unknown_convention(self):
        with pytest.raises(ValueError, match="convention"):
            extract_numbers("1", convention="khmer")

    def test_ignores_trailing_punctuation(self):
        assert extract_numbers("the rate is 4.00.") == ["4.00"]

    def test_empty_text(self):
        assert extract_numbers("") == []


class TestNumbersMatch:
    def test_faithful_translation_passes(self):
        source = "អត្រា ១,៥០% សម្រាប់ ១២ខែ"
        translation = "The rate is 1.50% for a 12-month term."
        ok, missing, invented = numbers_match(source, translation)
        assert ok, (missing, invented)

    def test_trailing_zeros_are_equivalent(self):
        # Rendering ៤,០០% as "4%" is faithful, not a lost figure.
        ok, _, _ = numbers_match("៤,០០%", "4%")
        assert ok

    def test_a_dropped_rate_is_caught(self):
        ok, missing, _ = numbers_match("១,៥០% និង ២,៧៥%", "The rate is 1.50%.")
        assert not ok
        assert "2.75" in missing

    def test_an_invented_rate_is_caught(self):
        # The failure mode that matters: a figure the model produced from
        # nowhere reads exactly like a real one.
        ok, _, invented = numbers_match("អត្រាប្រកួតប្រជែង", "The rate is 3.25%.")
        assert not ok
        assert "3.25" in invented

    def test_a_misread_separator_is_caught(self):
        # If something downstream turned 4.00% into 400%, this catches it.
        ok, _, invented = numbers_match("៤,០០%", "The rate is 400%.")
        assert not ok
        assert "400" in invented

    def test_reordering_is_allowed(self):
        source = "១,៥០% then ២,៧៥%"
        translation = "2.75% in the second case, 1.50% in the first."
        ok, _, _ = numbers_match(source, translation)
        assert ok

    def test_a_loan_ceiling_survives_the_notation_flip(self):
        # The case that exposed the convention bug: ១០០.០០០ is 100,000, and
        # the English translation writes it with the separators the other way
        # round. These must compare equal.
        ok, missing, invented = numbers_match(
            "ទឹកប្រាក់កម្ចីរហូតដល់ ១០០.០០០ ដុល្លារ",
            "Loans of up to 100,000 US dollars.",
        )
        assert ok, (missing, invented)

    def test_a_figure_repeated_per_currency_may_be_stated_once(self):
        # ARDB's deposit table gives each rate twice, for dollars and riel.
        # The faithful English restatement says it once -- "1.50% in both US
        # dollars and riel" -- so counting occurrences would fail a correct
        # translation. Failing good output trains people to ignore the check.
        ok, missing, invented = numbers_match(
            "ដុល្លារ ១,៥០% | រៀល ១,៥០%",
            "The rate is 1.50% in both US dollars and riel.",
        )
        assert ok, (missing, invented)

    def test_a_distinct_dropped_rate_is_still_caught(self):
        # Set semantics costs nothing here: the values differ.
        ok, missing, _ = numbers_match("១,៥០% និង ២,៧៥%", "The rate is 1.50%.")
        assert not ok
        assert "2.75" in missing
