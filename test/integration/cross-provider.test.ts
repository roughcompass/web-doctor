import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosticsReport, PolicyPack, ProviderManifest } from "../../src/contracts/index.js";
import { AxeAdapter } from "../../src/diagnostics/axe-adapter.js";
import { EslintAdapter } from "../../src/diagnostics/eslint-adapter.js";
import { FULL_SCOPE, controlLayers, runDiagnostics, type ProviderAdapter } from "../../src/diagnostics/providers.js";
import type { RuntimeRequest } from "../../src/diagnostics/runtime-request.js";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";
import { startTestApp, type TestApp } from "../support/test-app.js";

/**
 * ESLint and axe evidence for one Control, with the real worker-backed ESLint
 * adapter and the real Playwright and axe adapter. A Control meets its
 * requirement only when every required evidence kind is complete and clean;
 * one provider's failure never hides the other's findings.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const AXE = path.join(ROOT, "examples", "axe-provider");
const CONTROL = "firm/ux/accessible-actions";

function policyWith(axeRequired: boolean): PolicyPack {
  return {
    schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/ux", version: "1.0.0", owner: "Enterprise UX", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" },
    controls: [{
      id: CONTROL, title: "Actions are named and never block the page", rationale: "Assistive technology users must be able to find and complete actions", strength: "required", applicability: {},
      evidence: [
        { provider: "eslint", rule: "no-alert", kind: "static", required: true },
        { provider: "axe", rule: "button-name", kind: "rendered", required: axeRequired },
      ],
      verification: [{ kind: "eslint", description: "Run no-alert." }, { kind: "axe", description: "Check buttons in each rendered state." }],
    }],
  };
}

let workspace: string;
let app: TestApp;
let closedPort: number;
const registries: Record<"required" | "optional", Awaited<ReturnType<typeof writeEmbeddedRegistry>>> = {} as never;
const snapshots: Record<"clean" | "alerting", { root: string; snapshot: ProjectSnapshot }> = {} as never;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-cross-provider-")));
  app = await startTestApp();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closedPort = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const provider = { manifest: JSON.parse(await fs.readFile(path.join(AXE, "provider.json"), "utf8")) as ProviderManifest, artifacts: { "ruleset.json": await fs.readFile(path.join(AXE, "ruleset.json"), "utf8") } };
  registries.required = await writeEmbeddedRegistry(path.join(workspace, "registry-required"), { policies: [policyWith(true)], providers: [provider] });
  registries.optional = await writeEmbeddedRegistry(path.join(workspace, "registry-optional"), { policies: [policyWith(false)], providers: [provider] });
  const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
  for (const [name, body] of [["clean", "export function save() {\n  return true;\n}\n"], ["alerting", "export function save() {\n  alert(\"Saved\");\n  return true;\n}\n"]] as const) {
    const root = path.join(workspace, name);
    await materialize(root, { "package.json": '{"name":"orders","type":"module"}\n', "src/save.js": body });
    snapshots[name] = { root, snapshot: await analyzeProject({ root, repositoryRoot: root, analyzer }) };
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

const runtime = (url: string): RuntimeRequest => ({ authorized: true, targets: [{ url, state: "default" }], timeoutMs: 8_000 });

async function diagnose(options: { source: "clean" | "alerting"; page: string | null; axe?: "required" | "optional"; adapters?: ProviderAdapter[] }): Promise<DiagnosticsReport> {
  const registry = registries[options.axe ?? "required"];
  const { root, snapshot } = snapshots[options.source];
  const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry: registry.snapshot }) });
  return runDiagnostics({
    policy,
    layers: controlLayers(registry.snapshot),
    context: { root, repositoryRoot: root, registryRoot: registry.root, registry: registry.snapshot, providerContributions: { axe: "axe" }, snapshot, scope: FULL_SCOPE, runtime: options.page === null ? null : runtime(options.page) },
    adapters: options.adapters ?? [new EslintAdapter(), new AxeAdapter()],
    gate: "required",
    mode: "ci",
  });
}

const outcome = (report: DiagnosticsReport) => report.controls.find((entry) => entry.control === CONTROL)!;
const evidence = (report: DiagnosticsReport) => Object.fromEntries(outcome(report).evidence.map((item) => [item.provider, [item.status, item.findings]]));

describe("ESLint and axe evidence for one Control", () => {
  it("meets the Control only when both required evidence kinds are complete and clean", async () => {
    const report = await diagnose({ source: "clean", page: `${app.origin}/accessible` });
    expect(evidence(report)).toEqual({ eslint: ["complete", 0], axe: ["complete", 0] });
    expect(outcome(report).status).toBe("met");
    expect(report.gate).toMatchObject({ status: "pass", exitCode: 0 });
  }, 60_000);

  it("maps a static finding and a rendered finding to the same Control", async () => {
    const report = await diagnose({ source: "alerting", page: `${app.origin}/violating` });
    expect(evidence(report)).toEqual({ eslint: ["complete", 1], axe: ["complete", 1] });
    expect(outcome(report).status).toBe("not_met");
    expect(report.findings.map((finding) => [finding.provider.id, finding.rule, finding.evidenceKind, finding.controls]).sort()).toEqual([
      ["axe", "button-name", "rendered", [CONTROL]],
      ["eslint", "no-alert", "static", [CONTROL]],
    ]);
  }, 60_000);

  it("keeps ESLint findings when the browser target is unreachable, and reports the Control as not met", async () => {
    const report = await diagnose({ source: "alerting", page: `http://127.0.0.1:${closedPort}/` });
    expect(report.runs.find((run) => run.provider === "axe")!.completeness).not.toBe("complete");
    expect(evidence(report).eslint).toEqual(["complete", 1]);
    expect(report.findings.map((finding) => finding.rule)).toContain("no-alert");
    expect(outcome(report).status).toBe("not_met");
    expect(report.gate).toMatchObject({ status: "fail", exitCode: 2 });
  }, 60_000);

  it("leaves the Control indeterminate when required rendered evidence is missing and static evidence is clean", async () => {
    const unreachable = await diagnose({ source: "clean", page: `http://127.0.0.1:${closedPort}/` });
    expect(outcome(unreachable).status).toBe("incomplete");
    expect(unreachable.gate).toMatchObject({ status: "incomplete", exitCode: 4 });
    const unrequested = await diagnose({ source: "clean", page: null });
    expect(evidence(unrequested).axe).toEqual(["not_run", 0]);
    expect(outcome(unrequested).status).toBe("incomplete");
  }, 60_000);

  it("keeps axe findings when the ESLint worker fails, and never reports the Control as met", async () => {
    const failingEslint: ProviderAdapter = { engine: "eslint", run: async () => { throw new Error("worker crashed"); } };
    const report = await diagnose({ source: "clean", page: `${app.origin}/violating`, adapters: [failingEslint, new AxeAdapter()] });
    expect(report.runs.find((run) => run.provider === "eslint")).toMatchObject({ completeness: "unavailable" });
    expect(report.findings.map((finding) => finding.rule)).toContain("button-name");
    expect(outcome(report).status).toBe("not_met");
    const clean = await diagnose({ source: "clean", page: `${app.origin}/accessible`, adapters: [failingEslint, new AxeAdapter()] });
    expect(evidence(clean)).toEqual({ eslint: ["unavailable", 0], axe: ["complete", 0] });
    expect(outcome(clean).status).toBe("incomplete");
  }, 60_000);

  it("meets the Control without optional rendered evidence when required static evidence is complete", async () => {
    const report = await diagnose({ source: "clean", page: null, axe: "optional" });
    expect(evidence(report)).toEqual({ eslint: ["complete", 0], axe: ["not_run", 0] });
    expect(outcome(report).status).toBe("met");
  }, 60_000);
});
