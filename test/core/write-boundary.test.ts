import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosticsReport, PolicyPack } from "../../src/contracts/index.js";
import { runCli } from "../../src/cli-app.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import { WorkingTreeListing } from "../../src/facts/working-tree-reader.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { connectClient } from "../support/mcp-client.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const execFileAsync = promisify(execFile);

const POLICIES: PolicyPack[] = [{
  schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version: "1.0.0", owner: "Fixture", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" },
  controls: [
    { id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], remediation: "Remove the debugger statement.", verification: [{ kind: "eslint", description: "Run no-debugger." }, { kind: "test", description: "Run the component tests." }] },
    { id: "firm/code/button-name", title: "Buttons have names", rationale: "Names", strength: "required", applicability: {}, evidence: [{ provider: "axe", rule: "button-name", kind: "rendered", required: true }], verification: [{ kind: "axe", description: "Check buttons." }] },
  ],
}];

let workspace: string;
let root: string;
let registry: string;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-write-boundary-")));
  root = path.join(workspace, "app");
  await materialize(root, {
    "package.json": `${JSON.stringify({ name: "orders", private: true, packageManager: "npm@10.9.0", scripts: { test: "vitest run", lint: "eslint ." }, dependencies: { react: "17.0.2", "react-dom": "17.0.2" }, devDependencies: { vitest: "3.2.4" } }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify({ name: "orders", lockfileVersion: 3, packages: { "": { name: "orders" }, "node_modules/react": { version: "17.0.2" }, "node_modules/react-dom": { version: "17.0.2" }, "node_modules/vitest": { version: "3.2.4", dev: true } } }, null, 2)}\n`,
    "eslint.config.js": "export default [{ files: [\"**/*.js\", \"**/*.jsx\"], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } }];\n",
    ".eslintrc.json": '{"root":true}\n',
    "src/index.jsx": 'import ReactDOM from "react-dom";\nimport { Pay } from "./Pay";\n\nReactDOM.render(<Pay />, document.getElementById("root"));\n',
    "src/Pay.jsx": "export function Pay() {\n  debugger;\n  return <form><button /></form>;\n}\n",
    "src/Pay.test.jsx": 'import { test } from "vitest";\nimport { Pay } from "./Pay";\n\ntest("renders", () => {\n  Pay();\n});\n',
    ".gitignore": "node_modules\n",
  });
  const git = (...args: string[]) => execFileAsync("git", ["-c", "user.email=ci@example.com", "-c", "user.name=CI", ...args], { cwd: root });
  await git("init", "-q");
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
  await fs.writeFile(path.join(root, "src/Pay.jsx"), "export function Pay() {\n  debugger;\n  debugger;\n  return <form><button /></form>;\n}\n");
  registry = (await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: POLICIES })).root;
}, 60_000);

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Every file and its content under the application, plus Git's own view of tracked and untracked state. */
async function workspaceDigest(): Promise<{ files: string; git: string; listing: string }> {
  const hash = crypto.createHash("sha256");
  const walk = async (directory: string) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      const stat = await fs.lstat(full);
      hash.update(`${path.relative(root, full)}\0${stat.mode}\0`);
      if (entry.isDirectory()) await walk(full);
      else hash.update(await fs.readFile(full));
    }
  };
  await walk(root);
  const status = (await execFileAsync("git", ["status", "--porcelain=v1", "--ignored", "--untracked-files=all"], { cwd: root })).stdout;
  return { files: hash.digest("hex"), git: status, listing: (await WorkingTreeListing.scan({ root, repositoryRoot: root })).digest };
}

async function cli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  let stdout = "";
  const exitCode = await runCli(args, { stdout: (text) => { stdout += text; }, stderr: (text) => { stdout += text; } }, { cwd: root, env: { WEB_DOCTOR_REGISTRY_ROOT: registry } });
  return { exitCode, stdout };
}

describe("write boundary", () => {
  it("leaves the workspace unchanged after every CLI context, diagnosis, explanation, and planning command", async () => {
    const before = await workspaceDigest();
    const { stdout } = await cli(["check", "--json"]);
    const finding = (JSON.parse(stdout).data as DiagnosticsReport).findings[0]!;
    const commands = [
      ["context", "overview"], ["context", "symbol", "Pay"], ["context", "usages", "Pay"], ["context", "data-path", "Pay"], ["context", "boundaries"], ["context", "tests"], ["context", "services"], ["context", "commands"],
      ["policy", "effective", "--file", "src/Pay.jsx"],
      ["check"], ["check", "--ci"], ["check", "--file", "src/Pay.jsx"], ["check", "--changed", "HEAD"], ["check", "--changed-lines", "HEAD"],
      ["explain", "finding", finding.id], ["explain", "control", "firm/code/no-debugger"],
      ["plan", "upgrade", "react", "19"], ["plan", "verification", "--file", "src/Pay.jsx"],
      ["update", "status"], ["provenance"],
    ];
    for (const args of commands) {
      for (const json of [false, true]) {
        const result = await cli(json ? [...args, "--json"] : args);
        expect([0, 2, 3, 4], `${args.join(" ")} exited ${result.exitCode}: ${result.stdout.slice(0, 300)}`).toContain(result.exitCode);
      }
    }
    expect(await workspaceDigest()).toEqual(before);
  }, 180_000);

  it("leaves the workspace unchanged after every MCP tool, including a request to fix a finding", async () => {
    const before = await workspaceDigest();
    const core = await WebDoctor.open({ cwd: root, caller: "mcp", registryRoot: registry, watch: true });
    const mcp = await connectClient(core);
    try {
      const diagnostics = await mcp.call("run_diagnostics");
      const finding = (diagnostics.data as DiagnosticsReport).findings[0]!;
      const calls: [string, Record<string, unknown>][] = [
        ["project_overview", {}], ["project_overview", { topic: "tests" }], ["explain_symbol", { symbol: "Pay" }], ["explain_symbol", { symbol: "Pay", aspect: "usages" }],
        ["effective_guidance", { file: "src/Pay.jsx" }],
        ["run_diagnostics", { scope: "changed-lines", base: "HEAD" }], ["run_diagnostics", { scope: "files", files: ["src/Pay.jsx"] }],
        ["explain_finding", { finding: finding.id }], ["explain_finding", { control: "firm/code/no-debugger" }],
        ["plan_upgrade", { target: "19" }], ["plan_verification", { files: ["src/Pay.jsx"] }],
        ["update_status", {}], ["build_provenance", {}],
      ];
      for (const [name, input] of calls) await mcp.call(name, input);
      const fix = await mcp.call("explain_finding", { finding: finding.id });
      expect(fix.data).toMatchObject({ modifiesProject: false, recommendation: { generic: { remediation: ["Remove the debugger statement."] } } });
      const { tools } = await mcp.client.listTools();
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false)).toBe(true);
    } finally {
      await mcp.close();
      await core.close();
    }
    expect(await workspaceDigest()).toEqual(before);
  }, 180_000);
});
