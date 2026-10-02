import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiagnosticsReport, McpResponse, PolicyPack } from "../../src/contracts/index.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import { writeEmbeddedRegistry } from "./embedded-registry.js";
import { connectClient } from "./mcp-client.js";
import { materialize } from "./repo-facts-fixtures.js";

/**
 * The application and policy behind examples/guidance-responses: a React 17
 * page that calls `alert`, a firmwide Control against blocking dialogs, and a
 * Wealth portal Control that supplies an approved Dialog component.
 */

export const EXAMPLE_ROOT = "/work/orders";

const verification = [{ kind: "eslint", description: "Run no-alert on the changed files." }];

function pack(id: string, layer: PolicyPack["layer"], controls: PolicyPack["controls"]): PolicyPack {
  return { schema: "web-doctor.policy-pack", schemaVersion: 2, id, version: "1.0.0", owner: layer === "firmwide" ? "Enterprise UX" : "Wealth Design Platform", layer, compatibility: { webDoctor: ">=0.1.0" }, controls };
}

const POLICIES: PolicyPack[] = [
  pack("firm/ux", "firmwide", [{ id: "firm/ux/no-blocking-dialogs", title: "Pages do not block with browser dialogs", rationale: "Browser dialogs block assistive technology and cannot be styled", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-alert", kind: "static", required: true }], remediation: "Replace the browser dialog with an in-page dialog.", verification }]),
  pack("wealth/design", "portal", [{
    id: "wealth/design/dialog", title: "Wealth pages use the approved dialog", rationale: "One focus-managed dialog for every Wealth page", strength: "required", applicability: { portals: { anyOf: ["wealth"] } },
    evidence: [{ provider: "eslint", rule: "no-alert", kind: "static", required: true }, { provider: "design-review", kind: "manual", required: true }],
    remediation: "Use the Wealth Dialog.",
    verification: [...verification, { kind: "keyboard", description: "Open and close the dialog with the keyboard only." }, { kind: "test", description: "Run the component tests for the changed components." }],
    patterns: [{ kind: "component", name: "Dialog", module: "@wealth/ui", usage: "Render <Dialog open onClose={...} title={...}> and move focus to its first control.", replaces: { modules: ["react-modal"] } }],
  }]),
];

const FILES = {
  "package.json": `${JSON.stringify({ name: "orders", private: true, packageManager: "npm@10.9.0", scripts: { test: "vitest run", typecheck: "tsc --noEmit" }, dependencies: { react: "17.0.2", "react-dom": "17.0.2" }, devDependencies: { vitest: "3.2.4", typescript: "5.9.3" } }, null, 2)}\n`,
  "package-lock.json": `${JSON.stringify({ name: "orders", lockfileVersion: 3, packages: { "": { name: "orders" }, "node_modules/react": { version: "17.0.2" }, "node_modules/react-dom": { version: "17.0.2" }, "node_modules/typescript": { version: "5.9.3", dev: true }, "node_modules/vitest": { version: "3.2.4", dev: true } } }, null, 2)}\n`,
  "web-doctor.config.json": `${JSON.stringify({ schema: "web-doctor.repository-config", schemaVersion: 1, portals: ["wealth"] }, null, 2)}\n`,
  "src/index.tsx": 'import ReactDOM from "react-dom";\nimport { SaveButton } from "./SaveButton";\n\nReactDOM.render(<SaveButton />, document.getElementById("root"));\n',
  "src/SaveButton.tsx": 'export function SaveButton() {\n  return <button onClick={() => alert("Saved")}>Save</button>;\n}\n',
  "src/SaveButton.test.tsx": 'import { test } from "vitest";\nimport { SaveButton } from "./SaveButton";\n\ntest("renders", () => {\n  SaveButton();\n});\n',
};

/** Produces the four guidance responses, with the temporary application root replaced by EXAMPLE_ROOT. */
export async function generateGuidanceExamples(): Promise<Record<string, McpResponse>> {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-guidance-examples-")));
  const root = path.join(workspace, "orders");
  try {
    await materialize(root, FILES);
    const registry = (await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: POLICIES, portals: [{ id: "wealth", lifecycle: "active" }] })).root;
    const core = await WebDoctor.open({ cwd: root, caller: "mcp", registryRoot: registry, watch: false });
    const mcp = await connectClient(core);
    try {
      const normalize = (value: McpResponse) => JSON.parse(JSON.stringify(value).replaceAll(root, EXAMPLE_ROOT)) as McpResponse;
      const guidance = await mcp.call("effective_guidance", { file: "src/SaveButton.tsx" });
      const diagnostics = await mcp.call("run_diagnostics", { scope: "files", files: ["src/SaveButton.tsx"] });
      const finding = (diagnostics.data as DiagnosticsReport).findings[0]!;
      return {
        "effective-guidance.json": normalize(guidance),
        "explain-finding.json": normalize(await mcp.call("explain_finding", { finding: finding.id })),
        "plan-upgrade.json": normalize(await mcp.call("plan_upgrade", { target: "19" })),
        "plan-verification.json": normalize(await mcp.call("plan_verification", { files: ["src/SaveButton.tsx"] })),
      };
    } finally {
      await mcp.close();
      await core.close();
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
