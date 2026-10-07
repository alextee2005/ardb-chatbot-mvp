"""End-to-end crawl against a local fixture site.

The real target (ardb.com.kh) is not reachable from CI on every run and must
never be hit by the test suite. These fixtures stand in for its shape: a
WordPress-ish theme, a product page, a Khmer page, a news archive that must be
ignored, a thin stub, and an off-site link.
"""

from __future__ import annotations

import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from ardb.scraper import crawl

LOREM = "Loans are available to farmers and agricultural cooperatives. " * 10

PAGES: dict[str, str] = {
    "/": f"""<html><head><title>ARDB</title></head><body>
        <nav><a href="/agricultural-loan/">Loans</a>
             <a href="/fixed-deposit/">Deposits</a>
             <a href="/faq/">FAQ</a>
             <a href="/agricultural-news/20240722/">News</a>
             <a href="/loan-stub/">Stub</a>
             <a href="/%E1%9E%80%E1%9E%98%E1%9F%92%E1%9E%85%E1%9E%B8/">Khmer</a>
             <a href="https://facebook.com/ardb">Facebook</a>
             <a href="/brochure.pdf">Brochure</a></nav>
        <main><h1>Agricultural and Rural Development Bank</h1>
              <p>{LOREM}</p>
              <p>Call 023 123 456.</p></main>
        <footer>Copyright 2026 ARDB</footer></body></html>""",

    "/agricultural-loan/": f"""<html><body>
        <nav>menu menu menu</nav>
        <article><h1>Agricultural Loan</h1>
          <p>{LOREM}</p>
          <ul><li>National ID card</li><li>Land title</li></ul></article>
        <script>analytics()</script></body></html>""",

    "/fixed-deposit/": f"""<html><body><main>
        <h1>Fixed Deposit</h1><p>{LOREM}</p></main></body></html>""",

    "/faq/": f"""<html><body><div class="entry-content">
        <h1>Frequently Asked Questions</h1><p>{LOREM}</p></div></body></html>""",

    # Must be ignored: the news archive dominates the real site by volume.
    "/agricultural-news/20240722/": f"""<html><body><main>
        <h1>Rice prices this week</h1><p>{LOREM}</p></main></body></html>""",

    # Matches a KEEP pattern but is too thin to be worth a prompt slot.
    "/loan-stub/": "<html><body><main><p>Coming soon.</p></main></body></html>",

    # A Khmer URL slug, which percent-encodes to hex and has no ASCII
    # alphanumerics in its path.
    "/កម្ចី/": f"""<html><body><main>
        <h1>កម្ចីកសិកម្ម</h1><p>នេះគឺជាកម្ចីសម្រាប់កសិករ។ {"ព័ត៌មានបន្ថែម។ " * 40}</p>
        </main></body></html>""",

    "/robots.txt": "User-agent: *\nDisallow: /wp-admin/\n",
}


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - name fixed by the stdlib
        from urllib.parse import unquote

        path = unquote(self.path)
        body = PAGES.get(path) or PAGES.get(path.rstrip("/") + "/")

        if body is None:
            self.send_response(404)
            self.end_headers()
            return

        payload = body.encode("utf-8")
        self.send_response(200)
        content_type = (
            "text/plain; charset=utf-8"
            if path.endswith(".txt")
            else "text/html; charset=utf-8"
        )
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        pass  # Keep pytest output readable.


@pytest.fixture(scope="module")
def site() -> str:
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(_Handler))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(scope="module")
def crawled(site: str):
    return crawl(site, max_pages=30, delay_seconds=0, respect_robots=True)


def test_keeps_the_product_and_faq_pages(crawled):
    entries, _ = crawled
    ids = {entry.id for entry in entries}
    assert "agricultural-loan" in ids
    assert "fixed-deposit" in ids
    assert "faq" in ids
    assert "home" in ids


def test_ignores_the_news_archive(crawled):
    entries, _ = crawled
    assert not any("news" in entry.id for entry in entries)


def test_skips_the_thin_stub(crawled):
    entries, report = crawled
    assert not any(entry.id == "loan-stub" for entry in entries)
    assert any("loan-stub" in skipped for skipped in report.skipped_thin)


def test_khmer_page_gets_a_unique_non_colliding_id(crawled):
    entries, _ = crawled
    khmer = [entry for entry in entries if entry.language == "km"]
    assert len(khmer) == 1
    assert khmer[0].id != "home"
    assert khmer[0].id.startswith("page-")


def test_strips_chrome_from_kept_pages(crawled):
    entries, _ = crawled
    loan = next(entry for entry in entries if entry.id == "agricultural-loan")
    assert "Loans are available to farmers" in loan.content
    assert "menu menu menu" not in loan.content
    assert "analytics()" not in loan.content
    # Document requirements must stay on separate lines to read well in a draft.
    assert "National ID card" in loan.content
    assert "National ID cardLand title" not in loan.content


def test_assigns_titles_and_categories(crawled):
    entries, _ = crawled
    loan = next(entry for entry in entries if entry.id == "agricultural-loan")
    assert loan.title == "Agricultural Loan"
    assert loan.category == "loan-products"

    deposit = next(entry for entry in entries if entry.id == "fixed-deposit")
    assert deposit.category == "deposit-products"


def test_never_leaves_the_origin(crawled):
    entries, _ = crawled
    assert all(entry.url.startswith("http://127.0.0.1") for entry in entries)


def test_report_counts_what_happened(crawled):
    _, report = crawled
    assert report.visited >= 4
    assert report.kept >= 4
    assert report.errors == []


def test_output_is_sorted_and_unique_after_merge(crawled):
    from ardb.knowledge import merge_entries

    entries, _ = crawled
    merged = merge_entries(entries, [])
    ids = [entry.id for entry in merged]
    assert ids == sorted(ids)
    assert len(ids) == len(set(ids))


def test_robots_disallow_is_honoured(site: str):
    PAGES["/robots.txt"] = "User-agent: *\nDisallow: /\n"
    try:
        entries, report = crawl(site, max_pages=10, delay_seconds=0, respect_robots=True)
        assert entries == []
        assert report.skipped_robots
    finally:
        PAGES["/robots.txt"] = "User-agent: *\nDisallow: /wp-admin/\n"


def test_ignore_robots_overrides_a_blanket_disallow(site: str):
    # ARDB's own site, crawled deliberately.
    PAGES["/robots.txt"] = "User-agent: *\nDisallow: /\n"
    try:
        entries, _ = crawl(site, max_pages=10, delay_seconds=0, respect_robots=False)
        assert entries
    finally:
        PAGES["/robots.txt"] = "User-agent: *\nDisallow: /wp-admin/\n"
