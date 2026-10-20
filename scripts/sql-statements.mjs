/**
 * Split a .sql file into the statements to send one at a time.
 *
 * Neon's HTTP driver takes one statement per call, so the file has to be
 * split. Doing that with `split(";")` and a regex is what this module exists
 * to replace: the previous version split on `/;\s*$/m` and then dropped any
 * chunk beginning with `--`, which silently discarded every statement that had
 * an explanatory comment above it. Across this repo's migrations that was 21
 * statements, including `CREATE TABLE tickets` -- and because each file still
 * reported a count and exited 0, a migration that applied nothing looked
 * exactly like one that worked.
 *
 * So this is a real scanner rather than a regex. It tracks the three things
 * that make a semicolon not a statement boundary:
 *
 *   'single quotes'   -- a semicolon inside a string literal
 *   $$ dollar quotes $$ -- a semicolon inside a DO block or function body
 *   -- line comments  -- and / * block comments * /
 *
 * Comments are stripped rather than used to reject a chunk, which is the
 * actual fix: a comment is not a statement and must not decide the fate of
 * the statement it documents.
 */

/**
 * @param {string} sql the contents of a .sql file
 * @returns {string[]} statements, comments removed, in file order
 */
export function splitStatements(sql) {
  /** @type {string[]} */
  const statements = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);

    // -- line comment: drop to the end of the line, keeping the newline so
    // tokens either side of it do not run together.
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }

    // /* block comment */, which Postgres allows to nest.
    if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      current += " ";
      continue;
    }

    // 'string literal', where '' is an escaped quote rather than a close.
    if (rest.startsWith("'")) {
      current += "'";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          current += "'";
          i += 1;
          break;
        }
        current += sql[i];
        i += 1;
      }
      continue;
    }

    // $$ ... $$ or $tag$ ... $tag$. Everything inside is opaque, semicolons
    // included -- this is what a DO block needs.
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) {
        // Unterminated. Take the remainder rather than looping; the database
        // will reject it with a better message than anything invented here.
        current += sql.slice(i);
        i = sql.length;
        continue;
      }
      current += sql.slice(i, close + tag.length);
      i = close + tag.length;
      continue;
    }

    // A real statement boundary.
    if (sql[i] === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i += 1;
      continue;
    }

    current += sql[i];
    i += 1;
  }

  // A trailing statement with no final semicolon still counts.
  const last = current.trim();
  if (last) statements.push(last);

  return statements;
}
