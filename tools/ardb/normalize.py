"""Deterministic number normalization for ARDB source text.

This runs **before** any model sees the text, and it is the reason the
consolidation pipeline is safe enough to use at a bank. ARDB publishes figures
in Khmer numerals with a comma for the decimal point and a full stop for
thousands:

    ១,៥០%      ->  1.50%
    ១០០.០០០    ->  100,000
    ៥.០០០.០០០  ->  5,000,000

Read under English conventions, a 4.00% deposit rate becomes 400%. Leaving
that interpretation to a language model means a wrong rate can come back
looking like a perfectly ordinary number, which is the one error a reviewer
skims past. So the conversion is done here, mechanically, where it is exact
and testable -- the model is handed figures that are already correct and is
told not to touch them.

Only digits and separators inside a numeric token are rewritten. Commas and
full stops in prose are left exactly as they are.
"""

from __future__ import annotations

import re

#: U+17E0..U+17E9. Also handles the Khmer "lek attak" variants U+17F0..U+17F9,
#: which appear occasionally in older typesetting.
_KHMER_DIGITS = str.maketrans(
    "០១២៣៤៥៦៧៨៩៰៱៲៳៴៵៶៷៸៹",
    "01234567890123456789",
)

#: A run of ASCII digits with optional , and . separators between digit groups.
_NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)+")


def khmer_digits_to_arabic(text: str) -> str:
    """Map Khmer numerals onto ASCII digits, leaving everything else alone."""
    return text.translate(_KHMER_DIGITS)


def _convert_separators(token: str) -> str:
    """Rewrite one numeric token from ARDB's convention into English notation.

    ARDB's convention: comma is the decimal point, full stop groups thousands.

    When a comma is present it is unambiguous -- everything after the last
    comma is the fraction. Without one, full stops are read as thousands
    separators only when every group after the first is exactly three digits;
    otherwise the token is left untouched, which is what keeps a date like
    ``27.08.2019`` from being mangled into a number.
    """
    if "," in token:
        head, _, fraction = token.rpartition(",")
        digits = head.replace(".", "")
        if not digits.isdigit():
            return token
        grouped = f"{int(digits):,}"
        return f"{grouped}.{fraction}" if fraction else grouped

    parts = token.split(".")
    if len(parts) > 1 and all(len(part) == 3 for part in parts[1:]):
        joined = "".join(parts)
        if joined.isdigit():
            return f"{int(joined):,}"

    return token


def normalize_numbers(text: str) -> str:
    """Convert Khmer numerals and ARDB's separator convention to English.

    Applied to a whole document. Prose punctuation is untouched -- only
    substrings that are entirely digits and separators are rewritten.
    """
    converted = khmer_digits_to_arabic(text)
    return _NUMBER_RE.sub(lambda match: _convert_separators(match.group(0)), converted)


def extract_numbers(text: str, *, convention: str = "english") -> list[str]:
    """Every number in the text, canonicalized for comparison.

    ``convention`` says how to read the separators, and getting it wrong is
    not cosmetic: ARDB source text and an English translation use **opposite**
    conventions, so reading "100,000" from a translation under ARDB's rules
    yields 100.0 and a comparison against the source's 100000 fails for no
    reason -- or, worse, a genuine discrepancy cancels out and passes.

    - ``"ardb"``: Khmer numerals, comma as decimal, full stop for thousands.
    - ``"english"``: ASCII digits, full stop as decimal, comma for thousands.

    Order is preserved, but comparison is done as a multiset because a
    translation legitimately reorders a sentence.
    """
    if convention not in ("ardb", "english"):
        raise ValueError(f"unknown convention: {convention!r}")

    # Normalizing ARDB text leaves it in English notation, so one parser does
    # for both once the conversion has happened.
    prepared = normalize_numbers(text) if convention == "ardb" else text

    found: list[str] = []
    for match in re.finditer(r"\d[\d.,]*", prepared):
        token = match.group(0).rstrip(".,")
        if "." in token:
            whole, _, fraction = token.rpartition(".")
            canonical = f"{whole.replace(',', '')}.{fraction}"
        else:
            canonical = token.replace(",", "")
        found.append(canonical)
    return found


def numbers_match(source: str, translation: str) -> tuple[bool, list[str], list[str]]:
    """Compare the figures in ARDB source text against an English translation.

    Returns ``(ok, missing, invented)``. ``missing`` is figures the source
    states and the translation never mentions; ``invented`` is figures the
    translation states that the source does not.

    Compared as **sets, not multisets**. A rate table lists each figure once
    per currency column -- ARDB's deposit page gives 1.50% for dollars and
    1.50% for riel -- and the faithful English restatement is "1.50% in both
    US dollars and riel", which says it once. Counting occurrences would fail
    that, and failing good translations trains people to ignore the check,
    which costs more than the rare case it would catch.

    Trailing fractional zeros compare equal (4 == 4.00), because rendering
    "៤,០០%" as "4%" is faithful rather than a lost figure.
    """

    def canonical(value: str) -> str:
        try:
            return f"{float(value):.4f}".rstrip("0").rstrip(".")
        except ValueError:
            return value

    source_values = {canonical(n) for n in extract_numbers(source, convention="ardb")}
    translation_values = {
        canonical(n) for n in extract_numbers(translation, convention="english")
    }

    missing = sorted(source_values - translation_values)
    invented = sorted(translation_values - source_values)
    return (not missing and not invented, missing, invented)
