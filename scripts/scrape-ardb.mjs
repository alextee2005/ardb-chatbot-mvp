#!/usr/bin/env node
/**
 * Scrape ARDB's public product, service, FAQ and contact pages into
 * knowledge/ardb-knowledge.json.
 *
 * Run with `npm run scrape`. Review the diff before committing -- this is a
 * heuristic over a WordPress theme, and it will occasionally keep a navigation
 * blob or miss a page.
 *
 * Entries are written sorted by id. That is load-bearing: the rendered corpus
 * must be byte-identical between requests or the prompt cache misses on every
 * question.
 *
 * Usage:
 *   node scripts/scrape-ardb.mjs                 # crawl and rewrite the file
 *   node scripts/scrape-ardb.mjs --dry-run       # print what it would keep
 *   node scripts/scrape-ardb.mjs --max-pages 40
 */

import { writeFile, readFile } from "node:fs/promises";
import { argv } from "node:process";

import * as cheerio from "cheerio";

const ORIGIN = "https://www.ardb.com.kh";
const OUTPUT = new URL("../knowledge/ardb-knowledge.json", import.meta.url);

/** Paths worth keeping: what a customer would ask about. */
const KEEP = [
  /loan/i, /credit/i, /deposit/i, /saving/i, /product/i, /service/i,
  /faq/i, /question/i, /interest/i, /rate/i, /fee/i, /tariff/i,
  /branch/i, /location/i, /contact/i, /profile/i, /about/i,
  /digital/i, /mobile/i, /banking/i, /apply/i, /requirement/i,
];

/** Paths to drop: high-volume, time-sensitive, and useless for answering. */
const DROP = [
  /agricultural-news/i, /commodity-pric/i, /\/news/i, /\/category\//i,
  /\/tag\//i, /\/author\//i, /\/20\d\d\//i, /announcement/i, /tender/i,
  /procurement/i, /vacancy/i, /career/i, /recruit/i, /\/feed/i,
  /wp-(admin|login|content|json)/i, /\?attachment/i, /\?replytocom/i,
  /\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/i,
];

const args = argv.slice(2);
const dryRun = args.includes("--dry-run");
const maxPages = Number(
  args.includes("--max-pages") ? args[args.indexOf("--max-pages") + 1] : 60,
);

const seen = new Set();
const kept = [];

function shouldVisit(url) {
  if (!url.startsWith(ORIGIN)) return false;
  if (DROP.some((re) => re.test(url))) return false;
  return true;
}

function shouldKeep(url) {
  if (url === `${ORIGIN}/` || url === ORIGIN) return true;
  return KEEP.some((re) => re.test(url));
}

function slugify(url) {
  const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
  const slug = (path || "home").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return slug.replace(/^-|-$/g, "").slice(0, 60) || "home";
}

/** Khmer block U+1780-U+17FF -- same test the Worker uses. */
function classifyLanguage(text) {
  const khmer = (text.match(/[ក-៿]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length;
  const total = khmer + latin;
  if (total === 0) return "en";
  const share = khmer / total;
  if (share >= 0.75) return "km";
  if (share <= 0.25) return "en";
  return "mixed";
}

function categorize(url) {
  if (/loan|credit|apply|requirement/i.test(url)) return "loan-products";
  if (/deposit|saving/i.test(url)) return "deposit-products";
  if (/interest|rate|fee|tariff/i.test(url)) return "rates-and-fees";
  if (/digital|mobile|banking/i.test(url)) return "digital-banking";
  if (/branch|location|contact/i.test(url)) return "branches-and-contact";
  if (/faq|question/i.test(url)) return "faq";
  if (/profile|about/i.test(url)) return "about";
  return "general";
}

/**
 * Strip the chrome and keep the readable body.
 *
 * The selector list is a best guess at a standard WordPress theme; widen it if
 * entries come back thin.
 */
function extract($) {
  $("script, style, noscript, nav, header, footer, form, iframe, .menu, .widget, .sidebar, #comments").remove();

  const main = $("main, article, .entry-content, .post-content, .content, #content")
    .first();
  const root = main.length > 0 ? main : $("body");

  const text = root
    .text()
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return text;
}

async function crawl(startUrl) {
  const queue = [startUrl];

  while (queue.length > 0 && seen.size < maxPages) {
    const url = queue.shift();
    const normalized = url.split("#")[0].replace(/\/$/, "") || ORIGIN;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    let html;
    try {
      const response = await fetch(normalized, {
        headers: { "user-agent": "ardb-chatbot-knowledge-scraper/0.1" },
        redirect: "follow",
      });
      if (!response.ok) {
        console.warn(`  skip ${normalized} -> HTTP ${response.status}`);
        continue;
      }
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("text/html")) continue;
      html = await response.text();
    } catch (error) {
      console.warn(`  skip ${normalized} -> ${error.message}`);
      continue;
    }

    const $ = cheerio.load(html);

    for (const element of $("a[href]").toArray()) {
      const href = $(element).attr("href");
      if (!href) continue;
      let resolved;
      try {
        resolved = new URL(href, normalized).toString();
      } catch {
        continue;
      }
      if (shouldVisit(resolved) && !seen.has(resolved.replace(/\/$/, ""))) {
        queue.push(resolved);
      }
    }

    if (!shouldKeep(normalized)) continue;

    const content = extract($);
    // Below ~200 characters it is almost always a stub or a redirect page --
    // noise in the prompt with no answer in it.
    if (content.length < 200) {
      console.warn(`  thin ${normalized} (${content.length} chars) -- skipped`);
      continue;
    }

    const title = ($("h1").first().text() || $("title").text() || slugify(normalized))
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 200);

    kept.push({
      id: slugify(normalized),
      title,
      url: normalized,
      language: classifyLanguage(content),
      category: categorize(normalized),
      content,
    });

    console.log(`  keep ${normalized} (${content.length} chars)`);
  }
}

/** Hand-written entries have url "manual" and must survive a re-scrape. */
async function readManualEntries() {
  try {
    const existing = JSON.parse(await readFile(OUTPUT, "utf8"));
    return (existing.entries ?? []).filter((entry) => entry.url === "manual");
  } catch {
    return [];
  }
}

console.log(`Crawling ${ORIGIN} (max ${maxPages} pages)…`);
await crawl(`${ORIGIN}/`);

const manual = await readManualEntries();
if (manual.length > 0) {
  console.log(`Preserving ${manual.length} manual entr${manual.length === 1 ? "y" : "ies"}.`);
}

const entries = [...kept, ...manual].sort((a, b) => a.id.localeCompare(b.id));

// De-duplicate by id, last writer wins, so a manual entry can deliberately
// override a scraped page of the same name.
const byId = new Map(entries.map((entry) => [entry.id, entry]));
const final = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

const knowledge = {
  version: `${new Date().toISOString().slice(0, 10)}-${final.length}`,
  generatedAt: new Date().toISOString(),
  source: ORIGIN,
  entries: final,
};

const totalChars = final.reduce((sum, entry) => sum + entry.content.length, 0);
console.log(
  `\n${final.length} entries, ~${Math.round(totalChars / 1000)}k characters (~${Math.round(totalChars / 3500)}k tokens).`,
);

if (dryRun) {
  console.log("Dry run -- nothing written.");
} else {
  await writeFile(OUTPUT, `${JSON.stringify(knowledge, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT.pathname} at version ${knowledge.version}.`);
  console.log("Review the diff before committing.");
}
