"""Tests for the crawl filters and HTML extraction.

No network: the filters are pure and extraction takes a parsed document, so
everything here runs offline.
"""

from __future__ import annotations

import pytest
from bs4 import BeautifulSoup

from ardb import scraper

ORIGIN = "https://www.ardb.com.kh"


def soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


class TestShouldVisit:
    @pytest.mark.parametrize(
        "url",
        [
            f"{ORIGIN}/agricultural-loan/",
            f"{ORIGIN}/contact/",
            f"{ORIGIN}/anything-at-all/",
        ],
    )
    def test_follows_pages_on_the_origin(self, url):
        assert scraper.should_visit(url, ORIGIN)

    def test_refuses_to_leave_the_origin(self):
        # A crawler that wanders off-site would ingest third-party content as
        # though ARDB had published it.
        assert not scraper.should_visit("https://facebook.com/ardb", ORIGIN)
        assert not scraper.should_visit("https://evil.example/ardb.com.kh", ORIGIN)

    @pytest.mark.parametrize(
        "url",
        [
            f"{ORIGIN}/agricultural-news/20240722/20246/",
            f"{ORIGIN}/agricultural-news/commodity-prices/",
            f"{ORIGIN}/category/updates/",
            f"{ORIGIN}/tag/rice/",
            f"{ORIGIN}/wp-admin/",
            f"{ORIGIN}/wp-json/wp/v2/posts",
            f"{ORIGIN}/vacancy/",
            f"{ORIGIN}/feed",
        ],
    )
    def test_drops_the_news_firehose_and_machinery(self, url):
        # These dominate the site by volume and answer nothing a customer
        # asks, so letting them in crowds the useful pages out of the prompt.
        assert not scraper.should_visit(url, ORIGIN)

    @pytest.mark.parametrize("suffix", [".pdf", ".jpg", ".PNG", ".docx", ".css"])
    def test_drops_non_html_assets(self, suffix):
        assert not scraper.should_visit(f"{ORIGIN}/file{suffix}", ORIGIN)


class TestShouldKeep:
    def test_keeps_the_homepage_despite_matching_no_keyword(self):
        # It carries the contact details and product overview.
        assert scraper.should_keep(f"{ORIGIN}/", ORIGIN)
        assert scraper.should_keep(ORIGIN, ORIGIN)

    @pytest.mark.parametrize(
        "path",
        ["/agricultural-loan/", "/fixed-deposit/", "/faq/", "/branch/", "/profile/",
         "/mobile-banking/", "/service-tariff/"],
    )
    def test_keeps_pages_a_customer_asks_about(self, path):
        assert scraper.should_keep(f"{ORIGIN}{path}", ORIGIN)

    def test_discards_an_english_page_matching_nothing(self):
        # An English slug we can judge, so one matching no keyword is dropped.
        assert not scraper.should_keep(f"{ORIGIN}/board-of-directors-gallery/", ORIGIN)

    def test_keeps_khmer_slugged_pages(self):
        # Khmer is the primary language of ARDB's customers. A keyword filter
        # over English words would silently drop every Khmer-slugged page,
        # losing that half of the corpus entirely.
        assert scraper.should_keep(f"{ORIGIN}/កម្ចី/", ORIGIN)

    def test_keeps_percent_encoded_khmer_slugs(self):
        # The crawler sees whichever form the site links with.
        encoded = "/%E1%9E%80%E1%9E%98%E1%9F%92%E1%9E%85%E1%9E%B8/"
        assert scraper.should_keep(f"{ORIGIN}{encoded}", ORIGIN)

    def test_keyword_match_uses_the_decoded_path(self):
        assert scraper.should_keep(f"{ORIGIN}/loan%20products/", ORIGIN)


class TestExtractText:
    def test_strips_chrome_and_keeps_the_body(self):
        html = """
        <html><body>
          <nav>Home Loans Contact</nav>
          <header>ARDB</header>
          <main><p>Loans are available to farmers.</p>
                <p>Bring your national ID card.</p></main>
          <footer>Copyright 2026</footer>
          <script>tracker()</script>
        </body></html>
        """
        text = scraper.extract_text(soup(html))
        assert "Loans are available to farmers." in text
        assert "Bring your national ID card." in text
        for chrome in ("Home Loans Contact", "Copyright 2026", "tracker()"):
            assert chrome not in text

    def test_prefers_main_over_the_whole_body(self):
        html = """
        <html><body>
          <div class="sidebar">Latest news sidebar</div>
          <article>The real content.</article>
        </body></html>
        """
        text = scraper.extract_text(soup(html))
        assert "The real content." in text
        assert "sidebar" not in text.lower()

    def test_falls_back_to_body_without_a_content_container(self):
        text = scraper.extract_text(soup("<html><body><p>Bare page.</p></body></html>"))
        assert "Bare page." in text

    def test_keeps_list_items_on_separate_lines(self):
        # Joining them would turn document requirements into one run-on
        # sentence, which reads badly in a drafted answer.
        html = "<main><ul><li>National ID card</li><li>Land title</li></ul></main>"
        text = scraper.extract_text(soup(html))
        assert "National ID card" in text
        assert "Land title" in text
        assert "National ID cardLand title" not in text

    def test_normalizes_non_breaking_spaces(self):
        text = scraper.extract_text(soup("<main><p>Rate is fixed.</p></main>"))
        assert " " not in text

    def test_drops_blank_lines(self):
        html = "<main><p>One.</p><p></p><p>   </p><p>Two.</p></main>"
        text = scraper.extract_text(soup(html))
        assert text.splitlines() == ["One.", "Two."]

    def test_preserves_khmer(self):
        text = scraper.extract_text(soup("<main><p>កម្ចីកសិកម្ម</p></main>"))
        assert "កម្ចីកសិកម្ម" in text


class TestExtractTitle:
    def test_prefers_h1(self):
        html = "<html><head><title>Site — Page</title></head><body><h1>Agricultural Loan</h1></body></html>"
        assert scraper.extract_title(soup(html), f"{ORIGIN}/x/") == "Agricultural Loan"

    def test_falls_back_to_title_then_slug(self):
        assert scraper.extract_title(soup("<html><head><title>Fallback</title></head><body></body></html>"), f"{ORIGIN}/x/") == "Fallback"
        assert scraper.extract_title(soup("<html><body></body></html>"), f"{ORIGIN}/deposit/") == "deposit"

    def test_collapses_whitespace_and_bounds_length(self):
        title = scraper.extract_title(soup("<h1>  Spaced   out \n title  </h1>"), ORIGIN)
        assert title == "Spaced out title"
        long_title = scraper.extract_title(soup(f"<h1>{'x' * 500}</h1>"), ORIGIN)
        assert len(long_title) <= 200


class TestThinContentGuard:
    def test_threshold_is_set_where_stubs_fall_out(self):
        assert scraper.MIN_CONTENT_CHARS == 200


class TestTableExtraction:
    def test_keeps_each_row_on_one_line(self):
        # ARDB's deposit page is a rate table. Flattened cell-per-line, the
        # term and the two currency rates become indistinguishable and the
        # pairing survives only as position.
        html = """
        <main><table>
          <tr><th>រយៈពេល</th><th>ដុល្លារ</th><th>រៀល</th></tr>
          <tr><td>១ខែ</td><td>១,៥០%</td><td>១,៥០%</td></tr>
          <tr><td>១២ខែ</td><td>៤,០០%</td><td>៤,០០%</td></tr>
        </table></main>
        """
        text = scraper.extract_text(soup(html))
        assert "១ខែ | ១,៥០% | ១,៥០%" in text
        assert "១២ខែ | ៤,០០% | ៤,០០%" in text

    def test_keeps_the_header_row(self):
        html = "<main><table><tr><th>Term</th><th>Rate</th></tr><tr><td>1m</td><td>1.5%</td></tr></table></main>"
        text = scraper.extract_text(soup(html))
        assert "Term | Rate" in text

    def test_drops_empty_cells_rather_than_emitting_bare_separators(self):
        html = "<main><table><tr><td>1m</td><td></td><td>1.5%</td></tr></table></main>"
        text = scraper.extract_text(soup(html))
        assert "1m | 1.5%" in text
        assert "|  |" not in text

    def test_skips_a_row_with_no_cells(self):
        html = "<main><table><tr></tr><tr><td>1m</td></tr></table></main>"
        text = scraper.extract_text(soup(html))
        assert "1m" in text

    def test_leaves_prose_around_the_table_intact(self):
        html = "<main><p>Before.</p><table><tr><td>a</td><td>b</td></tr></table><p>After.</p></main>"
        text = scraper.extract_text(soup(html))
        lines = text.splitlines()
        assert lines.index("Before.") < lines.index("a | b") < lines.index("After.")

    def test_handles_a_page_with_no_table(self):
        text = scraper.extract_text(soup("<main><p>No tables here.</p></main>"))
        assert text == "No tables here."
