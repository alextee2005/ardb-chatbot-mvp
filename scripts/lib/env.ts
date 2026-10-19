/**
 * Environment access for the Node-side scripts.
 *
 * Declared rather than imported from `node:process`. This project's tsconfig
 * targets Workers and carries no @types/node; adding them so one script can
 * typecheck would put Node's globals in scope for src/ too, where they do not
 * exist at runtime.
 */

declare const process: {
  env: Record<string, string | undefined>;
  exit: (code: number) => never;
};

export const env = process.env;

/**
 * The annotation is load-bearing. TypeScript treats a call as terminal only
 * when the callee is a name with an explicitly declared `never` return type,
 * so without it every guard that calls this leaves its subject possibly null.
 */
export const exit: (code: number) => never = process.exit;

/** A required variable, or exit 2 naming it. */
export function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set.`);
    exit(2);
  }
  return value;
}

/** A required integer variable, or exit 2 naming it. */
export function requiredInt(name: string, { positive = false } = {}): number {
  const raw = required(name);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || (positive && value <= 0)) {
    console.error(`${name} must be ${positive ? "a positive integer" : "an integer"}, got "${raw}".`);
    exit(2);
  }
  return value;
}
