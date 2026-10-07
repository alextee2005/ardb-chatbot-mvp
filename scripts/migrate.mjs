#!/usr/bin/env node
/**
 * Apply migrations/*.sql to the Neon database in DATABASE_URL.
 * Every statement is idempotent, so re-running is safe.
 */

import { readdir, readFile } from "node:fs/promises";
import { env, exit } from "node:process";

import { neon } from "@neondatabase/serverless";

const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Export it, or source it from .dev.vars.");
  exit(1);
}

const sql = neon(databaseUrl);
const dir = new URL("../migrations/", import.meta.url);
const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();

for (const file of files) {
  const contents = await readFile(new URL(file, dir), "utf8");
  console.log(`Applying ${file}…`);
  // The HTTP driver sends one statement per call, so split on semicolons that
  // end a line -- adequate for this schema, which has no function bodies.
  const statements = contents
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !statement.startsWith("--"));

  for (const statement of statements) {
    await sql.query(statement);
  }
  console.log(`  ${statements.length} statements applied.`);
}

console.log("Migrations complete.");
