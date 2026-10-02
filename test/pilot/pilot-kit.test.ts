import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosticsReport, PolicyPack } from "../../src/contracts/index.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const POLICY: PolicyPack = {
  schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version: "1.0.0", owner: "Fixture", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" },
  controls: [
    { id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], verification: [{ kind: "eslint", description: "Run no-debugger." }] },
    { id: "firm/code/no-console", title: "No console statements", rationale: "Noise", strength: "recommended", applicability: {}, evidence: [{ provider: "eslint", rule: "no-console", kind: "static", required: true }], verification: [{ kind: "eslint", description: "Run no-console." }] },
  ],
};

let workspace: string;
let app: string;
let pilot: string;
let bin: string;
let before: string[];
const listing = (root: string) => fs.readdirSync(root, { recursive: true }).map(String).sort();

beforeAll(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "web-doctor-pilot-")));
  app = path.join(workspace, "orders");
  pilot = path.join(workspace, "pilot");
  await materialize(app, {
    "package.json": '{"name":"orders","dependencies":{"react":"18.3.1"}}\n',
    "src/Pay.js": "export function pay() {\n  debugger;\n  // eslint-disable-next-line no-console -- kept while the gateway migrates\n  console.log(\"paid\");\n}\n",
  });
  const registry = (await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: [POLICY] })).root;
  bin = path.join(workspace, "web-doctor");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "dist", "cli.js")}" "$@"\n`, { mode: 0o755 });
  const record = (args: string[]) => execFileAsync(process.execPath, [path.join(ROOT, "scripts", "pilot-record.mjs"), "--pilot", pilot, "--app", "orders", "--", ...args], { cwd: app, env: { ...process.env, WEB_DOCTOR_BIN: bin, WEB_DOCTOR_REGISTRY_ROOT: registry } }).catch((error: { code?: number }) => error);
  before = listing(app);
  for (const args of [["check"], ["check"], ["context", "overview"]]) await record(args);
}, 120_000);

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

interface PilotSummary {
  latencyMs: Record<string, unknown>;
  providers: Record<string, unknown>;
  controls: { control: string }[];
  readinessReview: unknown;
  approvedWithoutMeetingCriteria: string[];
}

async function summarize(): Promise<PilotSummary> {
  const { stdout } = await execFileAsync(process.execPath, [path.join(ROOT, "scripts", "pilot-summary.mjs"), pilot]);
  return JSON.parse(stdout) as PilotSummary;
}

describe("advisory pilot kit", () => {
  it("records each run with its response and elapsed time, without changing the application", () => {
    const records = fs.readdirSync(path.join(pilot, "records")).map((file) => JSON.parse(fs.readFileSync(path.join(pilot, "records", file), "utf8")));
    expect(records).toHaveLength(3);
    for (const record of records) expect(record).toMatchObject({ schema: "web-doctor.pilot-record", app: "orders", elapsedMs: expect.any(Number), response: { schema: "web-doctor.mcp-response" } });
    expect(records.filter((record) => record.response.tool === "run_diagnostics").map((record) => record.exitCode)).toEqual([2, 2]);
    expect(listing(app)).toEqual(before);
  });

  it("summarizes latency, incomplete checks, suppressions, dispositions, tasks, and readiness", async () => {
    const report = JSON.parse(fs.readFileSync(path.join(pilot, "records", fs.readdirSync(path.join(pilot, "records")).sort()[0]!), "utf8")).response.data as DiagnosticsReport;
    const debuggerFinding = report.findings.find((finding) => finding.rule === "no-debugger")!;
    const consoleFinding = report.findings.find((finding) => finding.rule === "no-console");
    fs.writeFileSync(path.join(pilot, "dispositions.json"), JSON.stringify([{ fingerprint: debuggerFinding.fingerprint, verdict: "true_positive", reviewer: "pilot developer", reason: "Left in by mistake" }]));
    fs.writeFileSync(path.join(pilot, "tasks.json"), JSON.stringify([
      { id: "fix-debugger", actor: "developer", outcome: "success", tools: ["check", "explain"], notes: "Found and removed" },
      { id: "agent-upgrade-plan", actor: "agent", outcome: "partial", tools: ["plan_upgrade"], notes: "Needed a follow-up question" },
    ]));
    const summary = await summarize();
    expect(summary).toMatchObject({ records: 3, apps: ["orders"], findings: { disposed: 1 }, dispositions: { true_positive: 1, false_positive: 0 }, tasks: { total: 2, byActor: { developer: { success: 1 }, agent: { partial: 1 } } }, readinessReview: null });
    expect(summary.latencyMs.check).toMatchObject({ runs: 2, p50: expect.any(Number), p95: expect.any(Number) });
    expect(summary.providers.eslint).toMatchObject({ runs: 2, incomplete: 0 });
    expect(consoleFinding === undefined || consoleFinding.suppression !== null).toBe(true);
    const debuggerControl = summary.controls.find((entry) => entry.control === "firm/code/no-debugger");
    expect(debuggerControl).toMatchObject({ dispositions: 1, falsePositiveRate: 0, meetsCriteria: false, blockers: ["1 of 20 required dispositions"] });
  });

  it("flags a readiness review that approves gating for a Control that has not met the criteria", async () => {
    fs.writeFileSync(path.join(pilot, "readiness-review.json"), JSON.stringify({ heldOn: "2026-10-15", approvedBy: "Platform review", approvedForGating: [{ control: "firm/code/no-debugger", gate: "required" }] }));
    const summary = await summarize();
    expect(summary.readinessReview).toEqual({ heldOn: "2026-10-15", approvedBy: "Platform review", approvedForGating: ["firm/code/no-debugger"] });
    expect(summary.approvedWithoutMeetingCriteria).toEqual(["firm/code/no-debugger"]);
  });
});
