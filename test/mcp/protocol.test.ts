import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DETECTOR_RELEASE } from "@repo-facts/bundle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diagnosticsReportSchema, mcpResponseSchema, type McpResponse, type PolicyPack } from "../../src/contracts/index.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import type { UpgradePlan } from "../../src/guidance/upgrade.js";
import { WEB_DOCTOR_VERSION } from "../../src/version.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { connectClient } from "../support/mcp-client.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const POLICY: PolicyPack = {
  schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version: "1.0.0", owner: "Fixture", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" },
  controls: [{ id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], remediation: "Remove the debugger statement.", verification: [{ kind: "eslint", description: "Run no-debugger." }] }],
};

const TOOLS = ["build_provenance", "effective_guidance", "explain_finding", "explain_symbol", "plan_upgrade", "plan_verification", "project_overview", "run_diagnostics", "update_status"];

let workspace: string;
let root: string;
let core: WebDoctor;
let mcp: Awaited<ReturnType<typeof connectClient>>;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-mcp-protocol-")));
  root = path.join(workspace, "app");
  await materialize(root, {
    "package.json": `${JSON.stringify({ name: "orders", private: true, packageManager: "npm@10.9.0", scripts: { test: "vitest run" }, dependencies: { react: "18.3.1", "react-dom": "18.3.1" }, devDependencies: { "web-doctor": "0.1.0", vitest: "3.2.4" } }, null, 2)}\n`,
    "src/Pay.tsx": "export function Pay() {\n  debugger;\n  return <form />;\n}\n",
    ".github/workflows/ci.yml": "jobs:\n  test:\n    steps: [ { run: npm test\n",
  });
  const registry = (await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: [POLICY] })).root;
  core = await WebDoctor.open({
    cwd: root,
    caller: "mcp",
    registryRoot: registry,
    watch: false,
    update: { distribution: { packageName: "web-doctor", registry: "https://npm.internal.example/" }, installationMode: "project-exact", lookup: async () => "99.0.0" },
  });
  mcp = await connectClient(core);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  await core?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("MCP protocol", () => {
  it("lists every question-oriented tool with input and output schemas and read-only annotations", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    const diagnostics = tools.find((tool) => tool.name === "run_diagnostics")!;
    expect(Object.keys(diagnostics.inputSchema.properties ?? {}).sort()).toEqual(["base", "continuation", "files", "gate", "portals", "runtime", "scope"]);
    expect(diagnostics.annotations?.openWorldHint).toBe(true);
    expect(Object.keys(tools.find((tool) => tool.name === "plan_upgrade")!.inputSchema.properties ?? {}).sort()).toEqual(["continuation", "package", "target"]);
  });

  it("warns about an outdated package with the exact upgrade command on every response", async () => {
    for (const [name, input] of [["project_overview", {}], ["run_diagnostics", {}], ["plan_upgrade", { target: "19" }]] as const) {
      const response = await mcp.call(name, input);
      expect(response.update).toEqual({ status: "outdated", installedVersion: WEB_DOCTOR_VERSION, availableVersion: "99.0.0", installationMode: "project-exact", command: "npm install --save-dev --save-exact web-doctor@99.0.0", reason: "A newer enterprise package version is available" });
      expect(response.warnings).toContain(`Web Doctor 99.0.0 is available; installed ${WEB_DOCTOR_VERSION}. Upgrade with: npm install --save-dev --save-exact web-doctor@99.0.0`);
    }
  });

  it("identifies shared fact provenance and the categories a skipped input left incomplete", async () => {
    const response = await mcp.call("project_overview");
    expect(response.provenance.repoFacts).toMatchObject({ status: "complete", release: DETECTOR_RELEASE, configurationDigest: expect.stringMatching(/^[0-9a-f]{64}$/), factDocumentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(response.provenance.repoFacts.incompleteCategories.length).toBeGreaterThan(0);
    const categories = (response.data as { items: { id: string; complete: boolean; source: string }[] }).items;
    for (const id of response.provenance.repoFacts.incompleteCategories) expect(categories.find((category) => category.id === id && category.source === "shared")?.complete).toBe(false);
    expect((response.data as { summary: { skipped_inputs: number } }).summary.skipped_inputs).toBeGreaterThan(0);
  });

  it("returns representative diagnostics, finding, upgrade, and verification responses that conform to the envelope", async () => {
    const diagnostics = await mcp.call("run_diagnostics", { scope: "files", files: ["src/Pay.tsx"] });
    const report = diagnosticsReportSchema.parse(diagnostics.data);
    expect(report.scope).toMatchObject({ mode: "changed-files", files: ["src/Pay.tsx"] });
    const finding = report.findings[0]!;
    const explained = await mcp.call("explain_finding", { finding: finding.id });
    const upgrade = await mcp.call("plan_upgrade", { target: "19" });
    const verification = await mcp.call("plan_verification", { files: ["src/Pay.tsx"] });
    for (const response of [diagnostics, explained, upgrade, verification] satisfies McpResponse[]) {
      expect(mcpResponseSchema.parse(response)).toEqual(response);
      expect(response.provenance.extensions?.stateDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(diagnostics.evidence).toContainEqual({ path: "src/Pay.tsx", line: 2, column: 3, endLine: 2 });
    expect((upgrade.data as UpgradePlan).current.version).toBe("18.3.1");
    expect(explained.data).toMatchObject({ finding: { id: finding.id }, modifiesProject: false });
  });

  it("does not run rendered checks unless the server was started with --allow-runtime", async () => {
    const response = await mcp.call("run_diagnostics", { runtime: { authorized: true, targets: [{ url: "http://127.0.0.1:9/", state: "default" }] } });
    expect(response.warnings).toContain("Rendered checks were not run: start the MCP server with --allow-runtime to authorize them");
    expect((response.data as { runs: unknown[] }).runs).toBeDefined();
  });

  it("rejects malformed requests with a tool error instead of guessing", async () => {
    const both = await mcp.client.callTool({ name: "explain_finding", arguments: { finding: "finding_x", control: "firm/code/no-debugger" } });
    expect(both.isError).toBe(true);
    const unknown = await mcp.client.callTool({ name: "explain_finding", arguments: { finding: `finding_${"0".repeat(64)}` } });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain("run diagnostics again");
    const unauthorized = await mcp.client.callTool({ name: "run_diagnostics", arguments: { runtime: { authorized: false, targets: [] } } });
    expect(unauthorized.isError).toBe(true);
  });
});
