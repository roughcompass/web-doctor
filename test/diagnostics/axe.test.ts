import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosticsReport, GuidanceEntry, PolicyPack, ProviderManifest } from "../../src/contracts/index.js";
import { AxeAdapter } from "../../src/diagnostics/axe-adapter.js";
import { scan } from "../../src/diagnostics/axe-task.js";
import { EslintAdapter } from "../../src/diagnostics/eslint-adapter.js";
import { FULL_SCOPE, controlLayers, runDiagnostics, type ProviderAdapter } from "../../src/diagnostics/providers.js";
import type { RuntimeRequest, RuntimeTarget } from "../../src/diagnostics/runtime-request.js";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";
import { startTestApp, type TestApp } from "../support/test-app.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const AXE = path.join(ROOT, "examples", "axe-provider");
let workspace: string;
let app: TestApp;
let registry: Awaited<ReturnType<typeof writeEmbeddedRegistry>>;
let snapshot: ProjectSnapshot;
let appRoot: string;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-axe-")));
  app = await startTestApp();
  const read = async (file: string) => JSON.parse(await fs.readFile(path.join(AXE, file), "utf8")) as unknown;
  const guidance = await Promise.all(["keyboard", "focus", "screen-reader", "zoom", "motion", "untested-states"].map((name) => read(`guidance/${name}.json`))) as GuidanceEntry[];
  const staticPolicy: PolicyPack = { schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version: "1.0.0", owner: "Fixture", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" }, controls: [{ id: "firm/code/no-debugger", title: "No debugger", rationale: "Safety", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], verification: [{ kind: "eslint", description: "Run no-debugger." }] }] };
  registry = await writeEmbeddedRegistry(path.join(workspace, "registry"), {
    policies: [await read("policy.json") as PolicyPack, staticPolicy],
    providers: [{ manifest: await read("provider.json") as ProviderManifest, artifacts: { "ruleset.json": await fs.readFile(path.join(AXE, "ruleset.json"), "utf8") } }],
    guidance,
  });
  appRoot = path.join(workspace, "app");
  await materialize(appRoot, { "package.json": '{"name":"orders","type":"module"}\n', "src/debug.js": "export const inspect = (value) => {\n  debugger;\n  return value;\n};\n" });
  const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
  snapshot = await analyzeProject({ root: appRoot, repositoryRoot: appRoot, analyzer });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function diagnose(runtime: RuntimeRequest | null, adapters: ProviderAdapter[] = [new AxeAdapter()]): Promise<DiagnosticsReport> {
  const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry: registry.snapshot }) });
  return runDiagnostics({
    policy,
    layers: controlLayers(registry.snapshot),
    context: { root: appRoot, repositoryRoot: appRoot, registryRoot: registry.root, registry: registry.snapshot, providerContributions: { axe: "axe" }, snapshot, scope: FULL_SCOPE, runtime },
    adapters,
    gate: "required",
    mode: "ci",
    guidance: registry.snapshot.guidance,
  });
}

const request = (...targets: RuntimeTarget[]): RuntimeRequest => ({ authorized: true, targets, timeoutMs: 5_000 });
const outcome = (report: DiagnosticsReport, control: string) => report.controls.find((entry) => entry.control === control)!;
const axeRun = (report: DiagnosticsReport) => report.runs.find((run) => run.provider === "axe")!;

describe("axe runtime accessibility provider", () => {
  it("starts no browser without an authorized runtime request", async () => {
    let calls = 0;
    const counting: ProviderAdapter = { engine: "axe-core", run: async (plans, context) => { calls++; return new AxeAdapter().run(plans, context); } };
    const requestsBefore = app.requests.length;
    const report = await diagnose(null, [counting]);
    expect(calls).toBe(0);
    expect(app.requests.length).toBe(requestsBefore);
    expect(axeRun(report)).toMatchObject({ completeness: "unavailable", reason: "Rendered checks need an authorized runtime request that names running targets", testedScope: [] });
    expect(outcome(report, "firm/accessibility-runtime/button-name")).toMatchObject({ status: "incomplete", evidence: [expect.objectContaining({ status: "not_run" })], limitations: ["No rendered state was tested, so rendered accessibility evidence is missing"] });
  });

  it("refuses targets beyond loopback, embedded credentials, and non-web URLs before starting a browser", async () => {
    const report = await diagnose(request({ url: "https://orders.example.test/", state: "remote" }, { url: `http://user:secret@127.0.0.1:1/`, state: "credentials" }, { url: "file:///etc/hosts", state: "file" }));
    expect(axeRun(report).reason).toBe("The runtime request cannot run: Target 1 is not a loopback address; remote targets need allowRemoteHosts and an approved network-target capability; Target 2 must not embed credentials; use a storage-state file; Target 3 must use http or https");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("finds rendered violations with their tested state and maps them to Controls", async () => {
    const report = await diagnose(request({ url: `${app.origin}/violating`, route: "/orders", state: "orders-loaded", viewport: { width: 1024, height: 768 } }));
    expect(report.findings.map((finding) => [finding.rule, finding.locations[0], finding.controls])).toEqual(expect.arrayContaining([
      ["button-name", { kind: "rendered", url: `${app.origin}/violating`, route: "/orders", state: "orders-loaded", viewport: { width: 1024, height: 768 }, target: ["button"] }, ["firm/accessibility-runtime/button-name"]],
      ["image-alt", expect.objectContaining({ kind: "rendered", state: "orders-loaded", target: ["img"] }), ["firm/accessibility-runtime/image-alt"]],
    ]));
    for (const finding of report.findings) expect(finding).toMatchObject({ evidenceKind: "rendered", classification: "defect", provider: { id: "axe", engine: "axe-core", engineVersion: "4.13.0" } });
    expect(JSON.stringify(report.findings)).not.toContain("<button");
    expect(outcome(report, "firm/accessibility-runtime/button-name").status).toBe("not_met");
    expect(axeRun(report).testedScope).toEqual([`${app.origin}/violating [orders-loaded] 1024x768`]);
  }, 60_000);

  it("never presents a clean automated run as conformance and keeps manual obligations", async () => {
    const report = await diagnose(request({ url: `${app.origin}/accessible`, state: "orders-loaded" }));
    expect(report.findings).toEqual([]);
    const buttons = outcome(report, "firm/accessibility-runtime/button-name");
    expect(buttons.status).toBe("met");
    expect(buttons.limitations).toEqual([`Automated rendered checks cover only detectable rules in the tested states (${app.origin}/accessible [orders-loaded] 1280x800); they do not establish WCAG conformance`]);
    expect([...new Set(buttons.obligations.map((item) => item.kind))].sort()).toEqual(["focus", "keyboard", "manual", "motion", "screen-reader", "untested-states", "zoom"]);
    expect(buttons.obligations.find((item) => item.source === "firm/accessibility-runtime/button-name")).toEqual({ kind: "manual", description: "Confirm the control name with a screen reader.", source: "firm/accessibility-runtime/button-name" });
    expect(buttons.obligations.find((item) => item.source === "runtime-scope")!.description).toContain("remain untested");
    expect(buttons.obligations.filter((item) => item.source.startsWith("accessibility/runtime/"))).toHaveLength(6);
    expect(JSON.stringify(report).toLowerCase()).not.toMatch(/\bconformant\b|\bwcag compliant\b/);
  }, 60_000);

  it("treats rules axe could not decide as partial evidence", async () => {
    const report = await diagnose(request({ url: `${app.origin}/review`, state: "status-banner" }));
    expect(axeRun(report)).toMatchObject({ completeness: "partial", reason: expect.stringContaining("color-contrast: 1 elements need manual review") });
    expect(outcome(report, "firm/accessibility-runtime/color-contrast").status).toBe("incomplete");
    expect(outcome(report, "firm/accessibility-runtime/image-alt").status).toBe("met");
  }, 60_000);

  it("reaches a state with declarative steps before checking it", async () => {
    const closed = await diagnose(request({ url: `${app.origin}/stateful`, state: "menu-closed" }));
    expect(closed.findings).toEqual([]);
    const open = await diagnose(request({ url: `${app.origin}/stateful`, state: "menu-open", steps: [{ action: "click", selector: "#open" }, { action: "waitFor", selector: "#menu button" }] }));
    expect(open.findings.map((finding) => [finding.rule, (finding.locations[0] as { state: string; target: string[] }).state, (finding.locations[0] as { target: string[] }).target])).toEqual([["button-name", "menu-open", [".icon"]]]);
  }, 60_000);

  it("isolates unreachable targets, errors, and timeouts from static providers", async () => {
    const closedPort = await freePort();
    const report = await diagnose(request(
      { url: `${app.origin}/violating`, state: "orders-loaded" },
      { url: `http://127.0.0.1:${closedPort}/`, state: "server-down" },
      { url: `${app.origin}/error`, state: "server-error" },
      { url: `${app.origin}/slow`, state: "hung" },
    ), [new AxeAdapter(), new EslintAdapter()]);
    const run = axeRun(report);
    expect(run.completeness).toBe("partial");
    expect(run.reason).toContain("[server-down] 1280x800: ");
    expect(run.reason).toContain("[server-error] 1280x800: The target answered HTTP 500");
    expect(run.reason).toMatch(/\[hung\] 1280x800: .*Timeout/);
    expect(run.testedScope).toEqual([`${app.origin}/violating [orders-loaded] 1280x800`]);
    expect(outcome(report, "firm/accessibility-runtime/image-alt").status).toBe("not_met");
    expect(outcome(report, "firm/accessibility-runtime/color-contrast").status).toBe("incomplete");
    expect(report.findings.some((finding) => finding.provider.id === "eslint" && finding.rule === "no-debugger")).toBe(true);
    expect(outcome(report, "firm/code/no-debugger").status).toBe("not_met");
  }, 90_000);

  it("reports a browser that cannot start or a page that crashes as incomplete rendered evidence", async () => {
    const report = await diagnose(request({ url: `${app.origin}/accessible`, state: "orders-loaded" }), [new AxeAdapter({ browsersPath: path.join(workspace, "no-browsers") })]);
    expect(axeRun(report)).toMatchObject({ completeness: "unavailable", reason: expect.stringContaining("The browser could not start") });
    expect(outcome(report, "firm/accessibility-runtime/button-name").status).toBe("incomplete");

    const crash = await scan({ targets: [{ url: "chrome://crash", route: null, state: "crashing", viewport: { width: 800, height: 600 }, steps: [], storageState: null }, { url: `${app.origin}/accessible`, route: null, state: "after-crash", viewport: { width: 800, height: 600 }, steps: [], storageState: null }], rules: ["button-name"], axeSourcePath: path.join(ROOT, "node_modules", "axe-core", "axe.min.js"), timeoutMs: 5_000 });
    expect(crash.targets.map((target) => [target.target.state, target.status])).toEqual([["crashing", "failed"], ["after-crash", "tested"]]);
  }, 60_000);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No free port");
  return address.port;
}
