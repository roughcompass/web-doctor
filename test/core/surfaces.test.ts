import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DETECTOR_RELEASE } from "@repo-facts/bundle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpResponseSchema, type McpResponse } from "../../src/contracts/index.js";
import { runCli } from "../../src/cli-app.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import { representativePolicyPacks } from "../fixtures/policies.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { connectClient } from "../support/mcp-client.js";
import { materialize, readTree } from "../support/repo-facts-fixtures.js";

const MIXED = path.resolve(import.meta.dirname, "../fixtures/web-doctor/mixed-react/tree");
let workspace: string;
let root: string;
let registry: string;
let core: WebDoctor;
let mcp: Awaited<ReturnType<typeof connectClient>>;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-surfaces-")));
  root = path.join(workspace, "app");
  await materialize(root, { ...await readTree(MIXED), "src/wealth/Summary.tsx": "export function Summary() {\n  return <section />;\n}\n" });
  registry = (await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: representativePolicyPacks })).root;
  core = await WebDoctor.open({ cwd: root, caller: "mcp", registryRoot: registry });
  mcp = await connectClient(core);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  await core?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ exitCode: number; response: McpResponse }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli([...args, "--json"], { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } }, { cwd: root, env: { WEB_DOCTOR_REGISTRY_ROOT: registry } });
  if (stderr !== "") throw new Error(stderr);
  return { exitCode, response: mcpResponseSchema.parse(JSON.parse(stdout)) };
}

describe("shared application core", () => {
  it("answers the project overview identically through the CLI and the MCP server", async () => {
    const [fromCli, fromMcp] = await Promise.all([cli(["context", "overview"]), mcp.call("project_overview")]);
    expect(fromCli.exitCode).toBe(0);
    expect(fromCli.response).toEqual(fromMcp);
    expect(fromMcp.provenance).toMatchObject({
      repoFacts: { status: "complete", release: DETECTOR_RELEASE, configurationDigest: expect.stringMatching(/^[0-9a-f]{64}$/), factDocumentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      extensions: { stateDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      project: { root },
      webDoctor: { registryDigest: core.build.registryDigest },
    });
  });

  it("explains symbols and their usages identically through both surfaces", async () => {
    expect((await cli(["context", "symbol", "OrderList"])).response).toEqual(await mcp.call("explain_symbol", { symbol: "OrderList" }));
    expect((await cli(["context", "usages", "useOrders", "--limit", "2"])).response).toEqual(await mcp.call("explain_symbol", { symbol: "useOrders", aspect: "usages", limit: 2 }));
    expect((await cli(["context", "data-path", "src/orders/OrderList.tsx#OrderList"])).response).toEqual(await mcp.call("explain_symbol", { symbol: "src/orders/OrderList.tsx#OrderList", aspect: "data_path" }));
  });

  it("resolves the same effective policy and provenance for the same portals from either surface", async () => {
    const fromCli = await cli(["policy", "effective", "--portal", "wealth", "--portal", "advisor", "--file", "src/wealth/Summary.tsx"]);
    const fromMcp = await mcp.call("effective_guidance", { portals: ["advisor", "wealth"], file: "src/wealth/Summary.tsx" });
    expect(fromCli.response).toEqual(fromMcp);
    const policy = (fromMcp.data as { policy: { controls: { control: { id: string } }[]; facts: unknown; webDoctorVersion: string } }).policy;
    expect(policy.controls.map((entry) => entry.control.id)).toEqual([
      "advisor/content/action-name",
      "application/engineering/account-term",
      "firm/accessibility/button-name",
      "platform/runtime/analytics-event",
      "wealth/brand/approved-button",
    ]);
    expect(policy.facts).toEqual({
      status: "complete",
      detectorRelease: DETECTOR_RELEASE,
      configurationDigest: fromMcp.provenance.repoFacts.configurationDigest,
      factDocumentDigest: fromMcp.provenance.repoFacts.factDocumentDigest,
      extensionStateDigest: fromMcp.provenance.extensions!.stateDigest,
    });
    expect(fromMcp.provenance.policy).toEqual({ digest: expect.stringMatching(/^[0-9a-f]{64}$/), portals: ["advisor", "wealth"] });
  });
});
