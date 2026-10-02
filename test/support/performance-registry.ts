import fs from "node:fs/promises";
import path from "node:path";
import type { PolicyPack, ProviderManifest } from "../../src/contracts/index.js";
import { writeEmbeddedRegistry } from "./embedded-registry.js";

/**
 * The registry performance is measured with: an enterprise ESLint baseline of
 * twenty core rules and the approved React Doctor provider with a React
 * quality policy, applicable to every application so each run exercises both.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const EXAMPLE = path.join(ROOT, "examples", "react-doctor-provider");

export const ESLINT_BASELINE = [
  "no-debugger", "no-console", "eqeqeq", "no-unused-vars", "prefer-const", "no-var", "no-eval", "no-implied-eval", "no-new-func", "no-alert",
  "no-shadow", "no-duplicate-imports", "no-param-reassign", "curly", "no-fallthrough", "no-unreachable", "no-empty", "no-self-compare", "no-constant-condition", "no-unsafe-finally",
];

export async function writePerformanceRegistry(root: string): Promise<string> {
  const baseline: PolicyPack = {
    schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/engineering", version: "1.0.0", owner: "Enterprise Engineering", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" },
    controls: ESLINT_BASELINE.map((rule) => ({ id: `firm/engineering/${rule}`, title: `ESLint ${rule}`, rationale: "Enterprise JavaScript baseline", strength: "recommended" as const, applicability: {}, evidence: [{ provider: "eslint", rule, kind: "static" as const, required: true }], verification: [{ kind: "eslint", description: `Run ${rule}.` }] })),
  };
  const reactQuality = JSON.parse(await fs.readFile(path.join(EXAMPLE, "policy.json"), "utf8")) as PolicyPack;
  const everywhere: PolicyPack = { ...reactQuality, controls: reactQuality.controls.map((control) => ({ ...control, applicability: {} })) };
  const manifest = JSON.parse(await fs.readFile(path.join(EXAMPLE, "provider.json"), "utf8")) as ProviderManifest;
  const registry = await writeEmbeddedRegistry(root, { policies: [baseline, everywhere], providers: [{ manifest, artifacts: { "rules.json": await fs.readFile(path.join(EXAMPLE, "rules.json"), "utf8") } }] });
  return registry.root;
}
