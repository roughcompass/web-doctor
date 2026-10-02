import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosticsReport, GuidanceEntry, PolicyPack, ProviderManifest } from "../../src/contracts/index.js";
import { AxeAdapter } from "../../src/diagnostics/axe-adapter.js";
import { FULL_SCOPE, controlLayers, runDiagnostics } from "../../src/diagnostics/providers.js";
import type { RuntimeRequest } from "../../src/diagnostics/runtime-request.js";
import { analyzeProject } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";
import { ACCOUNT_SESSION, startTestApp, type TestApp } from "../support/test-app.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PROVIDER = path.join(ROOT, "examples", "axe-provider");
const EXAMPLE = path.join(ROOT, "examples", "axe");
let workspace: string;
let app: TestApp;

async function run(request: RuntimeRequest): Promise<DiagnosticsReport> {
  const read = async (file: string) => JSON.parse(await fs.readFile(path.join(PROVIDER, file), "utf8")) as unknown;
  const guidance = await Promise.all((await fs.readdir(path.join(PROVIDER, "guidance"))).map((file) => read(`guidance/${file}`))) as GuidanceEntry[];
  const registry = await writeEmbeddedRegistry(await fs.mkdtemp(path.join(workspace, "registry-")), {
    policies: [await read("policy.json") as PolicyPack],
    providers: [{ manifest: await read("provider.json") as ProviderManifest, artifacts: { "ruleset.json": await fs.readFile(path.join(PROVIDER, "ruleset.json"), "utf8") } }],
    guidance,
  });
  const root = path.join(workspace, "app");
  await materialize(root, { "package.json": '{"name":"orders"}\n' });
  const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
  const snapshot = await analyzeProject({ root, repositoryRoot: root, analyzer });
  return runDiagnostics({
    policy: createEffectivePolicySnapshot({ composition: composePolicy({ registry: registry.snapshot }) }),
    layers: controlLayers(registry.snapshot),
    context: { root, repositoryRoot: root, registryRoot: registry.root, registry: registry.snapshot, providerContributions: { axe: "axe" }, snapshot, scope: FULL_SCOPE, runtime: request },
    adapters: [new AxeAdapter()],
    gate: "required",
    mode: "local",
    guidance: registry.snapshot.guidance,
  });
}

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-axe-docs-")));
  app = await startTestApp();
});

afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("axe provider documentation", () => {
  it("is linked from the README and covers proof boundaries, requests, authentication, and sensitive output", async () => {
    const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
    const documentation = await fs.readFile(path.join(ROOT, "docs", "axe-provider.md"), "utf8");
    expect(readme).toContain("docs/axe-provider.md");
    for (const heading of ["## Proof Boundaries", "## Approval", "## Runtime Requests", "## States and Steps", "## Authenticated Targets", "## Sensitive Output", "## Failure Isolation", "## Example"]) expect(documentation).toContain(heading);
    for (const file of ["runtime-request.json", "storage-state.json", "expected.json"]) expect(documentation).toContain(`examples/axe/${file}`);
  });

  it("runs the documented request against a local test application, including an authenticated state", async () => {
    const storageState = path.join(workspace, "storage-state.json");
    await fs.writeFile(storageState, (await fs.readFile(path.join(EXAMPLE, "storage-state.json"), "utf8")).replace("{session}", ACCOUNT_SESSION));
    const request = JSON.parse((await fs.readFile(path.join(EXAMPLE, "runtime-request.json"), "utf8")).replaceAll("{origin}", app.origin).replace("{storageState}", storageState)) as RuntimeRequest;
    const expected = JSON.parse(await fs.readFile(path.join(EXAMPLE, "expected.json"), "utf8")) as { findings: unknown[]; testedStates: string[]; controls: Record<string, string> };
    const report = await run(request);
    const findings = report.findings.map((finding) => {
      const location = finding.locations[0] as { state: string; route: string | null; target: string[] };
      return { rule: finding.rule, state: location.state, route: location.route, target: location.target, controls: finding.controls };
    });
    expect(findings).toEqual(expect.arrayContaining(expected.findings));
    expect(findings).toHaveLength(expected.findings.length);
    expect(report.runs.find((entry) => entry.provider === "axe")!.testedScope.map((scope) => /\[(.+)\]/.exec(scope)![1])).toEqual(expected.testedStates);
    expect(Object.fromEntries(report.controls.map((outcome) => [outcome.control, outcome.status]))).toEqual(expected.controls);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(ACCOUNT_SESSION);
    expect(serialized).not.toContain(storageState);
    expect(serialized).not.toContain("<img");
  }, 90_000);

  it("reports the authenticated state as untested without its storage state", async () => {
    const request = JSON.parse((await fs.readFile(path.join(EXAMPLE, "runtime-request.json"), "utf8")).replaceAll("{origin}", app.origin)) as RuntimeRequest;
    delete request.targets[1]!.storageState;
    const report = await run(request);
    expect(report.runs.find((entry) => entry.provider === "axe")!.reason).toContain("[signed-in] 1280x800: The target answered HTTP 401");
  }, 90_000);
});
