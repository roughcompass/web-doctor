import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosticsReport, PolicyPack, ProviderManifest, RegistrySnapshot } from "../../src/contracts/index.js";
import { EslintAdapter } from "../../src/diagnostics/eslint-adapter.js";
import { FULL_SCOPE, controlLayers, runDiagnostics, type DiagnosticScope } from "../../src/diagnostics/providers.js";
import { changedScope, fileScope } from "../../src/diagnostics/scope.js";
import { analyzeProject } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PLUGIN = "export default { rules: { 'use-approved-button': { meta: { type: 'problem', schema: [], messages: { raw: 'Use the approved Button component.' } }, create(context) { return { JSXOpeningElement(node) { if (node.name.name === 'button') context.report({ node, messageId: 'raw' }); } }; } } } };\n";
const verification = [{ kind: "eslint", description: "Run the design rule." }];

function manifest(id: string, engine: string, invocationModes: string[], content: string): ProviderManifest {
  return {
    schema: "web-doctor.provider-manifest", schemaVersion: 1, id, version: "1.0.0", owner: "Fixture", adapterVersion: "1.0.0", engine, engineRange: "^9.0.0",
    compatibility: { webDoctor: ">=0.1.0" }, evidenceKinds: ["static"], completeness: ["complete"], capabilities: ["filesystem-read"], invocationModes,
    rules: [{ id: "use-approved-button", title: "Approved button", evidenceKind: "static" }],
    artifacts: [{ path: "plugin.mjs", digest: crypto.createHash("sha256").update(content).digest("hex") }],
  };
}

const policies: PolicyPack[] = [{
  schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/design", version: "1.0.0", owner: "Fixture", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" },
  controls: [
    { id: "firm/design/raw-button", title: "No raw buttons", rationale: "Consistency", strength: "required", applicability: {}, evidence: [{ provider: "fleet-design", rule: "use-approved-button", kind: "static", required: true }], verification },
    { id: "firm/design/reports-button", title: "Reports buttons", rationale: "Consistency", strength: "required", applicability: { files: { include: ["src/reports/**"] } }, evidence: [{ provider: "fleet-design", rule: "use-approved-button", kind: "static", required: true }], verification },
    { id: "firm/design/bundle-graph", title: "Whole-project graph check", rationale: "Graph", strength: "recommended", applicability: {}, evidence: [{ provider: "bundle-graph", rule: "use-approved-button", kind: "static", required: true }], verification },
  ],
}];

let workspace: string;
let registry: { root: string; snapshot: RegistrySnapshot };
let analyzer: SharedFactsAnalyzer;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-scope-")));
  registry = await writeEmbeddedRegistry(path.join(workspace, "registry"), {
    policies,
    providers: [
      { manifest: manifest("fleet-design", "eslint", ["static", "changed-files"], PLUGIN), artifacts: { "plugin.mjs": PLUGIN } },
      { manifest: manifest("bundle-graph", "bundle-graph", ["full-project"], PLUGIN), artifacts: { "plugin.mjs": PLUGIN } },
    ],
  });
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
}, 60_000);

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", HOME: workspace } });
}

async function repository(name: string): Promise<string> {
  const root = path.join(workspace, name);
  await materialize(root, {
    "package.json": '{"name":"scoped","type":"module"}\n',
    "src/orders/List.jsx": "export function List() {\n  return <button>Old</button>;\n}\n",
    "src/reports/Chart.jsx": "export function Chart() {\n  return <section />;\n}\n",
  });
  await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

async function diagnose(root: string, scope: DiagnosticScope, baseline?: DiagnosticsReport) {
  const snapshot = await analyzeProject({ root, repositoryRoot: root, analyzer });
  const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry: registry.snapshot }) });
  return runDiagnostics({
    policy,
    layers: controlLayers(registry.snapshot),
    context: { root, repositoryRoot: root, registryRoot: registry.root, registry: registry.snapshot, providerContributions: { "fleet-design": "fleet-design", "bundle-graph": "bundle-graph" }, snapshot, scope },
    adapters: [new EslintAdapter()],
    gate: "required",
    mode: "ci",
    ...(baseline === undefined ? {} : { baseline: { digest: baseline.digest, findings: baseline.findings } }),
  });
}

const where = (report: DiagnosticsReport) => report.findings.map((finding) => {
  const location = finding.locations[0]!;
  return `${location.kind === "source" ? `${location.path}:${location.line}` : ""} ${finding.baseline}`;
});

describe("changed scope and baselines", () => {
  it("derives changed files and added line ranges from Git, including untracked files", async () => {
    const root = await repository("git-scope");
    await fs.writeFile(path.join(root, "src/orders/List.jsx"), "export function List() {\n  return <button>Old</button>;\n}\n\nexport function Added() {\n  return <button>New</button>;\n}\n");
    await fs.writeFile(path.join(root, "src/orders/Draft.jsx"), "export const Draft = () => <button>Draft</button>;\n");
    const scope = await changedScope({ root, repositoryRoot: root, base: "HEAD", mode: "changed-lines" });
    expect(scope.files).toEqual(["src/orders/Draft.jsx", "src/orders/List.jsx"]);
    expect(scope.lines.get("src/orders/List.jsx")).toEqual([[4, 7]]);
    expect(scope.base).toMatch(/^[0-9a-f]{40}$/);
    await expect(changedScope({ root, repositoryRoot: root, base: "--output=/tmp/pwned", mode: "changed-files" })).rejects.toThrow("does not name a commit");
    await expect(fs.access("/tmp/pwned")).rejects.toThrow();
  });

  it("analyzes only changed files and names the full-project checks it skipped", async () => {
    const root = await repository("changed-files");
    const report = await diagnose(root, fileScope(["src/orders/List.jsx"]));
    expect(where(report)).toEqual(["src/orders/List.jsx:2 unknown"]);
    expect(report.fullProjectOnly).toEqual([{ provider: "bundle-graph", reason: "bundle-graph checks the whole project and does not run in changed-files mode" }]);
    const outcomes = Object.fromEntries(report.controls.map((outcome) => [outcome.control, outcome.status]));
    expect(outcomes).toEqual({ "firm/design/bundle-graph": "not_evaluated", "firm/design/raw-button": "not_met", "firm/design/reports-button": "not_evaluated" });
    expect(report.runs.find((run) => run.provider === "fleet-design")!.scope).toEqual({ mode: "changed-files", files: 1, fullProjectOnly: false });
  }, 60_000);

  it("separates findings on changed lines from existing ones in the same files", async () => {
    const root = await repository("changed-lines");
    await fs.writeFile(path.join(root, "src/orders/List.jsx"), "export function List() {\n  return <button>Old</button>;\n}\n\nexport function Added() {\n  return <button>New</button>;\n}\n");
    const report = await diagnose(root, await changedScope({ root, repositoryRoot: root, base: "HEAD", mode: "changed-lines" }));
    expect(where(report)).toEqual(expect.arrayContaining(["src/orders/List.jsx:2 existing", "src/orders/List.jsx:6 introduced"]));
    expect(report.gate).toMatchObject({ status: "fail", reasons: ["firm/design/raw-button has 1 introduced findings"] });

    await fs.writeFile(path.join(root, "src/orders/List.jsx"), "// Comment added above the existing debt.\nexport function List() {\n  return <button>Old</button>;\n}\n");
    const existingOnly = await diagnose(root, await changedScope({ root, repositoryRoot: root, base: "HEAD", mode: "changed-lines" }));
    expect(where(existingOnly)).toEqual(["src/orders/List.jsx:3 existing"]);
    expect(existingOnly.gate.status).not.toBe("fail");
  }, 60_000);

  it("recognizes baseline debt after edits move it and gates only on introduced findings", async () => {
    const root = await repository("baseline");
    const baseline = await diagnose(root, FULL_SCOPE);
    expect(where(baseline)).toEqual(["src/orders/List.jsx:2 unknown"]);
    await fs.writeFile(path.join(root, "src/orders/List.jsx"), "import { useState } from 'react';\n\nexport function List() {\n  return <button>Old</button>;\n}\n");
    await fs.writeFile(path.join(root, "src/reports/Chart.jsx"), "export function Chart() {\n  return <button>Export</button>;\n}\n");
    const report = await diagnose(root, FULL_SCOPE, baseline);
    expect(where(report).sort()).toEqual(["src/orders/List.jsx:4 existing", "src/reports/Chart.jsx:2 introduced"]);
    expect(report.scope.baseline).toBe(baseline.digest);
    expect(report.gate.reasons).toEqual(["firm/design/raw-button has 1 introduced findings", "firm/design/reports-button has 1 introduced findings"]);
  }, 60_000);
});
