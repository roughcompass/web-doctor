import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_INSTRUCTION, withBlock } from "../../src/agents/registration.js";
import { runCli } from "../../src/cli-app.js";
import { representativePolicyPacks } from "../fixtures/policies.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-agents-")));
  temporaryDirectories.push(root);
  await materialize(root, files);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  return root;
}

async function agent(cwd: string, args: string[]): Promise<{ exitCode: number; result: { changes: { file: string; action: string }[]; launch: { command: string; args: string[] } | null } }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(["agent", ...args, "--json"], { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } }, { cwd, env: {} });
  if (stderr !== "") throw new Error(stderr);
  return { exitCode, result: JSON.parse(stdout) };
}

async function snapshotOf(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files[path.relative(root, full)] = await fs.readFile(full, "utf8");
    }
  };
  await walk(root);
  return files;
}

const ORIGINAL = {
  "package.json": '{"name":"orders","dependencies":{"react":"18.3.1"}}\n',
  ".mcp.json": `${JSON.stringify({ mcpServers: { docs: { command: "docs-server", args: [] } } }, null, 2)}\n`,
  "CLAUDE.md": "# Orders\n\nUse pnpm.\n",
};

describe("agent registration", () => {
  it("adds only Web Doctor's server entry and instruction, and a second install changes nothing", async () => {
    const root = await repository(ORIGINAL);
    const clients = ["--client", "claude-code", "--client", "cursor", "--client", "vscode"];
    const first = await agent(root, ["install", ...clients, "--portal", "wealth", "--command", "web-doctor"]);
    expect(first.exitCode).toBe(0);
    expect(first.result.changes).toEqual([
      { client: "claude-code", file: ".mcp.json", action: "updated" },
      { client: "cursor", file: ".cursor/mcp.json", action: "created" },
      { client: "vscode", file: ".vscode/mcp.json", action: "created" },
      { client: null, file: "AGENTS.md", action: "created" },
      { client: null, file: "CLAUDE.md", action: "updated" },
    ]);
    const claude = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(claude.mcpServers).toEqual({ docs: { command: "docs-server", args: [] }, "web-doctor": { command: "web-doctor", args: ["mcp", "--portal", "wealth"] } });
    expect(JSON.parse(await fs.readFile(path.join(root, ".vscode/mcp.json"), "utf8"))).toEqual({ servers: { "web-doctor": { type: "stdio", command: "web-doctor", args: ["mcp", "--portal", "wealth"] } } });
    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(`# Orders\n\nUse pnpm.\n\n${AGENT_INSTRUCTION}`);

    const installed = await snapshotOf(root);
    const second = await agent(root, ["install", ...clients, "--portal", "wealth", "--command", "web-doctor"]);
    expect(second.result.changes.every((change) => change.action === "unchanged")).toBe(true);
    expect(await snapshotOf(root)).toEqual(installed);
  });

  it("uninstalls back to the original files, and a second uninstall changes nothing", async () => {
    const root = await repository(ORIGINAL);
    const before = await snapshotOf(root);
    const clients = ["--client", "claude-code", "--client", "cursor"];
    await agent(root, ["install", ...clients]);
    const first = await agent(root, ["uninstall", ...clients]);
    expect(first.result.changes).toEqual([
      { client: "claude-code", file: ".mcp.json", action: "updated" },
      { client: "cursor", file: ".cursor/mcp.json", action: "removed" },
      { client: null, file: "AGENTS.md", action: "removed" },
      { client: null, file: "CLAUDE.md", action: "updated" },
    ]);
    expect(await snapshotOf(root)).toEqual(before);
    const second = await agent(root, ["uninstall", ...clients]);
    expect(second.result.changes.map((change) => change.action)).toEqual(["unchanged", "absent", "absent", "unchanged"]);
    expect(await snapshotOf(root)).toEqual(before);
  });

  it("registers a nested application from the repository root with its application root", async () => {
    const root = await repository({ "README.md": "# Services\n", "apps/portal/package.json": '{"name":"portal","dependencies":{"react":"18.3.1"}}\n' });
    const { result } = await agent(path.join(root, "apps/portal"), ["install", "--client", "claude-code", "--allow-runtime"]);
    expect(result.launch!.args).toEqual(expect.arrayContaining(["mcp", "--root", "apps/portal", "--allow-runtime"]));
    expect(await fs.readFile(path.join(root, ".mcp.json"), "utf8")).toContain('"apps/portal"');
  });

  it("generates a short instruction that points to the MCP server and copies no policy", () => {
    expect(AGENT_INSTRUCTION.length).toBeLessThan(1_200);
    for (const tool of ["project_overview", "effective_guidance", "run_diagnostics", "explain_finding", "plan_upgrade", "plan_verification"]) expect(AGENT_INSTRUCTION).toContain(tool);
    for (const pack of representativePolicyPacks) {
      expect(AGENT_INSTRUCTION).not.toContain(pack.id);
      for (const control of pack.controls) {
        expect(AGENT_INSTRUCTION).not.toContain(control.id);
        expect(AGENT_INSTRUCTION).not.toContain(control.title);
        if (control.remediation !== undefined) expect(AGENT_INSTRUCTION).not.toContain(control.remediation);
      }
    }
    expect(withBlock(withBlock("# Notes\n", AGENT_INSTRUCTION), null)).toBe("# Notes\n");
    expect(withBlock(`${AGENT_INSTRUCTION}\n# After\n`, null)).toBe("# After\n");
  });

  it("refuses unknown clients and a configuration that is not a JSON object", async () => {
    const root = await repository({ "package.json": "{}\n", ".mcp.json": "[]\n" });
    let stderr = "";
    const io = { stdout: () => {}, stderr: (text: string) => { stderr += text; } };
    expect(await runCli(["agent", "install", "--client", "emacs"], io, { cwd: root, env: {} })).toBe(64);
    expect(await runCli(["agent", "install"], io, { cwd: root, env: {} })).toBe(64);
    expect(await runCli(["agent", "install", "--client", "claude-code"], io, { cwd: root, env: {} })).toBe(1);
    expect(stderr).toContain("is not a JSON object");
    expect(await fs.readFile(path.join(root, ".mcp.json"), "utf8")).toBe("[]\n");
  });
});
