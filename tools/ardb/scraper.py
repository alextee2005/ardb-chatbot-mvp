"""Crawl ARDB's public site into knowledge entries.

A breadth-first walk from the homepage, restricted to the origin, keeping the
pages a customer would ask about and dropping the news firehose. It is a
heuristic over a WordPress theme, so its output is reviewed in a pull request
rather than committed straight to the branch.
"""

from __future__ import annotations

import logging
import re
import time
from collections import deque
from dataclasses import dataclass, field
from urllib.parse import unquote, urljoin, urlparse, urldefrag
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .knowledge import KnowledgeEntry, categorize, classify_language, slugify

log = logging.getLogger(__name__)

DEFAULT_ORIGIN = "https://www.ardb.com.kh"

USER_AGENT = (
    "ardb-chatbot-knowledge-scraper/1.0 "
    "(+https://github.com/alextee2005/ardb-chatbot-mvp)"
)

#: Paths worth keeping -- what a customer actually asks about.
KEEP_PATTERNS = (
    "loan", "credit", "deposit", "saving", "product", "service",
    "faq", "question", "interest", "rate", "fee", "tariff",
    "branch", "location", "contact", "profile", "about",
    "digital", "mobile", "banking", "apply", "requirement",
)

#: Paths to drop. The news and commodity-price archives dominate this site by
#: volume and answer nothing a customer asks, so including them would crowd
#: the useful pages out of the context window.
DROP_PATTERNS = (
    "agricultural-news", "commodity-pric", "/news", "/category/",
    "/tag/", "/author/", "announcement", "tender", "procurement",
    "vacancy", "career", "recruit", "/feed", "?attachment",
    "?replytocom", "wp-admin", "wp-login", "wp-content", "wp-json",
)

#: Extensions that are not HTML. Fetching them wastes a request and the
#: content-type check would discard them anyway.
DROP_SUFFIXES = (
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
    ".zip", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".mp4", ".mp3", ".css", ".js",
)

#: Chrome to strip before reading the body.
_STRIP_SELECTORS = (
    "script", "style", "noscript", "nav", "header", "footer",
    "form", "iframe", "svg", ".menu", ".widget", ".sidebar",
    "#comments", ".comments", ".breadcrumb", ".pagination",
    ".social", ".share",
)

#: Where the readable body usually lives, most specific first.
_CONTENT_SELECTORS = (
    "main", "article", ".entry-content", ".post-content",
    ".page-content", ".content", "#content",
)

#: Below this a page is a stub, a redirect shim or a gallery -- noise in the
#: prompt with no answer in it.
MIN_CONTENT_CHARS = 200

#: A Latin word of three or more letters. Its absence from a path means the
#: slug is not English and cannot be judged by the KEEP keywords.
_LATIN_WORD_RE = re.compile(r"[a-z]{3,}")


@dataclass(slots=True)
class ScrapeReport:
    """What a run did, for the pull-request body and the logs."""

    visited: int = 0
    kept: int = 0
    skipped_thin: list[str] = field(default_factory=list)
    skipped_robots: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _session() -> requests.Session:
    """A session that retries transient failures rather than losing a page."""
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    retry = Retry(
        total=3,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def _normalize(url: str) -> str:
    """Drop the fragment and any trailing slash, so one page is one key."""
    without_fragment, _ = urldefrag(url)
    return without_fragment.rstrip("/") or without_fragment


def should_visit(url: str, origin: str) -> bool:
    if not url.startswith(origin):
        return False
    lowered = url.lower()
    if any(lowered.endswith(suffix) for suffix in DROP_SUFFIXES):
        return False
    return not any(pattern in lowered for pattern in DROP_PATTERNS)


def should_keep(url: str, origin: str) -> bool:
    """Whether a visited page becomes an entry.

    Three rules, in order:

    1. The homepage always -- it carries the contact details and the product
       overview, and matches none of the keyword patterns.
    2. Any path matching a KEEP pattern.
    3. Any path with no Latin word in it. This is the Khmer case, and it is
       not an edge case on a Cambodian bank's site: a page at ``/កម្ចី/``
       (loan) matches no English keyword, so keyword filtering alone would
       silently drop every Khmer-slugged page -- and Khmer is the primary
       language of ARDB's customers. We cannot judge such a slug by keyword,
       so we admit it and let the reviewer decide. An English slug we *can*
       judge, so one matching nothing is still dropped.
    """
    if _normalize(url) == _normalize(origin):
        return True

    # Decoded, so a percent-encoded Khmer slug is Khmer rather than hex.
    path = unquote(urlparse(url).path).lower()

    if any(pattern in path for pattern in KEEP_PATTERNS):
        return True

    return _LATIN_WORD_RE.search(path) is None


def extract_text(soup: BeautifulSoup) -> str:
    """Strip the chrome and return the readable body as plain text."""
    for selector in _STRIP_SELECTORS:
        for element in soup.select(selector):
            element.decompose()

    root = None
    for selector in _CONTENT_SELECTORS:
        found = soup.select_one(selector)
        if found is not None:
            root = found
            break
    if root is None:
        root = soup.body or soup

    lines = [line.strip() for line in root.get_text("\n").splitlines()]
    kept = [line for line in lines if line]

    # Collapse the runs of repeated whitespace a theme leaves behind, without
    # joining distinct list items into one sentence.
    return "\n".join(kept).replace(" ", " ")


def extract_title(soup: BeautifulSoup, url: str) -> str:
    for selector in ("h1", "title"):
        found = soup.select_one(selector)
        if found and found.get_text(strip=True):
            return " ".join(found.get_text(strip=True).split())[:200]
    return slugify(url)


def _robots(session: requests.Session, origin: str) -> RobotFileParser | None:
    """Fetch robots.txt, treating an unreadable one as no restriction."""
    parser = RobotFileParser()
    robots_url = urljoin(origin + "/", "robots.txt")
    try:
        response = session.get(robots_url, timeout=15)
        if response.status_code >= 400:
            log.info("no usable robots.txt (HTTP %s); proceeding", response.status_code)
            return None
        parser.parse(response.text.splitlines())
        return parser
    except requests.RequestException as error:
        log.info("could not fetch robots.txt (%s); proceeding", error)
        return None


def crawl(
    origin: str = DEFAULT_ORIGIN,
    *,
    max_pages: int = 60,
    delay_seconds: float = 0.5,
    respect_robots: bool = True,
    timeout: int = 20,
) -> tuple[list[KnowledgeEntry], ScrapeReport]:
    """Walk the site and return the entries worth keeping.

    ``delay_seconds`` is politeness, not rate-limit avoidance: this is a small
    bank's site and a burst of 60 requests is rude even when permitted.
    """
    session = _session()
    robots = _robots(session, origin) if respect_robots else None

    report = ScrapeReport()
    entries: list[KnowledgeEntry] = []
    seen: set[str] = set()
    queue: deque[str] = deque([origin + "/"])

    while queue and report.visited < max_pages:
        url = _normalize(queue.popleft())
        if url in seen:
            continue
        seen.add(url)

        if robots is not None and not robots.can_fetch(USER_AGENT, url):
            report.skipped_robots.append(url)
            continue

        try:
            response = session.get(url, timeout=timeout)
        except requests.RequestException as error:
            report.errors.append(f"{url}: {error}")
            continue

        report.visited += 1

        if response.status_code >= 400:
            report.errors.append(f"{url}: HTTP {response.status_code}")
            continue
        if "text/html" not in response.headers.get("content-type", ""):
            continue

        soup = BeautifulSoup(response.text, "lxml")

        # Enqueue before deciding whether to keep this page: a hub page we
        # discard may still be the only route to the product pages we want.
        for anchor in soup.find_all("a", href=True):
            try:
                target = _normalize(urljoin(url, anchor["href"]))
            except ValueError:
                continue
            if target not in seen and should_visit(target, origin):
                queue.append(target)

        if not should_keep(url, origin):
            continue

        content = extract_text(soup)
        if len(content) < MIN_CONTENT_CHARS:
            report.skipped_thin.append(f"{url} ({len(content)} chars)")
            continue

        entries.append(
            KnowledgeEntry(
                id=slugify(url),
                title=extract_title(soup, url),
                url=url,
                language=classify_language(content),
                category=categorize(url),
                content=content,
            )
        )
        report.kept += 1
        log.info("keep %s (%s chars)", url, len(content))

        if delay_seconds > 0:
            time.sleep(delay_seconds)

    if queue:
        log.warning(
            "stopped at max_pages=%s with %s URLs still queued; raise it to go deeper",
            max_pages,
            len(queue),
        )

    return entries, report
