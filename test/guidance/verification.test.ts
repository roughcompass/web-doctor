import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosticsReport, PolicyPack, ProfileEvidence, ProviderManifest, RegistrySnapshot } from "../../src/contracts/index.js";
import { FULL_SCOPE, controlLayers, runDiagnostics, type ProviderAdapter, type ProviderContext } from "../../src/diagnostics/providers.js";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { planVerification, type VerificationPlan } from "../../src/guidance/verification.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const DIGEST = "a".repeat(64);

function pack(id: string, layer: PolicyPack["layer"], controls: PolicyPack["controls"]): PolicyPack {
  return { schema: "web-doctor.policy-pack", schemaVersion: 2, id, version: "1.0.0", owner: "Fixture", layer, compatibility: { webDoctor: ">=0.1.0" }, controls };
}

const policies: PolicyPack[] = [
  pack("firm/accessibility", "firmwide", [{
    id: "firm/accessibility/keyboard", title: "Interactive content works with a keyboard", rationale: "Keyboard users", strength: "required", applicability: {},
    evidence: [
      { provider: "eslint", rule: "no-restricted-syntax", kind: "static", required: true },
      { provider: "axe", rule: "scrollable-region-focusable", kind: "rendered", required: true },
      { provider: "keyboard-review", kind: "manual", required: true },
    ],
    verification: [
      { kind: "keyboard", description: "Operate every control with the keyboard only." },
      { kind: "test", description: "Run the component tests for the changed components." },
      { kind: "interaction", description: "Tab through the orders table in a browser test." },
    ],
  }, {
    id: "firm/accessibility/button-name", title: "Buttons have accessible names", rationale: "Names", strength: "required", applicability: {},
    evidence: [{ provider: "axe", rule: "button-name", kind: "rendered", required: true }],
    verification: [{ kind: "axe", description: "Check buttons in the rendered states." }],
  }]),
  pack("platform/performance", "platform", [{
    id: "platform/performance/order-list", title: "The order list stays within the commit budget", rationale: "Large portfolios", strength: "required", applicability: {},
    evidence: [{ provider: "react-profiler", kind: "measured", required: true }],
    verification: [{ kind: "profile", description: "Profile selecting an order row." }],
  }]),
  pack("application/engineering", "application", [{
    id: "application/engineering/no-console", title: "No console statements", rationale: "Noise", strength: "recommended", applicability: { files: { include: ["src/**"] } },
    evidence: [{ provider: "eslint", rule: "no-console", kind: "static", required: true }],
    verification: [{ kind: "eslint", description: "Run no-console." }],
  }]),
];

const axe: ProviderManifest = {
  schema: "web-doctor.provider-manifest", schemaVersion: 1, id: "axe", version: "4.13.0", owner: "Fixture", adapterVersion: "1.0.0", engine: "axe-core", engineRange: "^4.13.0",
  compatibility: { webDoctor: ">=0.1.0" }, evidenceKinds: ["rendered"], completeness: ["complete", "partial", "unavailable"], capabilities: ["browser"], invocationModes: ["runtime"],
  rules: [{ id: "button-name", title: "Button name", evidenceKind: "rendered" }, { id: "scrollable-region-focusable", title: "Scrollable regions", evidenceKind: "rendered" }], artifacts: [{ path: "scan.mjs", digest: DIGEST }],
};

const registry: RegistrySnapshot = {
  schema: "web-doctor.registry-snapshot", schemaVersion: 2, webDoctorVersion: "0.1.0", webDoctorCommit: "a".repeat(40), catalogCommit: "b".repeat(40), catalogDigest: DIGEST, portals: [],
  contributions: policies.map((policy) => ({
    id: policy.id, type: "policy" as const, owner: "fixture",
    source: { schema: "web-doctor.npm-source" as const, schemaVersion: 1 as const, registry: "internal" as const, packageName: `@fixture/${policy.id.replace("/", "-")}`, version: "1.0.0", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, provenance: { repository: "ssh://git.internal/fixture.git", commit: "c".repeat(40) } },
    manifestPath: "web-doctor.json", manifestDigest: DIGEST, lifecycle: "active" as const, compatibility: { webDoctor: ">=0.1.0" }, portals: [], layers: [policy.layer],
  })),
  policies, providers: [axe], guidance: [],
};

const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry }) });
const layers = controlLayers(registry);

const passing: ProviderAdapter[] = [
  { engine: "eslint", async run(plans) { return plans.map((plan) => ({ provider: plan.provider, engineVersion: "9.39.5", completeness: "complete" as const, reason: null, ruleStatus: Object.fromEntries(plan.rules.map((rule) => [rule, "complete" as const])), capabilities: ["filesystem-read" as const], denied: [], files: 3, drafts: [] })); } },
  { engine: "axe-core", async run(plans) { return plans.map((plan) => ({ provider: plan.provider, engineVersion: "4.13.0", completeness: "complete" as const, reason: null, ruleStatus: Object.fromEntries(plan.rules.map((rule) => [rule, "complete" as const])), capabilities: ["browser" as const], denied: [], files: 0, drafts: [], testedScope: ["http://127.0.0.1:4000/orders (default)"] })); } },
];

let workspace: string;
let snapshot: ProjectSnapshot;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-verification-")));
  await materialize(workspace, {
    "package.json": `${JSON.stringify({ name: "orders", private: true, scripts: { test: "vitest run", e2e: "playwright test" }, dependencies: { react: "18.3.1", "react-router-dom": "6.30.1" }, devDependencies: { vitest: "3.2.4", "@playwright/test": "1.56.0" } }, null, 2)}\n`,
    "src/Orders.tsx": "export function Orders() {\n  return <table />;\n}\n",
    "src/Reports.tsx": "export function Reports() {\n  return <section />;\n}\n",
    "src/App.tsx": 'import { Route, Routes } from "react-router-dom";\nimport { Orders } from "./Orders";\n\nexport function App() {\n  return <Routes><Route path="/orders" element={<Orders />} /></Routes>;\n}\n',
    "src/Orders.test.tsx": 'import { test } from "vitest";\nimport { Orders } from "./Orders";\n\ntest("renders", () => {\n  Orders();\n});\n',
    "src/Reports.test.tsx": 'import { test } from "vitest";\nimport { Reports } from "./Reports";\n\ntest("renders", () => {\n  Reports();\n});\n',
    "e2e/orders.spec.ts": 'import { test } from "@playwright/test";\n\ntest("tabs through orders", async ({ page }) => {\n  await page.goto("/orders");\n});\n',
  });
  const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: path.resolve(import.meta.dirname, "../..") }) });
  snapshot = await analyzeProject({ root: workspace, repositoryRoot: workspace, analyzer });
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function reportWith(runtime: boolean): Promise<DiagnosticsReport> {
  const context: ProviderContext = { root: workspace, repositoryRoot: null, registryRoot: workspace, registry, providerContributions: {}, snapshot, scope: FULL_SCOPE, runtime: runtime ? { authorized: true, targets: [{ url: "http://127.0.0.1:4000/orders", state: "default" }] } : null };
  return runDiagnostics({ policy, layers, context, adapters: passing, gate: "required", mode: "local" });
}

function control(plan: VerificationPlan, id: string) {
  return plan.controls.find((entry) => entry.control === id)!;
}

describe("verification planning", () => {
  it("keeps manual review when static and rendered checks pass and claims no conformance", async () => {
    const plan = planVerification({ policy, layers, snapshot, report: await reportWith(true) });
    expect(control(plan, "firm/accessibility/keyboard")).toMatchObject({ status: "remaining", requires: ["manual", "rendered", "static"], satisfied: ["rendered", "static"] });
    const manual = plan.items.find((item) => item.type === "manual" && item.evidenceKind === "manual" && item.provider === "keyboard-review")!;
    expect(manual).toMatchObject({ status: "remaining", required: true, reason: "Manual review cannot be satisfied by automated checks or tests" });
    expect(plan.complete).toBe(false);
    expect(plan.statement).toBe("2 of 4 Controls still need evidence, including manual review for 1; passing automated checks does not establish conformance");
    expect(plan.items.find((item) => item.description === "States other than those tested (http://127.0.0.1:4000/orders (default)) remain untested")).toMatchObject({ type: "rendered", status: "remaining" });
  });

  it("never lets static evidence satisfy a Control that requires rendered evidence", async () => {
    const plan = planVerification({ policy, layers, snapshot, report: await reportWith(false) });
    expect(control(plan, "firm/accessibility/button-name")).toMatchObject({ status: "remaining", requires: ["rendered"], satisfied: [] });
    expect(control(plan, "firm/accessibility/keyboard")).toMatchObject({ satisfied: ["static"] });
    expect(control(plan, "application/engineering/no-console")).toMatchObject({ status: "verified", satisfied: ["static"] });
    const rendered = plan.items.find((item) => item.rule === "button-name")!;
    expect(rendered).toMatchObject({ status: "remaining", targets: ["/orders"], command: "web-doctor check --runtime <request.json>", reason: "No rendered run under this policy has tested a state" });
  });

  it("satisfies measured evidence only with a profile, and fails it when the budget is exceeded", async () => {
    const report = await reportWith(true);
    expect(control(planVerification({ policy, layers, snapshot, report }), "platform/performance/order-list")).toMatchObject({ status: "remaining", requires: ["measured"], satisfied: [] });
    const profile = (maxCommitMs: number): ProfileEvidence => ({ schema: "web-doctor.profile-evidence", schemaVersion: 1, interaction: "Select an order row", source: "React Developer Tools Profiler export", commitBudgetMs: 16, components: [{ component: "Orders", commits: 12, actualDurationMs: 60, maxCommitMs }] });
    expect(control(planVerification({ policy, layers, snapshot, report, measurements: [{ provider: "react-profiler", profile: profile(9) }] }), "platform/performance/order-list")).toMatchObject({ status: "verified", satisfied: ["measured"] });
    const failed = planVerification({ policy, layers, snapshot, report, measurements: [{ provider: "react-profiler", profile: profile(24) }] });
    expect(control(failed, "platform/performance/order-list").status).toBe("failed");
    expect(failed.items.find((item) => item.type === "measurement")!.reason).toBe("Orders exceeded the 16 ms commit budget");
  });

  it("names component and interaction tests without treating them as evidence", async () => {
    const plan = planVerification({ policy, layers, snapshot, report: await reportWith(true), files: ["src/Orders.tsx"] });
    const component = plan.items.find((item) => item.type === "component-test")!;
    expect(component).toMatchObject({ targets: ["src/Orders.test.tsx"], command: "vitest run", status: "remaining", evidenceKind: null, reason: "Web Doctor names tests but does not run them" });
    expect(component.evidence.map((view) => [view.source, view.category])).toEqual([["extension", "web-doctor.tests"], ["shared", "verification_commands"]]);
    expect(plan.items.find((item) => item.type === "interaction-test")).toMatchObject({ targets: ["e2e/orders.spec.ts"], status: "remaining", evidenceKind: null });
    expect(plan.items.find((item) => item.type === "static" && item.rule === "no-console")!.command).toBe("web-doctor check --files src/Orders.tsx");
  });

  it("orders verification from the narrowest static checks to manual review", async () => {
    const plan = planVerification({ policy, layers, snapshot, report: await reportWith(true) });
    const types = plan.items.map((item) => item.type);
    const order = ["static", "component-test", "rendered", "interaction-test", "measurement", "manual"];
    expect(types).toEqual([...types].sort((left, right) => order.indexOf(left) - order.indexOf(right)));
    expect(new Set(types)).toEqual(new Set(order));
    expect(plan.modifiesProject).toBe(false);
  });

  it("ignores a report produced under a different effective policy", async () => {
    const report = { ...(await reportWith(true)), policyDigest: "f".repeat(64) };
    const plan = planVerification({ policy, layers, snapshot, report });
    expect(plan.reportDigest).toBeNull();
    expect(plan.controls.every((entry) => entry.status === "remaining")).toBe(true);
  });
});
