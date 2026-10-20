import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// @ts-expect-error -- a plain .mjs helper with no type declarations; the
// migration runner is not TypeScript because it runs before any build step.
import { splitStatements } from "../scripts/sql-statements.mjs";

const split = splitStatements as (sql: string) => string[];

describe("splitStatements", () => {
  it("keeps a statement that has a comment above it", () => {
    // The regression. The previous runner split on /;\s*$/m and then dropped
    // any chunk starting with "--", which discarded the statement the comment
    // documented. Across this repo's migrations that silently lost 21
    // statements, including CREATE TABLE tickets -- and each file still
    // reported a count and exited 0, so applying nothing looked like working.
    const statements = split(`
-- Explains the table below.
CREATE TABLE a (id INT);
`);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("CREATE TABLE a");
    expect(statements[0]).not.toContain("Explains");
  });

  it("does not split inside a dollar-quoted block", () => {
    // A DO block is full of semicolons. Splitting on them turns one statement
    // into several fragments, none of which parse.
    const statements = split(`
DO $$
DECLARE x TEXT;
BEGIN
  EXECUTE format('ALTER TABLE %I DROP NOT NULL', 'a');
END $$;
CREATE TABLE b (id INT);
`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DECLARE x TEXT;");
    expect(statements[0]).toContain("END $$");
    expect(statements[1]).toContain("CREATE TABLE b");
  });

  it("handles a tagged dollar quote", () => {
    const statements = split(`DO $body$ BEGIN; END $body$;\nSELECT 1;`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("$body$");
  });

  it("does not split inside a string literal", () => {
    const statements = split(`INSERT INTO a VALUES ('x;y');\nSELECT 1;`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'x;y'");
  });

  it("handles an escaped quote inside a literal", () => {
    const statements = split(`INSERT INTO a VALUES ('it''s; fine');`);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("it''s; fine");
  });

  it("strips a trailing comment without eating the statement", () => {
    const statements = split(`CREATE TABLE a (id INT); -- trailing note\nSELECT 1;`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("CREATE TABLE a");
    expect(statements.join(" ")).not.toContain("trailing note");
  });

  it("strips block comments, including nested ones", () => {
    const statements = split(`/* outer /* inner */ still outer */ SELECT 1;`);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toBe("SELECT 1");
  });

  it("does not treat a -- inside a string as a comment", () => {
    const statements = split(`INSERT INTO a VALUES ('a -- b');`);
    expect(statements[0]).toContain("'a -- b'");
  });

  it("ignores a comment-only file and a trailing semicolon", () => {
    expect(split("-- nothing here\n")).toEqual([]);
    expect(split("SELECT 1;\n\n")).toEqual(["SELECT 1"]);
  });

  it("keeps a final statement with no trailing semicolon", () => {
    expect(split("SELECT 1")).toEqual(["SELECT 1"]);
  });
});

describe("this repo's migrations", () => {
  const dir = "migrations";
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();

  it("has migrations to run", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} parses to at least one statement`, () => {
      // The specific shape of the old bug: 0003 parsed to zero statements and
      // the runner reported success. A file that yields nothing is now a hard
      // failure in the runner, and this is the test that would catch it first.
      expect(split(readFileSync(`${dir}/${file}`, "utf8")).length).toBeGreaterThan(0);
    });

    it(`${file} yields no statement that is only a comment`, () => {
      for (const statement of split(readFileSync(`${dir}/${file}`, "utf8"))) {
        expect(statement.startsWith("--")).toBe(false);
        expect(statement.trim().length).toBeGreaterThan(0);
      }
    });
  }

  it("keeps every CREATE TABLE in the migration files", () => {
    // Counted across all files against the raw text, so a statement cannot go
    // missing between the file and what the database is sent.
    let inFiles = 0;
    let inStatements = 0;
    for (const file of files) {
      const sql = readFileSync(`${dir}/${file}`, "utf8");
      // Only count CREATE TABLE at the start of a line, so the word appearing
      // in prose inside a comment is not counted.
      inFiles += (sql.match(/^CREATE TABLE/gm) ?? []).length;
      inStatements += split(sql).filter((s) => /^CREATE TABLE/.test(s)).length;
    }
    expect(inFiles).toBeGreaterThan(0);
    expect(inStatements).toBe(inFiles);
  });
});
