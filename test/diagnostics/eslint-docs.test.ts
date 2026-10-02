import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateProviderAuthoring } from "../../src/authoring/provider.js";
import type { DiagnosticsReport, PolicyPack, ProviderManifest } from "../../src/contracts/index.js";
import { EslintAdapter } from "../../src/diagnostics/eslint-adapter.js";
import { FULL_SCOPE, controlLayers, runDiagnostics } from "../../src/diagnostics/providers.js";
import { analyzeProject } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { materialize, readTree } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ADOBE = path.join(ROOT, "examples", "adobe-analytics-governance");
const EXAMPLE = path.join(ROOT, "examples", "eslint");
let workspace: string;
let report: DiagnosticsReport;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-eslint-docs-")));
  const manifest = JSON.parse(await fs.readFile(path.join(ADOBE, "provider.json"), "utf8")) as ProviderManifest;
  const policy = JSON.parse(await fs.readFile(path.join(ADOBE, "policy.json"), "utf8")) as PolicyPack;
  const registry = await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: [policy], providers: [{ manifest, artifacts: { "plugin.mjs": await fs.readFile(path.join(ADOBE, "plugin.mjs"), "utf8") } }] });
  const root = path.join(workspace, "app");
  await materialize(root, await readTree(path.join(EXAMPLE, "app")));
  const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
  const snapshot = await analyzeProject({ root, repositoryRoot: root, analyzer });
  const effective = createEffectivePolicySnapshot({ composition: composePolicy({ registry: registry.snapshot }) });
  report = await runDiagnostics({
    policy: effective,
    layers: controlLayers(registry.snapshot),
    context: { root, repositoryRoot: root, registryRoot: registry.root, registry: registry.snapshot, providerContributions: { [manifest.id]: manifest.id }, snapshot, scope: FULL_SCOPE },
    adapters: [new EslintAdapter()],
    gate: "required",
    mode: "ci",
  });
}, 60_000);

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("ESLint provider documentation", () => {
  it("is linked from the README and covers the contract, composition, approval, suppressions, and fixes", async () => {
    const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
    const documentation = await fs.readFile(path.join(ROOT, "docs", "eslint-provider.md"), "utf8");
    expect(readme).toContain("docs/eslint-provider.md");
    for (const heading of ["## Provider Contract", "## Configuration Composition", "## Plugin Approval", "## Rule Selection and Severity", "## Suppressions", "## Fixes", "## Bounded Execution", "## Changed Files and Baselines", "## Example"]) {
      expect(documentation).toContain(heading);
    }
    expect(documentation).toContain("examples/eslint/expected.json");
    expect(documentation).toContain("examples/adobe-analytics-governance");
  });

  it("uses a provider contribution that passes the provider contract tests", async () => {
    const fixtures = (await fs.readdir(path.join(ADOBE, "fixtures"))).filter((file) => file.endsWith(".json")).map((file) => path.join(ADOBE, "fixtures", file));
    const validation = await validateProviderAuthoring({ manifestPath: path.join(ADOBE, "provider.json"), contributionPath: path.join(ADOBE, "web-doctor.json"), pluginPath: path.join(ADOBE, "plugin.mjs"), fixturePaths: fixtures });
    expect(validation).toMatchObject({ valid: true, issues: [], fixtures: 6, rules: 3 });
  });

  it("produces the documented findings, outcomes, and gate for the example application", async () => {
    const expected = JSON.parse(await fs.readFile(path.join(EXAMPLE, "expected.json"), "utf8")) as { findings: unknown[]; controls: Record<string, string>; gate: unknown };
    const actual = report.findings.map((finding) => {
      const location = finding.locations[0]!;
      return { provider: finding.provider.id, rule: finding.rule, path: location.kind === "source" ? location.path : null, line: location.kind === "source" ? location.line : null, controls: finding.controls, suppression: finding.suppression };
    });
    expect(actual).toEqual(expect.arrayContaining(expected.findings));
    expect(actual).toHaveLength(expected.findings.length);
    expect(Object.fromEntries(report.controls.map((outcome) => [outcome.control, outcome.status]))).toEqual(expected.controls);
    expect(report.gate).toMatchObject(expected.gate as object);
    for (const finding of report.findings) expect(finding.fix.applied).toBe(false);
  });
});
