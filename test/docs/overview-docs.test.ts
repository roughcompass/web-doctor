import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PolicyPack } from "../../src/contracts/index.js";
import { documentedCommands, installCleanApplication, type CleanInstallation } from "../support/clean-install.js";

/**
 * A new test application follows docs/overview.md from installation to its
 * first explained finding, using only the commands the guide shows.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const DOC = path.join(ROOT, "docs/overview.md");
const verification = [{ kind: "eslint", description: "Run the rule on the changed files." }];
const POLICIES: PolicyPack[] = [
  { schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version: "1.0.0", owner: "Enterprise Engineering", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" }, controls: [{ id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], remediation: "Remove the debugger statement.", verification }] },
  { schema: "web-doctor.policy-pack", schemaVersion: 2, id: "wealth/release", version: "1.0.0", owner: "Wealth Platform", layer: "portal", compatibility: { webDoctor: ">=0.1.0" }, controls: [{ id: "wealth/release/no-debugger", title: "Wealth releases carry no debugger statements", rationale: "Release review", strength: "recommended", applicability: { portals: { anyOf: ["wealth"] } }, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], verification }] },
];

let installation: CleanInstallation;

beforeAll(async () => {
  installation = await installCleanApplication({
    policies: POLICIES,
    files: {
      "package.json": `${JSON.stringify({ name: "first-app", private: true, dependencies: { react: "18.3.1" } }, null, 2)}\n`,
      "src/Checkout.jsx": "export function Checkout() {\n  debugger;\n  return <form />;\n}\n",
    },
  });
}, 300_000);

afterAll(async () => {
  await installation?.close();
});

describe("product overview and runbook", () => {
  it("links only to documents that exist", async () => {
    const text = await fs.readFile(DOC, "utf8");
    const links = [...text.matchAll(/\]\(([a-z-]+\.md)(?:#[a-z-]+)?\)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThan(4);
    for (const link of new Set(links)) await expect(fs.access(path.join(ROOT, "docs", link)), link).resolves.toBeUndefined();
    for (const topic of ["One Package and One MCP Server", "Policy Layers", "Multiple Portals", "Provider Proof Boundaries", "Authoring and Approval", "Operator Troubleshooting"]) expect(text).toContain(`## ${topic}`);
  });

  it("takes a new application from installation to its first explained finding", async () => {
    let findingId: string | null = null;
    let explanation = "";
    for (const command of await documentedCommands(DOC)) {
      if (command.startsWith("npm install")) {
        expect(JSON.parse(await fs.readFile(path.join(installation.app, "package.json"), "utf8")).devDependencies["web-doctor"]).toBeDefined();
        continue;
      }
      expect(command).toMatch(/^web-doctor /);
      const args = command.slice("web-doctor ".length).replaceAll("<finding-id>", findingId ?? "missing").split(/\s+/);
      const result = await installation.run(args);
      expect(result.stderr, command).not.toMatch(/Web Doctor failed|Usage error/);
      if (args[0] === "check") {
        expect(result.code, command).toBe(2);
        expect(result.stdout).toMatch(/error src\/Checkout\.jsx:2:3 eslint\/no-debugger/);
        findingId = /\b(finding_[0-9a-f]{64})\b/.exec(result.stdout)?.[1] ?? null;
        expect(findingId).not.toBeNull();
      } else {
        expect(result.code, `${command}: ${result.stdout.slice(0, 300)}`).toBe(0);
      }
      if (args[0] === "explain") explanation = result.stdout;
    }
    expect(explanation).toContain("eslint/no-debugger: Unexpected 'debugger' statement.");
    expect(explanation).toContain("required firmwide firm/code/no-debugger: Remove the debugger statement.");
    expect(explanation).toContain("recommended portal wealth/release/no-debugger");
    expect(explanation).toMatch(/Web Doctor \S+ registry [0-9a-f]{12}; repo-facts \S+ complete facts [0-9a-f]{12}/);
    expect(explanation).not.toContain("different effective policy");
  }, 300_000);
});
