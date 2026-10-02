import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diagnosticsReportSchema, type DiagnosticsReport, type McpResponse, type PolicyPack } from "../../src/contracts/index.js";
import { runCli } from "../../src/cli-app.js";
import { decodeWindow, fitToBudget } from "../../src/core/budget.js";
import { redactText } from "../../src/core/redaction.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import { buildFinding } from "../../src/diagnostics/finding.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { connectClient } from "../support/mcp-client.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const SECRETS = [
  "sk_live_abcdefghijklmnop1234",
  "hunter2",
  "abc123secret",
  "npm_abcdefghijklmnopqrstuvwxyz0123456789",
  "iframe-secret-9876",
  "super-secret-env-value",
  "PROTECTED-MARKER",
  "OVERSIZED-MARKER-CONTENT",
];

const POLICY: PolicyPack = {
  schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version: "1.0.0", owner: "Fixture", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" },
  controls: [{ id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], remediation: "Remove the debugger statement.", verification: [{ kind: "eslint", description: "Run no-debugger." }] }],
};

const BUDGET = 12 * 1024;
let workspace: string;
let root: string;
let registry: string;
let core: WebDoctor;
let mcp: Awaited<ReturnType<typeof connectClient>>;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-budget-")));
  root = path.join(workspace, "app");
  const pages = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`src/pages/Page${String(index).padStart(2, "0")}.tsx`, `export function Page${index}() {\n  debugger;\n  return <section data-page="${index}" />;\n}\n`]));
  await materialize(root, {
    "package.json": `${JSON.stringify({
      name: "portal",
      private: true,
      packageManager: "npm@10.9.0",
      scripts: {
        test: "vitest run",
        deploy: "curl -H 'Authorization: Bearer sk_live_abcdefghijklmnop1234' https://deploy:hunter2@deploy.internal/release?token=abc123secret",
        "publish:ci": "NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789 npm publish",
      },
      dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
      devDependencies: { vitest: "3.2.4" },
    }, null, 2)}\n`,
    ".env": "API_KEY=super-secret-env-value\n",
    "web-doctor.config.json": `${JSON.stringify({ schema: "web-doctor.repository-config", schemaVersion: 1, protectedDirectories: ["fixtures-private"] })}\n`,
    "fixtures-private/secret.ts": 'export const marker = "PROTECTED-MARKER";\n',
    "src/Widget.tsx": 'export function Widget() {\n  return <iframe src="https://widgets.internal/embed?access_token=iframe-secret-9876" />;\n}\n',
    "src/generated/catalog.ts": `export const catalog = "OVERSIZED-MARKER-CONTENT${"x".repeat(1_100_000)}";\n`,
    ...pages,
  });
  registry = (await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: [POLICY] })).root;
  core = await WebDoctor.open({ cwd: root, caller: "mcp", registryRoot: registry, watch: false, budget: { maxBytes: BUDGET } });
  mcp = await connectClient(core);
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  await core?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
}

describe("sensitive-value redaction", () => {
  it("redacts credentials in shared facts, extension facts, and warnings, and says how many", async () => {
    const commands = await mcp.call("project_overview", { topic: "verification_commands" });
    const boundaries = await mcp.call("project_overview", { topic: "runtime_boundaries" });
    const text = JSON.stringify([commands, boundaries]);
    expectNoSecrets(text);
    expect(text).toContain("[redacted]");
    expect(boundaries.warnings.some((warning) => /^Redacted \d+ sensitive values?$/.test(warning))).toBe(true);
    const overview = await mcp.call("project_overview");
    expect(JSON.stringify(overview)).toContain("access_token=[redacted]");
  });

  it("never discloses excluded, protected, or oversized content, and marks what was skipped", async () => {
    const responses: McpResponse[] = [];
    for (const [tool, input] of [["project_overview", {}], ["explain_symbol", { symbol: "catalog" }], ["effective_guidance", {}], ["plan_verification", {}], ["plan_upgrade", { target: "19" }]] as const) responses.push(await mcp.call(tool, input));
    expectNoSecrets(JSON.stringify(responses));
    const overview = responses[0]!;
    // The sensitive .env file, the protected directory, and the oversized module are each skipped, never read.
    expect((overview.data as { summary: { skipped_inputs: number } }).summary.skipped_inputs).toBeGreaterThanOrEqual(3);
    expect(overview.complete).toBe(false);
  });

  it("redacts provider messages before a finding is identified", () => {
    const finding = buildFinding({
      provider: { id: "eslint", version: "9.39.5", engine: "eslint", engineVersion: "9.39.5", contribution: null }, rule: "no-restricted-syntax", evidenceKind: "static",
      locations: [{ kind: "source", path: "src/a.ts", line: 1, column: 1, endLine: 1, endColumn: 2 }], severity: "error", certainty: "observed", classification: "defect",
      message: "Hard-coded token ghp_abcdefghijklmnopqrstuvwxyz0123456789", completeness: "complete", original: { snippet: "const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'" },
    }, { obligations: [], registryDigest: "a".repeat(64), policyDigest: "a".repeat(64) });
    expect(JSON.stringify(finding)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(finding.message).toBe("Hard-coded token [redacted]");
    expect(redactText("vitest run --coverage").count).toBe(0);
  });
});

describe("response budgets", () => {
  it("windows oversized diagnostics deterministically and pages through every finding with continuations", async () => {
    const { report: full } = await core.diagnose();
    expect(full.findings).toHaveLength(60);
    const seen: string[] = [];
    let continuation: string | undefined;
    let pages = 0;
    do {
      const response = await mcp.call("run_diagnostics", continuation === undefined ? {} : { continuation });
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(BUDGET);
      expect(response.complete).toBe(false);
      expect(response.warnings.some((warning) => warning.startsWith(`Response budget of ${BUDGET} bytes: data.findings items ${seen.length + 1}-`))).toBe(true);
      const page = diagnosticsReportSchema.parse(response.data);
      expect(page.digest).toBe(full.digest);
      seen.push(...page.findings.map((finding) => finding.id));
      continuation = response.continuationToken;
      expect(response.truncated).toBe(continuation !== undefined);
      pages += 1;
    } while (continuation !== undefined && pages < 100);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(full.findings.map((finding) => finding.id));
  });

  it("returns identical pages from the CLI and MCP and refuses a continuation from another request", async () => {
    const first = await mcp.call("run_diagnostics");
    let stdout = "";
    const exitCode = await runCli(["check", "--json", "--continuation", first.continuationToken!], { stdout: (text) => { stdout += text; }, stderr: (text) => { stdout += text; } }, { cwd: root, env: { WEB_DOCTOR_REGISTRY_ROOT: registry, WEB_DOCTOR_RESPONSE_BUDGET: String(BUDGET) } });
    expect(exitCode).toBe(2);
    const fromCli = JSON.parse(stdout) as McpResponse;
    const fromMcp = await mcp.call("run_diagnostics", { continuation: first.continuationToken! });
    expect(fromCli.data).toEqual(fromMcp.data);
    expect(() => decodeWindow(first.continuationToken!, "req_other")).toThrow(/different request or project state/);
    const foreign = await mcp.client.callTool({ name: "run_diagnostics", arguments: { scope: "files", files: ["src/pages/Page00.tsx"], continuation: first.continuationToken! } });
    expect(foreign.isError).toBe(true);
  }, 60_000);

  it("reduces an oversized context page so the query's own continuation reaches every item", async () => {
    const all: string[] = [];
    let continuation: string | undefined;
    let total = 0;
    do {
      const response = await mcp.call("explain_symbol", { symbol: "Page0", aspect: "usages", limit: 500, ...(continuation === undefined ? {} : { continuation }) });
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(BUDGET);
      const data = response.data as { items: unknown[]; page: { total: number } };
      all.push(...data.items.map((item) => JSON.stringify(item)));
      total = data.page.total;
      continuation = response.continuationToken;
    } while (continuation !== undefined);
    expect(all).toHaveLength(total);
    const overview = await mcp.call("project_overview", { limit: 500 });
    expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThanOrEqual(BUDGET);
  });

  it("writes the complete, redacted report only where the CLI is asked to", async () => {
    const archive = path.join(workspace, "archive.json");
    await runCli(["check", "--report", archive, "--json"], { stdout: () => {}, stderr: () => {} }, { cwd: root, env: { WEB_DOCTOR_REGISTRY_ROOT: registry } });
    const text = await fs.readFile(archive, "utf8");
    expectNoSecrets(text);
    const report = diagnosticsReportSchema.parse(JSON.parse(text)) as DiagnosticsReport;
    expect(report.findings).toHaveLength(60);
  }, 60_000);

  it("cuts inside a single oversized item and never hides that it did", () => {
    const data = { items: [{ nested: Array.from({ length: 400 }, (_, index) => `entry-${index}-${"y".repeat(40)}`), note: "z".repeat(10_000) }] };
    const result = fitToBudget(data, (candidate) => Buffer.byteLength(JSON.stringify(candidate)), { maxBytes: 8 * 1024 });
    expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThanOrEqual(8 * 1024);
    expect(result.window).toMatchObject({ path: ["items", "0", "nested"], offset: 0, total: 400 });
    expect(result.reductions).toEqual(["1 strings longer than 2048 characters were cut"]);
  });
});
