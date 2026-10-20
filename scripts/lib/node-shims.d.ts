/**
 * The slice of Node's standard library the scripts here use.
 *
 * A hand-written shim rather than @types/node, for the same reason
 * `scripts/lib/env.ts` declares `process`: this project's tsconfig covers
 * src/ as well, and installing Node's types to typecheck three scripts would
 * put `Buffer`, `__dirname` and the rest in scope for Worker code, where they
 * do not exist at runtime. The compiler would then accept code that cannot
 * run in production.
 *
 * Narrow on purpose. Each signature is only as wide as its callers need, so
 * an unintended use fails to compile instead of failing in CI.
 */

declare module "node:fs" {
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
  export function appendFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
}
