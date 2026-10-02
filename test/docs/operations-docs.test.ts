import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PolicyPack } from "../../src/contracts/index.js";
import { documentedCommands, installCleanApplication, installManagedApplication, type CleanInstallation, type CleanInstallationOptions } from "../support/clean-install.js";

/**
 * Runs every command in docs/operations.md from both clean installations of
 * a release: a project dependency and a managed tool-cache installation.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const DOC = path.join(ROOT, "docs/operations.md");

const POLICY: PolicyPack = {
  schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version: "1.0.0", owner: "Fixture", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" },
  controls: [{ id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], remediation: "Remove the debugger statement.", verification: [{ kind: "eslint", description: "Run no-debugger." }] }],
};

const APPLICATION: CleanInstallationOptions = {
  policies: [POLICY],
  files: {
    "package.json": `${JSON.stringify({ name: "clean-app", private: true, dependencies: { react: "18.3.1" } }, null, 2)}\n`,
    "web-doctor.config.json": `${JSON.stringify({ schema: "web-doctor.repository-config", schemaVersion: 1, portals: ["wealth"] }, null, 2)}\n`,
    "src/Pay.jsx": "export function Pay() {\n  return <form />;\n}\n",
  },
};

/** Exit codes each documented command may return, from the guide's own tables and text. */
const EXPECTED: [RegExp, number[]][] = [
  [/^check /, [0, 2, 3, 4]],
  // A fresh managed installation has no retained version yet, which rollback reports as a failure.
  [/^update rollback$/, [0, 1, 2]],
  [/^update$/, [0, 1, 2]],
  [/^/, [0]],
];

/** Speaks the MCP protocol to the server over stdio and returns the listed tool names. */
async function listTools(installation: CleanInstallation, args: string[]): Promise<string[]> {
  const child = spawn(installation.command[0]!, [...installation.command.slice(1), ...args], { cwd: installation.app, env: installation.env, stdio: ["pipe", "pipe", "pipe"] });
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  let buffer = "";
  const tools = await new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The MCP server did not answer")), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n").slice(0, -1)) {
        const message = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        }
        if (message.id === 2) {
          clearTimeout(timer);
          resolve((message.result?.tools ?? []).map((tool) => tool.name));
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
    child.on("error", reject);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "operations-docs", version: "1.0.0" } } });
  });
  child.stdin.end();
  child.kill();
  return tools;
}

describe("operations guide", () => {
  it("documents only commands a clean installation can run", async () => {
    const commands = await documentedCommands(DOC);
    expect(commands.length).toBeGreaterThan(10);
    for (const command of commands) expect(command, command).toMatch(/^(web-doctor |npm install --save-dev --save-exact web-doctor@\d+\.\d+\.\d+$)/);
  });
});

describe.each([
  ["project dependency", installCleanApplication],
  ["managed", installManagedApplication],
] as const)("operations guide from a clean %s installation", (_kind, install) => {
  let installation: CleanInstallation;

  beforeAll(async () => {
    installation = await install(APPLICATION);
    await installation.commit();
    await fs.writeFile(path.join(installation.app, "src/Pay.jsx"), "export function Pay() {\n  debugger;\n  return <form />;\n}\n");
  }, 300_000);

  afterAll(async () => {
    await installation?.close();
  });

  it("runs every documented command", async () => {
    let findingId: string | null = null;
    for (const command of await documentedCommands(DOC)) {
      if (command.startsWith("npm install")) {
        // The installation itself ran in beforeAll, from the same release tarball.
        if (installation.kind === "project") expect(JSON.parse(await fs.readFile(path.join(installation.app, "package.json"), "utf8")).devDependencies["web-doctor"]).toBeDefined();
        continue;
      }
      const args = command.slice("web-doctor ".length).replaceAll("<base-revision>", "HEAD").replaceAll("<control-id>", "firm/code/no-debugger").replaceAll("<finding-id>", findingId ?? "missing").split(/\s+/);
      if (args[0] === "mcp") {
        expect(await listTools(installation, args)).toEqual(expect.arrayContaining(["project_overview", "run_diagnostics", "explain_finding", "plan_upgrade", "plan_verification"]));
        continue;
      }
      const result = await installation.run(args);
      const allowed = EXPECTED.find(([pattern]) => pattern.test(args.join(" ")))![1];
      expect(allowed, `${command} exited ${result.code}: ${result.stderr}${result.stdout.slice(0, 400)}`).toContain(result.code);
      expect(result.stderr, command).not.toMatch(/Web Doctor failed|Usage error|Unknown command/);
      if (args.includes("--report") && args[0] === "check") {
        const report = JSON.parse(await fs.readFile(path.join(installation.app, "web-doctor-report.json"), "utf8")) as { findings: { id: string }[] };
        findingId = report.findings[0]?.id ?? null;
        expect(findingId).not.toBeNull();
      }
    }
    expect(findingId).not.toBeNull();
  }, 300_000);

  it("runs on exactly the dependency versions the release's shrinkwrap pins", async () => {
    const cli = installation.command.at(-1)!;
    const packageRoot = path.dirname(path.dirname(await fs.realpath(cli)));
    const shrinkwrap = JSON.parse(await fs.readFile(path.join(packageRoot, "npm-shrinkwrap.json"), "utf8")) as { packages: Record<string, { version: string }> };
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    for (const name of Object.keys(manifest.dependencies)) {
      // Resolve as Node does from the package: its own node_modules first, then each parent's.
      let directory = packageRoot;
      let installed: string | null = null;
      for (;;) {
        try {
          installed = (JSON.parse(await fs.readFile(path.join(directory, "node_modules", ...name.split("/"), "package.json"), "utf8")) as { version: string }).version;
          break;
        } catch {
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      }
      expect(installed, name).toBe(shrinkwrap.packages[`node_modules/${name}`]!.version);
    }
  });

  it("reports its installation mode and the rollback path that belongs to it", async () => {
    const status = await installation.run(["update", "status", "--json"]);
    const expectedMode = installation.kind === "managed" ? "managed" : expect.stringMatching(/^project-/);
    expect(JSON.parse(status.stdout).data).toMatchObject({ installationMode: expectedMode, status: "unknown" });
    const rollback = await installation.run(["update", "rollback", "--json"]);
    const outcome = JSON.parse(rollback.stdout).data.outcome as { status: string; reason: string };
    if (installation.kind === "managed") {
      expect(rollback.code).toBe(1);
      expect(outcome).toMatchObject({ status: "failed", reason: expect.stringContaining("Managed rollback requires active and previous versions") });
    } else {
      expect(rollback.code).toBe(2);
      expect(outcome.reason).toContain("install the prior exact version with the package manager");
    }
    const overview = await installation.run(["context", "overview", "--json"]);
    expect(JSON.parse(overview.stdout).provenance.repoFacts.status).toBe("complete");
  }, 120_000);
});
