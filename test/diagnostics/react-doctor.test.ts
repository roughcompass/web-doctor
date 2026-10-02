import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpResponseSchema, normalizedFindingSchema, parseContract, type DiagnosticsReport, type PolicyPack, type ProviderApproval, type ProviderManifest } from "../../src/contracts/index.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import { EslintAdapter } from "../../src/diagnostics/eslint-adapter.js";
import { loadProviderApproval } from "../../src/diagnostics/provider-approval.js";
import { FULL_SCOPE, controlLayers, runDiagnostics, type ProviderAdapter } from "../../src/diagnostics/providers.js";
import { ReactDoctorAdapter } from "../../src/diagnostics/react-doctor-adapter.js";
import { contentDigest } from "../../src/facts/repo-facts-release.js";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { connectClient } from "../support/mcp-client.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const EXAMPLE = path.join(ROOT, "examples", "react-doctor-provider");

const STATIC: PolicyPack = {
  schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version: "1.0.0", owner: "Fixture", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" },
  controls: [{ id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], verification: [{ kind: "eslint", description: "Run no-debugger." }] }],
};

const APP = {
  "package.json": `${JSON.stringify({ name: "orders", private: true, type: "module", dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }, null, 2)}\n`,
  "src/Orders.jsx": [
    "export const PAGE_SIZE = 20;",
    "",
    "export function Orders({ orders }) {",
    "  debugger;",
    "  function Row({ order }) {",
    "    return <li>{order.id}</li>;",
    "  }",
    "  return <ul>{orders.map((order, index) => <Row key={index} order={order} />)}</ul>;",
    "}",
    "",
  ].join("\n"),
};

let workspace: string;
let registry: Awaited<ReturnType<typeof writeEmbeddedRegistry>>;
let staticOnly: Awaited<ReturnType<typeof writeEmbeddedRegistry>>;
let manifest: ProviderManifest;
let approval: ProviderApproval;
let app: string;
let snapshot: ProjectSnapshot;
let analyzer: SharedFactsAnalyzer;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-react-doctor-")));
  manifest = JSON.parse(await fs.readFile(path.join(EXAMPLE, "provider.json"), "utf8")) as ProviderManifest;
  const policy = JSON.parse(await fs.readFile(path.join(EXAMPLE, "policy.json"), "utf8")) as PolicyPack;
  registry = await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: [policy, STATIC], providers: [{ manifest, artifacts: { "rules.json": await fs.readFile(path.join(EXAMPLE, "rules.json"), "utf8") } }] });
  staticOnly = await writeEmbeddedRegistry(path.join(workspace, "registry-static"), { policies: [STATIC] });
  approval = (await loadProviderApproval("react-doctor"))!;
  app = path.join(workspace, "app");
  await materialize(app, APP);
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
  snapshot = await analyzeProject({ root: app, repositoryRoot: app, analyzer });
}, 120_000);

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function diagnose(adapters: ProviderAdapter[], options: { root?: string; snapshot?: ProjectSnapshot } = {}): Promise<DiagnosticsReport> {
  const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry: registry.snapshot, facts: { capabilities: { react: "18.3.1" } } }) });
  return runDiagnostics({
    policy,
    layers: controlLayers(registry.snapshot),
    context: { root: options.root ?? app, repositoryRoot: null, registryRoot: registry.root, registry: registry.snapshot, providerContributions: { "react-doctor": "react-doctor" }, snapshot: options.snapshot ?? snapshot, scope: FULL_SCOPE },
    adapters,
    gate: "required",
    mode: "ci",
  });
}

const run = (report: DiagnosticsReport) => report.runs.find((entry) => entry.provider === "react-doctor")!;

/** A stand-in React Doctor package whose scan command behaves as `body` says, approved by digest like the real one. */
async function fakeReactDoctor(name: string, body: string): Promise<{ packageRoot: string; approval: ProviderApproval }> {
  const packageRoot = path.join(workspace, name, "node_modules", "react-doctor");
  await materialize(packageRoot, {
    "package.json": `${JSON.stringify({ name: "react-doctor", version: "0.9.14", type: "module" })}\n`,
    "bin/react-doctor.js": `import fs from "node:fs";\nconst args = process.argv.slice(2);\nconst out = args[args.indexOf("--json-out") + 1];\n${body}\n`,
  });
  return { packageRoot, approval: { ...approval, releases: [{ ...approval.releases[0]!, contentDigest: await contentDigest(packageRoot) }] } };
}

describe("React Doctor adapter", () => {
  it("normalizes supported output with React Doctor provenance and only the rules policy selects", async () => {
    const report = await diagnose([new EslintAdapter(), new ReactDoctorAdapter()]);
    expect(run(report)).toMatchObject({ completeness: "complete", engineVersion: "0.9.14", reason: null, capabilities: ["filesystem-read", "process-spawn"], denied: [] });
    const findings = report.findings.filter((finding) => finding.provider.id === "react-doctor");
    expect(findings.map((finding) => [finding.rule, finding.locations[0]!.kind === "source" ? `${finding.locations[0]!.path}:${finding.locations[0]!.line}` : "", finding.controls]).sort()).toEqual([
      ["no-array-index-as-key", "src/Orders.jsx:8", ["platform/react-quality/stable-keys"]],
      ["no-unstable-nested-components", "src/Orders.jsx:5", ["platform/react-quality/nested-components"]],
    ].sort());
    for (const finding of findings) {
      expect(finding.provider).toEqual({ id: "react-doctor", version: "1.0.0", engine: "react-doctor", engineVersion: "0.9.14", contribution: "react-doctor" });
      expect(normalizedFindingSchema.parse(finding)).toEqual(finding);
    }
    expect(report.findings.some((finding) => finding.provider.id === "eslint" && finding.rule === "no-debugger")).toBe(true);
    expect(report.controls.find((outcome) => outcome.control === "platform/react-quality/rules-of-hooks")).toMatchObject({ status: "met" });
  }, 120_000);

  it("leaves the application untouched and never creates React Doctor state inside it", async () => {
    const digest = async () => {
      const hash = crypto.createHash("sha256");
      for (const entry of (await fs.readdir(app, { recursive: true, withFileTypes: true })).sort((left, right) => (path.join(left.parentPath, left.name) < path.join(right.parentPath, right.name) ? -1 : 1))) {
        const full = path.join(entry.parentPath, entry.name);
        hash.update(full);
        if (entry.isFile()) hash.update(await fs.readFile(full));
      }
      return hash.digest("hex");
    };
    const before = await digest();
    await diagnose([new ReactDoctorAdapter()]);
    expect(await digest()).toBe(before);
    await expect(fs.access(path.join(app, ".react-doctor"))).rejects.toThrow();
  }, 120_000);

  it("reports an unsupported output schema or version as unavailable instead of reinterpreting it", async () => {
    const schema = await fakeReactDoctor("schema", "fs.writeFileSync(out, JSON.stringify({ schemaVersion: 99, version: \"0.9.14\", ok: true, diagnostics: [], projects: [], error: null }));");
    expect(run(await diagnose([new ReactDoctorAdapter(schema)]))).toMatchObject({ completeness: "unavailable", reason: "React Doctor report schema 99 is not supported; the approved release reports schema 3" });
    const shape = await fakeReactDoctor("shape", "fs.writeFileSync(out, JSON.stringify({ schemaVersion: 3, version: \"0.9.14\", ok: true, diagnostics: [{ file: \"a.js\" }], projects: [], error: null }));");
    expect(run(await diagnose([new ReactDoctorAdapter(shape)])).reason).toMatch(/^React Doctor report does not match schema 3: diagnostics\.0\./);
    const failed = await fakeReactDoctor("failed", "fs.writeFileSync(out, JSON.stringify({ schemaVersion: 3, version: \"0.9.14\", ok: false, diagnostics: [], projects: [], error: { message: \"parser crashed\" } }));");
    expect(run(await diagnose([new ReactDoctorAdapter(failed)])).reason).toBe("React Doctor failed: parser crashed");
    const silent = await fakeReactDoctor("silent", "process.exit(2);");
    expect(run(await diagnose([new ReactDoctorAdapter(silent)])).reason).toBe("React Doctor failed: React Doctor wrote no report (exit code 2)");
  }, 120_000);

  it("stops a React Doctor run that exceeds its time budget", async () => {
    const hang = await fakeReactDoctor("hang", "setInterval(() => {}, 1000);");
    const report = await diagnose([new EslintAdapter(), new ReactDoctorAdapter({ ...hang, limits: { timeoutMs: 1_500, memoryMb: 256, outputBytes: 1_000_000 } })]);
    expect(run(report)).toMatchObject({ completeness: "unavailable", reason: "React Doctor timeout: The provider did not finish within 1500 ms" });
    expect(report.findings.some((finding) => finding.rule === "no-debugger")).toBe(true);
    expect(report.controls.find((outcome) => outcome.control === "platform/react-quality/rules-of-hooks")!.status).toBe("incomplete");
  }, 60_000);

  it("denies network access and records the attempt even when React Doctor swallows the refusal", async () => {
    const phoning = await fakeReactDoctor("network", "try { await fetch(\"https://www.react.doctor/api/score\"); } catch {}\ntry { (await import(\"node:https\")).request(\"https://firewall-api.socket.dev/purl\"); } catch {}\nfs.writeFileSync(out, JSON.stringify({ schemaVersion: 3, version: \"0.9.14\", ok: true, diagnostics: [], projects: [{ directory: \".\", complete: true, skippedChecks: [] }], error: null }));");
    expect(run(await diagnose([new ReactDoctorAdapter(phoning)]))).toMatchObject({ completeness: "complete", denied: ["network"] });
  }, 60_000);

  it("runs only the invocation the security review approved, with telemetry, scoring, and supply-chain lookups off", () => {
    const { arguments: args, environment, network } = approval.security.configuration;
    expect(network).toBe(false);
    for (const flag of ["--json", "--no-telemetry", "--no-supply-chain", "--no-cache"]) expect(args).toContain(flag);
    for (const forbidden of ["--no-respect-inline-disables", "--supply-chain", "--score", "--debug", "install", "ci", "scan"]) expect(args).not.toContain(forbidden);
    expect(Object.keys(environment).sort()).toEqual(["HOME", "NO_COLOR", "REACT_DOCTOR_CACHE_DIR", "REACT_DOCTOR_CONFIG_DIR", "REACT_DOCTOR_NO_CACHE"]);
    expect(Object.values(environment).filter((value) => value.startsWith("/")).length).toBe(0);
  });

  it("guards the child Node processes React Doctor starts, such as its linter", async () => {
    const spawning = await fakeReactDoctor("child", "const { spawnSync } = await import(\"node:child_process\");\nspawnSync(process.execPath, [\"-e\", \"fetch('https://api.axiom.co/v1/datasets').catch(() => {})\"], { stdio: \"inherit\" });\nfs.writeFileSync(out, JSON.stringify({ schemaVersion: 3, version: \"0.9.14\", ok: true, diagnostics: [], projects: [{ directory: \".\", complete: true, skippedChecks: [] }], error: null }));");
    expect(run(await diagnose([new ReactDoctorAdapter(spawning)]))).toMatchObject({ completeness: "complete", denied: ["network"] });
  }, 60_000);

  it("keeps every other provider operational when React Doctor is absent, unapproved, or tampered with", async () => {
    const absent = await diagnose([new EslintAdapter(), new ReactDoctorAdapter({ packageRoot: null })]);
    expect(run(absent)).toMatchObject({ completeness: "unavailable", reason: "React Doctor is not installed; it is an optional dependency of Web Doctor" });
    expect(absent.findings.map((finding) => finding.rule)).toEqual(["no-debugger"]);
    expect(run(await diagnose([new ReactDoctorAdapter({ approval: null })])).reason).toBe("react-doctor has no recorded legal and security approval");
    expect(run(await diagnose([new ReactDoctorAdapter({ approval: { ...approval, legal: { ...approval.legal, status: "rejected" } } })])).reason).toBe("react-doctor is not legally approved");
    const tampered = await fakeReactDoctor("tampered", "");
    expect(run(await diagnose([new ReactDoctorAdapter({ packageRoot: tampered.packageRoot })])).reason).toBe("Installed React Doctor 0.9.14 files differ from the approved release");
  }, 120_000);

  it("refuses applications whose React Doctor configuration would run code or restore files", async () => {
    const configured = path.join(workspace, "configured");
    await materialize(configured, { ...APP, "doctor.config.ts": "export default { rules: {} };\n" });
    const configuredSnapshot = await analyzeProject({ root: configured, repositoryRoot: configured, analyzer });
    expect(run(await diagnose([new ReactDoctorAdapter()], { root: configured, snapshot: configuredSnapshot })).reason).toBe("React Doctor would run the application's executable configuration (doctor.config.ts); use doctor.config.json instead");
    const interrupted = path.join(workspace, "interrupted");
    await materialize(interrupted, { ...APP, ".react-doctor/audit-backups/src/Orders.jsx": APP["src/Orders.jsx"] });
    const interruptedSnapshot = await analyzeProject({ root: interrupted, repositoryRoot: interrupted, analyzer });
    expect(run(await diagnose([new ReactDoctorAdapter()], { root: interrupted, snapshot: interruptedSnapshot })).reason).toBe("React Doctor left audit backups in .react-doctor/audit-backups; restore or remove them before running it");
  }, 120_000);

  it("changes no MCP or finding contract whether React Doctor is enabled or removed", async () => {
    const responses: Record<string, { tools: string[]; findings: DiagnosticsReport["findings"] }> = {};
    for (const [label, registryRoot] of [["enabled", registry.root], ["removed", staticOnly.root]] as const) {
      const core = await WebDoctor.open({ cwd: app, caller: "mcp", registryRoot, watch: false, analyzer });
      const mcp = await connectClient(core);
      try {
        const response = await mcp.call("run_diagnostics");
        expect(mcpResponseSchema.parse(response), label).toEqual(response);
        const report = response.data as DiagnosticsReport;
        for (const finding of report.findings) expect(parseContract("normalizedFinding", finding), label).toEqual(finding);
        responses[label] = { tools: (await mcp.client.listTools()).tools.map((tool) => tool.name).sort(), findings: report.findings };
      } finally {
        await mcp.close();
        await core.close();
      }
    }
    expect(responses.enabled!.tools).toEqual(responses.removed!.tools);
    expect(responses.enabled!.findings.some((finding) => finding.provider.engine === "react-doctor")).toBe(true);
    const eslint = (label: string) => responses[label]!.findings.filter((finding) => finding.provider.id === "eslint").map((finding) => finding.fingerprint);
    expect(eslint("enabled")).toEqual(eslint("removed"));
  }, 180_000);
});
