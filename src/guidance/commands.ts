import type { DocumentFact, FactDocument } from "@repo-facts/contract";
import { factView, type FactView } from "../facts/queries.js";

/**
 * Declared verification commands from the shared fact document, stated as
 * the developer would invoke them with the established package manager.
 * Web Doctor names these commands and never runs them.
 */

export interface DeclaredCommand {
  kind: string;
  /** The invocation, such as `npm run test`, or null when no single package manager is established. */
  command: string | null;
  /** What the script runs, as declared. */
  declared: string;
  evidence: FactView;
}

export const PACKAGE_MANAGER_COMMANDS: Readonly<Record<string, { add: string; dev: string; run: string }>> = {
  npm: { add: "npm install", dev: "npm install --save-dev", run: "npm run" },
  pnpm: { add: "pnpm add", dev: "pnpm add --save-dev", run: "pnpm run" },
  yarn: { add: "yarn add", dev: "yarn add --dev", run: "yarn run" },
  bun: { add: "bun add", dev: "bun add --dev", run: "bun run" },
};

export function packageManagerOf(shared: FactDocument): DocumentFact | null {
  const managers = (shared.categories.package_managers?.facts ?? []).filter((fact) => fact.state === "observed");
  return new Set(managers.map((fact) => String(fact.value))).size === 1 ? managers[0]! : null;
}

/**
 * The root manifest script for a kind. A `test` command that also drives a
 * browser (`e2e`) is not a component test command, so it is skipped for
 * `test` and preferred for `e2e`.
 */
export function declaredCommand(shared: FactDocument, kind: string): DeclaredCommand | null {
  const candidates = (shared.categories.verification_commands?.facts ?? []).filter((fact) => fact.state === "observed" && (fact.value as { source?: unknown }).source === "package.json" && kindsOf(fact).includes(kind));
  const fact = kind === "test" ? candidates.find((candidate) => !kindsOf(candidate).includes("e2e")) : candidates[0];
  if (fact === undefined) return null;
  const value = fact.value as { command?: unknown; context?: { script?: unknown } };
  const script = typeof value.context?.script === "string" ? value.context.script : null;
  const manager = packageManagerOf(shared);
  const run = manager === null ? null : PACKAGE_MANAGER_COMMANDS[String(manager.value)]?.run ?? null;
  return { kind, command: run === null || script === null ? null : `${run} ${script}`, declared: String(value.command), evidence: factView("shared", shared, "verification_commands", fact) };
}

export function kindsOf(fact: DocumentFact): string[] {
  const kinds = (fact.value as { kinds?: unknown }).kinds;
  return Array.isArray(kinds) ? kinds.filter((kind): kind is string => typeof kind === "string") : [];
}
