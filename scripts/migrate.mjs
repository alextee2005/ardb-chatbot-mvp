#!/usr/bin/env node
/**
 * Apply migrations/*.sql to the Neon database in DATABASE_URL.
 *
 * Every statement is idempotent, so re-running is safe and is the way to
 * repair a database that is partly migrated.
 *
 * Use the DIRECT connection string, not the -pooler one: migrations take DDL
 * locks, and a pooled connection can hand successive statements to different
 * sessions.
 */

import { readdir, readFile } from "node:fs/promises";
import { env, exit } from "node:process";

import { neon } from "@neondatabase/serverless";

import { splitStatements } from "./sql-statements.mjs";

const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Export it, or source it from .dev.vars.");
  exit(1);
}

if (databaseUrl.includes("-pooler.")) {
  // A warning rather than a refusal: it usually works, and refusing would
  // block someone who has only the pooled string to hand.
  console.warn(
    "Warning: DATABASE_URL points at the pooled endpoint (-pooler). Migrations " +
      "should use the direct connection string.",
  );
}

const sql = neon(databaseUrl);
const dir = new URL("../migrations/", import.meta.url);
const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();

if (files.length === 0) {
  console.error(`No .sql files found in ${dir.pathname}.`);
  exit(1);
}

let total = 0;

for (const file of files) {
  const contents = await readFile(new URL(file, dir), "utf8");
  const statements = splitStatements(contents);

  // A file that parses to nothing is a bug in the splitter or an empty file,
  // never something to pass over quietly. The previous runner's whole failure
  // mode was reporting a count of zero and carrying on.
  if (statements.length === 0) {
    console.error(`${file} produced no statements. Refusing to continue.`);
    exit(1);
  }

  console.log(`Applying ${file} (${statements.length} statements)…`);

  for (const [index, statement] of statements.entries()) {
    try {
      await sql.query(statement);
    } catch (error) {
      // Name the statement that failed. Migrations are idempotent, so the
      // usual fix is to correct the file and re-run the whole thing.
      const first = statement.split("\n")[0].slice(0, 100);
      console.error(`\n${file} statement ${index + 1}/${statements.length} failed:`);
      console.error(`  ${first}`);
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      exit(1);
    }
  }

  total += statements.length;
}

console.log(`Migrations complete: ${total} statements across ${files.length} files.`);
