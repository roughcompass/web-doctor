import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DETECTOR_RELEASE } from "@repo-facts/bundle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diagnosticsReportSchema, mcpResponseSchema, type DiagnosticsReport, type McpResponse, type PolicyPack } from "../../src/contracts/index.js";
import { runCli } from "../../src/cli-app.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import type { UpgradePlan } from "../../src/guidance/upgrade.js";
import type { VerificationPlan } from "../../src/guidance/verification.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { connectClient } from "../support/mcp-client.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const execFileAsync = promisify(execFile);
const verification = [{ kind: "eslint", description: "Run the rule on the changed files." }];

function pack(id: string, layer: PolicyPack["layer"], controls: PolicyPack["controls"]): PolicyPack {
  return { schema: "web-doctor.policy-pack", schemaVersion: 2, id, version: "1.0.0", owner: "Fixture", layer, compatibility: { webDoctor: ">=0.1.0" }, controls };
}

const POLICIES: PolicyPack[] = [
  pack("firm/code", "firmwide", [{ id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt production pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], remediation: "Remove the debugger statement.", verification }]),
  pack("firm/accessibility", "firmwide", [{ id: "firm/accessibility/button-name", title: "Buttons have accessible names", rationale: "Names", strength: "required", applicability: {}, evidence: [{ provider: "axe", rule: "button-name", kind: "rendered", required: true }, { provider: "screen-reader", kind: "manual", required: true }], verification: [{ kind: "screen-reader", description: "Announce each button with a screen reader." }], exceptionPolicy: "accessibility-review" }]),
  pack("application/engineering", "application", [{ id: "application/engineering/no-console", title: "No console statements", rationale: "Noise", strength: "recommended", applicability: { files: { include: ["src/**"] } }, evidence: [{ provider: "eslint", rule: "no-console", kind: "static", required: true }], remediation: "Use the application logger.", verification: [...verification, { kind: "test", description: "Run the component tests for the changed components." }] }]),
];

const APP = {
  "package.json": `${JSON.stringify({ name: "orders", private: true, packageManager: "npm@10.9.0", scripts: { test: "vitest run", typecheck: "tsc --noEmit" }, dependencies: { react: "18.3.1", "react-dom": "18.3.1" }, devDependencies: { vitest: "3.2.4", typescript: "5.9.3" } }, null, 2)}\n`,
  "package-lock.json": `${JSON.stringify({ name: "orders", lockfileVersion: 3, packages: { "": { name: "orders" }, "node_modules/react": { version: "18.3.1" }, "node_modules/react-dom": { version: "18.3.1" }, "node_modules/typescript": { version: "5.9.3", dev: true }, "node_modules/vitest": { version: "3.2.4", dev: true } } }, null, 2)}\n`,
  "src/Orders.tsx": "export function Orders() {\n  console.log(\"orders\");\n  return <table />;\n}\n",
  "src/Pay.tsx": "export function Pay() {\n  debugger;\n  return <form />;\n}\n",
  "src/Orders.test.tsx": 'import { test } from "vitest";\nimport { Orders } from "./Orders";\n\ntest("renders", () => {\n  Orders();\n});\n',
};

let workspace: string;
let root: string;
let registry: string;
let core: WebDoctor;
let mcp: Awaited<ReturnType<typeof connectClient>>;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-diagnostics-surfaces-")));
  root = path.join(workspace, "app");
  await materialize(root, APP);
  registry = (await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: POLICIES, portals: [{ id: "wealth", lifecycle: "active" }] })).root;
  core = await WebDoctor.open({ cwd: root, caller: "mcp", registryRoot: registry, watch: false });
  mcp = await connectClient(core);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  await core?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function cli(args: string[], cwd = root): Promise<{ exitCode: number; response: McpResponse; stdout: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli([...args, "--json"], { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } }, { cwd, env: { WEB_DOCTOR_REGISTRY_ROOT: registry } });
  if (stderr !== "") throw new Error(stderr);
  return { exitCode, response: mcpResponseSchema.parse(JSON.parse(stdout)), stdout };
}

async function human(args: string[], cwd = root): Promise<{ exitCode: number; stdout: string }> {
  let stdout = "";
  const exitCode = await runCli(args, { stdout: (text) => { stdout += text; }, stderr: (text) => { stdout += text; } }, { cwd, env: { WEB_DOCTOR_REGISTRY_ROOT: registry } });
  return { exitCode, stdout };
}

describe("diagnostics through the shared core", () => {
  it("returns equivalent normalized findings and both provenance chains from the CLI and the MCP server", async () => {
    const fromCli = await cli(["check"]);
    const fromMcp = await mcp.call("run_diagnostics");
    expect(fromCli.response).toEqual(fromMcp);
    const report = diagnosticsReportSchema.parse(fromMcp.data);
    expect(report.findings.map((finding) => `${finding.rule} ${finding.locations[0]!.kind === "source" ? finding.locations[0]!.path : ""} ${finding.controls.join(",")}`).sort()).toEqual([
      "no-console src/Orders.tsx application/engineering/no-console",
      "no-debugger src/Pay.tsx firm/code/no-debugger",
    ]);
    expect(fromMcp.provenance).toMatchObject({
      repoFacts: { status: "complete", release: DETECTOR_RELEASE, configurationDigest: expect.stringMatching(/^[0-9a-f]{64}$/), factDocumentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      extensions: { stateDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      policy: { digest: report.policyDigest },
      webDoctor: { registryDigest: report.registryDigest },
    });
    expect(fromMcp.schemaVersion).toBe(2);
    expect(report.schemaVersion).toBe(1);
    expect(fromCli.exitCode).toBe(2);
    expect(fromMcp.warnings).toContain("axe evidence is unavailable: Provider axe is not in the approved catalog");
  });

  it("explains a finding identically from a report file and from the MCP server's last run", async () => {
    const { response, stdout } = await cli(["check"]);
    const report = response.data as DiagnosticsReport;
    const finding = report.findings.find((candidate) => candidate.rule === "no-debugger")!;
    await fs.writeFile(path.join(workspace, "report.json"), stdout);
    await mcp.call("run_diagnostics");
    const fromCli = await cli(["explain", "finding", finding.id, "--report", path.join(workspace, "report.json")]);
    const fromMcp = await mcp.call("explain_finding", { finding: finding.id });
    expect(fromCli.response).toEqual(fromMcp);
    const data = fromMcp.data as { finding: { id: string }; recommendation: { status: string; generic: { remediation: string[] } }; verification: VerificationPlan; modifiesProject: boolean };
    expect(data.finding.id).toBe(finding.id);
    expect(data.recommendation).toMatchObject({ status: "generic", generic: { remediation: ["Remove the debugger statement."] } });
    expect(data.verification.controls.map((control) => [control.control, control.status])).toEqual([["firm/code/no-debugger", "failed"]]);
    expect(data.modifiesProject).toBe(false);
  });

  it("explains a Control, including one that is not effective", async () => {
    const fromCli = await cli(["explain", "control", "firm/accessibility/button-name"]);
    const fromMcp = await mcp.call("explain_finding", { control: "firm/accessibility/button-name" });
    expect(fromCli.response.data).toMatchObject({ effective: true, layer: "firmwide", policy: { id: "firm/accessibility" } });
    expect((fromMcp.data as { verification: VerificationPlan }).verification.controls[0]).toMatchObject({ control: "firm/accessibility/button-name", status: "remaining", requires: ["manual", "rendered"] });
  });

  it("plans upgrades and verification identically from both surfaces", async () => {
    const upgradeCli = await cli(["plan", "upgrade", "react", "19"]);
    const upgradeMcp = await mcp.call("plan_upgrade", { package: "react", target: "19" });
    expect(upgradeCli.response).toEqual(upgradeMcp);
    expect((upgradeMcp.data as UpgradePlan).stages.map((stage) => stage.id)).toEqual(["react-19.0.0"]);
    expect((upgradeMcp.data as UpgradePlan).stages[0]!.verification.map((step) => step.command)).toEqual(["npm install react@19.0.0 react-dom@19.0.0", "npm run typecheck", "npm run test"]);

    const verifyCli = await cli(["plan", "verification", "--file", "src/Orders.tsx"]);
    const verifyMcp = await mcp.call("plan_verification", { files: ["src/Orders.tsx"] });
    expect(verifyCli.response.provenance).toEqual(verifyMcp.provenance);
    const plan = verifyMcp.data as VerificationPlan;
    expect(plan.items.find((item) => item.type === "component-test")).toMatchObject({ targets: ["src/Orders.test.tsx"], command: "npm run test" });
  });

  it("names the upgrade command without changing the installation", async () => {
    const { exitCode, response } = await cli(["update", "status"]);
    expect(exitCode).toBe(0);
    expect(response.data).toMatchObject({ status: "unknown", reason: "Enterprise package distribution is not configured" });
    const applied = await cli(["update"]);
    expect(applied.exitCode).toBe(1);
    expect(applied.response.data).toMatchObject({ outcome: { status: "unknown" } });
  });

  it("prints human output with the gate, Control outcomes, and provenance", async () => {
    const { exitCode, stdout } = await human(["check"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Diagnostics fail (gate required, exit 2); scope full");
    expect(stdout).toMatch(/error src\/Pay\.tsx:2:3 eslint\/no-debugger/);
    expect(stdout).toContain("control firm/accessibility/button-name incomplete");
    expect(stdout).toMatch(/Web Doctor \S+ registry [0-9a-f]{12}; repo-facts \S+ complete facts [0-9a-f]{12}; extensions [0-9a-f]{12}/);
  });
});

describe("human output", () => {
  it("renders every product command with its provenance line", async () => {
    const provenance = /Web Doctor \S+ registry [0-9a-f]{12}; repo-facts \S+ complete facts [0-9a-f]{12}; extensions [0-9a-f]{12}/;
    const { response } = await cli(["check"]);
    const finding = (response.data as DiagnosticsReport).findings.find((candidate) => candidate.rule === "no-debugger")!;
    const cases: [string[], number, string][] = [
      [["explain", "finding", finding.id], 0, "Recommendation (generic): No effective Control of this finding supplies an approved pattern"],
      [["explain", "control", "firm/code/no-debugger"], 0, "required firmwide firm/code/no-debugger: No debugger statements"],
      [["plan", "upgrade", "19"], 0, "Upgrade react 18.3.1 to 19.0.0: planned"],
      [["plan", "verification", "--file", "src/Orders.tsx"], 0, "todo component-test: Run the component tests for the changed components. [npm run test]"],
      [["update", "status"], 0, "Web Doctor 0.1.0: unknown"],
      [["policy", "effective"], 0, "Effective policy "],
    ];
    for (const [args, code, text] of cases) {
      const output = await human(args);
      expect(output.exitCode, args.join(" ")).toBe(code);
      expect(output.stdout, args.join(" ")).toContain(text);
      expect(output.stdout, args.join(" ")).toMatch(args[0] === "update" ? /Web Doctor \S+ registry [0-9a-f]{12}; repo-facts \S+ not used/ : provenance);
      expect(output.stdout, args.join(" ")).not.toContain("No project was analyzed");
    }
  });

  it("reports usage errors with exit 64", async () => {
    expect((await human(["check", "--changed", "HEAD", "--file", "src/Pay.tsx"])).exitCode).toBe(64);
    expect((await human(["explain", "widget", "x"])).exitCode).toBe(64);
    expect((await human(["plan", "verification", "--profile", "p.json"])).exitCode).toBe(64);
    expect((await human(["check", "--gate", "mandatory"])).exitCode).toBe(64);
  });
});

describe("changed-file and CI gates", () => {
  async function project(files: Record<string, string>, config?: object): Promise<string> {
    const directory = path.join(workspace, `gate-${Math.random().toString(16).slice(2)}`);
    await materialize(directory, { ...files, ...(config === undefined ? {} : { "web-doctor.config.json": `${JSON.stringify({ schema: "web-doctor.repository-config", schemaVersion: 1, ...config })}\n` }) });
    return directory;
  }
  const clean = { "package.json": APP["package.json"], "src/Orders.tsx": "export function Orders() {\n  return <table />;\n}\n" };

  it("passes a clean project locally while reporting incomplete required evidence as advisory", async () => {
    const directory = await project(clean);
    const { exitCode, response } = await cli(["check"], directory);
    expect(exitCode).toBe(0);
    expect((response.data as DiagnosticsReport).gate).toMatchObject({ status: "pass", reasons: ["firm/accessibility/button-name lacks complete required evidence"] });
    expect(response.complete).toBe(false);
  });

  it("fails CI on incomplete required evidence with exit 4", async () => {
    const directory = await project(clean, { portals: ["wealth"] });
    const { exitCode, response } = await cli(["check", "--ci"], directory);
    expect(exitCode).toBe(4);
    expect((response.data as DiagnosticsReport).gate.status).toBe("incomplete");
  });

  it("gates CI by Control strength: a recommended finding passes the required gate and fails the recommended gate", async () => {
    const exception = { controlId: "firm/accessibility/button-name", exceptionId: "exception/rendered-later", authorization: "accessibility-review" };
    const directory = await project({ ...clean, "src/Orders.tsx": APP["src/Orders.tsx"] }, { portals: ["wealth"], exceptions: [exception], ci: { gate: "required", requirePortal: true } });
    const required = await cli(["check", "--ci"], directory);
    expect(required.exitCode).toBe(0);
    expect((required.response.data as DiagnosticsReport).findings.map((finding) => finding.rule)).toEqual(["no-console"]);
    expect((required.response.data as DiagnosticsReport).gate).toEqual({ level: "required", status: "pass", exitCode: 0, reasons: [] });
    const recommended = await cli(["check", "--ci", "--gate", "recommended"], directory);
    expect(recommended.exitCode).toBe(2);
    expect((recommended.response.data as DiagnosticsReport).gate.reasons).toEqual(["application/engineering/no-console has 1 introduced findings"]);
  });

  it("fails on a required finding with exit 2 and a structured report", async () => {
    const directory = await project({ ...clean, "src/Pay.tsx": APP["src/Pay.tsx"] }, { portals: ["wealth"] });
    const { exitCode, response } = await cli(["check", "--ci"], directory);
    expect(exitCode).toBe(2);
    const report = response.data as DiagnosticsReport;
    expect(report.gate.reasons).toEqual(["firm/code/no-debugger has 1 introduced findings"]);
    expect(report.findings[0]!.policyDigest).toBe(response.provenance.policy!.digest);
  });

  it("reports a portal conflict with exit 3", async () => {
    const directory = await project(clean, { portals: ["wealth"] });
    const { exitCode, response } = await cli(["check", "--ci", "--portal", "retail"], directory);
    expect(exitCode).toBe(3);
    expect((response.data as DiagnosticsReport).gate.status).toBe("conflict");
  });

  it("checks only changed files and names the checks that need a full run", async () => {
    const directory = await project({ ...clean, "src/Pay.tsx": APP["src/Pay.tsx"] });
    const git = (...args: string[]) => execFileAsync("git", ["-c", "user.email=ci@example.com", "-c", "user.name=CI", ...args], { cwd: directory });
    await git("init", "-q");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await fs.writeFile(path.join(directory, "src/Orders.tsx"), "export function Orders() {\n  debugger;\n  return <table />;\n}\n");
    const { exitCode, response } = await cli(["check", "--changed", "HEAD"], directory);
    const report = response.data as DiagnosticsReport;
    expect(report.scope).toMatchObject({ mode: "changed-files", files: ["src/Orders.tsx"] });
    expect(report.findings.map((finding) => finding.locations[0]!.kind === "source" ? finding.locations[0]!.path : "")).toEqual(["src/Orders.tsx"]);
    expect(exitCode).toBe(2);
  });
});
