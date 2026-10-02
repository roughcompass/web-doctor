import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryFile } from "@repo-facts/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PolicyPack, ProviderManifest, RegistrySnapshot } from "../../src/contracts/index.js";
import { EslintAdapter } from "../../src/diagnostics/eslint-adapter.js";
import { FULL_SCOPE, controlLayers, runDiagnostics, type ProviderAdapter, type ProviderContext } from "../../src/diagnostics/providers.js";
import { analyzeProject } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const verification = [{ kind: "eslint", description: "Run the design rule." }];
const PLUGIN = [
  "export default {",
  "  rules: {",
  "    'use-approved-button': {",
  "      meta: { type: 'problem', fixable: 'code', schema: [], messages: { raw: 'Use the approved Button component.' } },",
  "      create(context) {",
  "        return {",
  "          JSXOpeningElement(node) {",
  "            if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'button') return;",
  "            context.report({ node, messageId: 'raw', fix: (fixer) => fixer.replaceText(node.name, 'Button') });",
  "          },",
  "        };",
  "      },",
  "    },",
  "  },",
  "};",
  "",
].join("\n");
const EXECUTED = "throw new Error('EXECUTED: an unapproved plugin ran');\nexport default { rules: { 'use-approved-button': { create() { return {}; } } } };\n";

function manifest(id: string, content: string): ProviderManifest {
  return {
    schema: "web-doctor.provider-manifest",
    schemaVersion: 1,
    id,
    version: "1.2.0",
    owner: "Fixture Team",
    adapterVersion: "1.0.0",
    engine: "eslint",
    engineRange: "^9.0.0",
    compatibility: { webDoctor: ">=0.1.0" },
    evidenceKinds: ["static"],
    completeness: ["complete"],
    capabilities: ["filesystem-read"],
    invocationModes: ["static", "changed-files"],
    rules: [{ id: "use-approved-button", title: "Approved button", evidenceKind: "static" }],
    artifacts: [{ path: "plugin.mjs", digest: crypto.createHash("sha256").update(content).digest("hex") }],
  };
}

function pack(id: string, layer: PolicyPack["layer"], controls: PolicyPack["controls"]): PolicyPack {
  return { schema: "web-doctor.policy-pack", schemaVersion: 2, id, version: "1.0.0", owner: "Fixture", layer, compatibility: { webDoctor: ">=0.1.0" }, controls };
}

const button = (provider: string) => [{ provider, rule: "use-approved-button", kind: "static" as const, required: true }];
const policies = [
  pack("firm/design", "firmwide", [
    { id: "firm/design/raw-button", title: "No raw buttons", rationale: "Consistency", strength: "required", applicability: {}, evidence: button("fleet-design"), remediation: "Use the firm design-system Button.", verification },
    { id: "firm/design/no-debugger", title: "No debugger statements", rationale: "Safety", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], verification },
  ]),
  pack("wealth/design", "portal", [
    { id: "wealth/design/approved-button", title: "Wealth approved button", rationale: "Brand", strength: "required", applicability: { portals: { anyOf: ["wealth"] } }, evidence: button("fleet-design"), remediation: "Use WealthButton.", verification },
  ]),
  pack("advisor/design", "portal", [
    { id: "advisor/design/approved-button", title: "Advisor approved button", rationale: "Brand", strength: "recommended", applicability: { portals: { anyOf: ["advisor"] }, files: { include: ["src/advisor/**"] } }, evidence: button("fleet-design"), remediation: "Use AdvisorActionButton.", verification },
  ]),
  pack("application/guards", "application", [
    { id: "application/guards/tampered", title: "Tampered plugin", rationale: "Fixture", strength: "recommended", applicability: {}, evidence: button("tampered-design"), verification },
    { id: "application/guards/missing", title: "Missing plugin", rationale: "Fixture", strength: "recommended", applicability: {}, evidence: button("missing-design"), verification },
    { id: "application/guards/rogue", title: "Unregistered plugin", rationale: "Fixture", strength: "recommended", applicability: {}, evidence: [{ provider: "eslint", rule: "rogue-plugin/anything", kind: "static", required: true }], verification },
  ]),
];

const SOURCES: Record<string, MemoryFile> = {
  "src/wealth/Summary.jsx": "export function Summary() {\n  return <button>Save</button>;\n}\n",
  "src/advisor/Actions.jsx": "export function Actions() {\n  return <section><button>Open</button></section>;\n}\n",
  "src/debug.js": "export function inspect(value) {\n  debugger;\n  console.log(value);\n  return value;\n}\n",
};

let workspace: string;
let registryRoot: string;
let registry: RegistrySnapshot;
let providerContributions: Record<string, string>;
let analyzer: SharedFactsAnalyzer;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-eslint-")));
  const built = await writeEmbeddedRegistry(path.join(workspace, "registry"), {
    policies,
    providers: [
      { manifest: manifest("fleet-design", PLUGIN), artifacts: { "plugin.mjs": PLUGIN } },
      { manifest: manifest("tampered-design", PLUGIN), artifacts: { "plugin.mjs": PLUGIN } },
      { manifest: manifest("missing-design", PLUGIN), artifacts: { "plugin.mjs": PLUGIN } },
    ],
  });
  registryRoot = built.root;
  registry = built.snapshot;
  providerContributions = { "fleet-design": "fleet-design", "tampered-design": "tampered-design", "missing-design": "missing-design" };
  // Tampering after the package was verified at startup.
  await fs.writeFile(path.join(registryRoot, "contributions", "tampered-design", "plugin.mjs"), EXECUTED);
  await fs.rm(path.join(registryRoot, "contributions", "missing-design", "plugin.mjs"));
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
}, 60_000);

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function diagnose(name: string, files: Record<string, MemoryFile>, adapters: ProviderAdapter[] = [new EslintAdapter()]) {
  const root = path.join(workspace, name);
  await materialize(root, { "package.json": '{"name":"fixture","type":"module"}\n', ...files });
  const snapshot = await analyzeProject({ root, repositoryRoot: root, analyzer });
  const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry, portalSelection: { cli: ["wealth", "advisor"] } }) });
  const context: ProviderContext = { root, repositoryRoot: root, registryRoot, registry, providerContributions, snapshot, scope: FULL_SCOPE };
  const report = await runDiagnostics({ policy, layers: controlLayers(registry), context, adapters, gate: "required", mode: "ci" });
  return { root, report };
}

function summary(report: Awaited<ReturnType<typeof diagnose>>["report"]) {
  return report.findings.map((finding) => {
    const location = finding.locations[0]!;
    return `${finding.provider.id}/${finding.rule} ${location.kind === "source" ? `${location.path}:${location.line}` : ""} [${finding.controls.join(", ")}]`;
  });
}

describe("ESLint provider", () => {
  it("runs a flat application configuration with approved plugins and only policy-selected rules", async () => {
    const { root, report } = await diagnose("flat", {
      ...SOURCES,
      "eslint.config.js": "export default [{ files: ['**/*.js', '**/*.jsx'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } }, rules: { 'no-console': 'error' } }];\n",
    });
    expect(summary(report)).toEqual(expect.arrayContaining([
      "eslint/no-debugger src/debug.js:2 [firm/design/no-debugger]",
      "fleet-design/use-approved-button src/wealth/Summary.jsx:2 [firm/design/raw-button, wealth/design/approved-button]",
      "fleet-design/use-approved-button src/advisor/Actions.jsx:2 [advisor/design/approved-button, firm/design/raw-button, wealth/design/approved-button]",
    ]));
    expect(report.findings).toHaveLength(3);
    expect(JSON.stringify(report.findings)).not.toContain("no-console");
    const fleet = report.findings.find((finding) => finding.locations[0]!.kind === "source" && finding.locations[0]!.path === "src/advisor/Actions.jsx")!;
    expect(fleet.provider).toEqual({ id: "fleet-design", version: "1.2.0", engine: "eslint", engineVersion: expect.stringMatching(/^9\./), contribution: "fleet-design" });
    expect(fleet.obligations.map((obligation) => [obligation.control, obligation.layer, obligation.strength, obligation.remediation])).toEqual([
      ["advisor/design/approved-button", "portal", "recommended", "Use AdvisorActionButton."],
      ["firm/design/raw-button", "firmwide", "required", "Use the firm design-system Button."],
      ["wealth/design/approved-button", "portal", "required", "Use WealthButton."],
    ]);
    expect(fleet).toMatchObject({ classification: "defect", certainty: "observed", severity: "error", fix: { available: true, applied: false } });
    expect(await fs.readFile(path.join(root, "src/wealth/Summary.jsx"), "utf8")).toBe(SOURCES["src/wealth/Summary.jsx"]);
    expect(report.runs.find((run) => run.provider === "fleet-design")).toMatchObject({ completeness: "complete", capabilities: ["filesystem-read"], denied: [] });
  }, 60_000);

  it("runs a supported legacy configuration", async () => {
    const { report } = await diagnose("legacy", {
      ...SOURCES,
      ".eslintrc.json": JSON.stringify({ root: true, parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } }, rules: { "no-console": "error" } }),
    });
    expect(report.findings).toHaveLength(3);
    expect(summary(report)).toContain("eslint/no-debugger src/debug.js:2 [firm/design/no-debugger]");
    expect(JSON.stringify(report.findings)).not.toContain("no-console");
  }, 60_000);

  it("parses JavaScript and TypeScript with a base configuration when the application has none", async () => {
    const { report } = await diagnose("unconfigured", { "src/wealth/Summary.tsx": "export function Summary(): JSX.Element {\n  const label: string = 'Save';\n  return <button>{label}</button>;\n}\n", "src/debug.js": SOURCES["src/debug.js"]! });
    expect(summary(report)).toEqual(expect.arrayContaining([
      "fleet-design/use-approved-button src/wealth/Summary.tsx:3 [firm/design/raw-button, wealth/design/approved-button]",
      "eslint/no-debugger src/debug.js:2 [firm/design/no-debugger]",
    ]));
    expect(report.runs.find((run) => run.provider === "fleet-design")!.completeness).toBe("complete");
  }, 60_000);

  it("never executes a tampered, missing, or unregistered plugin", async () => {
    const { report } = await diagnose("guards", SOURCES);
    const runs = Object.fromEntries(report.runs.map((run) => [run.provider, run]));
    expect(runs["tampered-design"]).toMatchObject({ completeness: "unavailable", reason: "The tampered-design plugin artifact plugin.mjs does not match its approved digest" });
    expect(runs["missing-design"]).toMatchObject({ completeness: "unavailable", reason: "The missing-design plugin artifact plugin.mjs is missing" });
    expect(runs.eslint).toMatchObject({ completeness: "partial", reason: "rogue-plugin/anything: Plugin rogue-plugin is not catalog-approved" });
    expect(JSON.stringify(report)).not.toContain("EXECUTED");
    const outcomes = Object.fromEntries(report.controls.map((outcome) => [outcome.control, outcome.status]));
    expect(outcomes).toMatchObject({ "application/guards/tampered": "incomplete", "application/guards/missing": "incomplete", "application/guards/rogue": "incomplete", "firm/design/no-debugger": "not_met" });
  }, 60_000);

  it("reports files the application configuration cannot analyze as partial evidence", async () => {
    const { report } = await diagnose("unmatched", {
      "src/debug.js": SOURCES["src/debug.js"]!,
      "src/wealth/Summary.tsx": "export const Summary = () => <button>Save</button>;\n",
      "eslint.config.js": "export default [{ files: ['**/*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } }];\n",
    });
    const run = report.runs.find((entry) => entry.provider === "fleet-design")!;
    expect(run).toMatchObject({ completeness: "partial", reason: expect.stringContaining("1 of 3 files could not be parsed or are not matched by the application configuration: src/wealth/Summary.tsx") });
    expect(report.controls.find((outcome) => outcome.control === "wealth/design/approved-button")!.status).toBe("incomplete");
    expect(summary(report)).toEqual(["eslint/no-debugger src/debug.js:2 [firm/design/no-debugger]"]);
  }, 60_000);

  it("reports an incompatible application configuration without hiding other providers or claiming ESLint Controls pass", async () => {
    const axe: ProviderAdapter = {
      engine: "axe-core",
      async run(plans) {
        return plans.map((plan) => ({ provider: plan.provider, engineVersion: "4.13.0", completeness: "complete" as const, reason: null, ruleStatus: {}, capabilities: [], denied: [], files: 0, drafts: [] }));
      },
    };
    const { report } = await diagnose("incompatible", { ...SOURCES, "eslint.config.js": "import missing from 'eslint-plugin-does-not-exist';\nexport default [missing];\n" }, [new EslintAdapter(), axe]);
    for (const provider of ["eslint", "fleet-design"]) {
      expect(report.runs.find((run) => run.provider === provider)).toMatchObject({ completeness: "unavailable", reason: expect.stringContaining("The application ESLint configuration cannot be composed with enterprise rules") });
    }
    expect(report.findings).toEqual([]);
    expect(report.controls.filter((outcome) => outcome.status === "met")).toEqual([]);
    expect(report.controls.find((outcome) => outcome.control === "firm/design/raw-button")!.status).toBe("incomplete");
    expect(report.gate).toMatchObject({ status: "incomplete", exitCode: 4 });
  }, 60_000);
});
