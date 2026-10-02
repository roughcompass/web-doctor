import { describe, expect, it } from "vitest";
import type { PolicyPack, ProviderManifest, RegistrySnapshot } from "../../src/contracts/index.js";
import {
  EXIT_CODES,
  FULL_SCOPE,
  controlLayers,
  planProviders,
  runDiagnostics,
  unavailable,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderExecution,
  type ProviderPlan,
} from "../../src/diagnostics/providers.js";
import type { ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";

const DIGEST = "a".repeat(64);
const verification = [{ kind: "test", description: "Run the focused check." }];

function pack(id: string, layer: PolicyPack["layer"], controls: PolicyPack["controls"]): PolicyPack {
  return { schema: "web-doctor.policy-pack", schemaVersion: 2, id, version: "1.0.0", owner: "Fixture", layer, compatibility: { webDoctor: ">=0.1.0" }, controls };
}

const wealthDesign: ProviderManifest = {
  schema: "web-doctor.provider-manifest",
  schemaVersion: 1,
  id: "wealth-design",
  version: "2.0.0",
  owner: "Fixture",
  adapterVersion: "1.0.0",
  engine: "eslint",
  engineRange: "^9.0.0",
  compatibility: { webDoctor: ">=0.1.0" },
  evidenceKinds: ["static"],
  completeness: ["complete"],
  capabilities: ["filesystem-read"],
  invocationModes: ["static", "changed-files"],
  rules: [{ id: "use-approved-button", title: "Approved button", evidenceKind: "static" }],
  artifacts: [{ path: "plugin.mjs", digest: DIGEST }],
};

const policies = [
  pack("firm/accessibility", "firmwide", [{
    id: "firm/accessibility/button-name",
    title: "Buttons have accessible names",
    rationale: "Names",
    strength: "required",
    applicability: {},
    evidence: [{ provider: "axe", rule: "button-name", kind: "rendered", required: true }, { provider: "screen-reader", kind: "manual", required: true }],
    verification,
  }]),
  pack("wealth/brand", "portal", [{
    id: "wealth/brand/approved-button",
    title: "Wealth uses the approved button",
    rationale: "Brand",
    strength: "required",
    applicability: { files: { include: ["src/wealth/**"] } },
    evidence: [{ provider: "eslint", rule: "wealth-design/use-approved-button", kind: "static", required: true }],
    remediation: "Use WealthButton.",
    verification,
  }]),
  pack("application/engineering", "application", [{
    id: "application/engineering/no-console",
    title: "No console statements",
    rationale: "Noise",
    strength: "recommended",
    applicability: {},
    evidence: [{ provider: "eslint", rule: "no-console", kind: "static", required: true }],
    verification,
  }]),
  pack("platform/unapproved", "platform", [{
    id: "platform/unapproved/score",
    title: "Unapproved provider",
    rationale: "Pending",
    strength: "informational",
    applicability: {},
    evidence: [{ provider: "react-doctor", rule: "score", kind: "static", required: true }],
    verification,
  }]),
];

const registry: RegistrySnapshot = {
  schema: "web-doctor.registry-snapshot",
  schemaVersion: 2,
  webDoctorVersion: "0.1.0",
  webDoctorCommit: "a".repeat(40),
  catalogCommit: "b".repeat(40),
  catalogDigest: DIGEST,
  portals: [{ id: "wealth", lifecycle: "active" }],
  contributions: policies.map((policy) => ({
    id: policy.id,
    type: "policy" as const,
    owner: "fixture",
    source: { schema: "web-doctor.npm-source" as const, schemaVersion: 1 as const, registry: "internal" as const, packageName: `@fixture/${policy.id.replace("/", "-")}`, version: "1.0.0", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, provenance: { repository: "ssh://git.internal/fixture.git", commit: "c".repeat(40) } },
    manifestPath: "web-doctor.json",
    manifestDigest: DIGEST,
    lifecycle: "active" as const,
    compatibility: { webDoctor: ">=0.1.0" },
    portals: policy.layer === "portal" ? ["wealth"] : [],
    layers: [policy.layer],
  })),
  policies,
  providers: [wealthDesign],
  guidance: [],
};

const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry, portalSelection: { cli: ["wealth"] } }) });
const context: ProviderContext = { root: "/work/app", repositoryRoot: null, registryRoot: "/work/registry", registry, providerContributions: {}, snapshot: {} as unknown as ProjectSnapshot, scope: FULL_SCOPE };

function eslintAdapter(drafts: (plan: ProviderPlan) => ProviderExecution["drafts"], fail = false): ProviderAdapter {
  return {
    engine: "eslint",
    async run(plans) {
      if (fail) throw new Error("worker crashed");
      return plans.map((plan) => ({ provider: plan.provider, engineVersion: "9.39.5", completeness: "complete", reason: null, ruleStatus: Object.fromEntries(plan.rules.map((rule) => [rule, "complete" as const])), capabilities: ["filesystem-read"], denied: [], files: 3, drafts: drafts(plan) }));
    },
  };
}

function draft(provider: string, rule: string, path: string, line: number) {
  return { provider: { id: provider, version: "2.0.0", engine: "eslint", engineVersion: "9.39.5", contribution: null }, rule, evidenceKind: "static" as const, locations: [{ kind: "source" as const, path, line, column: 1, endLine: line, endColumn: 10 }], severity: "error" as const, certainty: "observed" as const, classification: "defect" as const, message: `${rule} fired`, completeness: "complete" as const, original: { ruleId: rule } };
}

describe("provider adapter lifecycle", () => {
  it("plans evidence by approved provider, reassigning namespaced ESLint rules and marking unapproved providers", () => {
    const plans = planProviders(policy, registry);
    expect(plans.map((plan) => [plan.provider, plan.engine, plan.rules, plan.unavailable])).toEqual([
      ["axe", "unknown", ["button-name"], "Provider axe is not in the approved catalog"],
      ["eslint", "eslint", ["no-console"], null],
      ["react-doctor", "unknown", ["score"], "Provider react-doctor is not in the approved catalog"],
      ["wealth-design", "eslint", ["use-approved-button"], null],
    ]);
  });

  it("maps findings to applicable Controls and derives outcomes from evidence completeness", async () => {
    const adapter = eslintAdapter((plan) => (plan.provider === "wealth-design"
      ? [draft("wealth-design", "use-approved-button", "src/wealth/Summary.tsx", 4), draft("wealth-design", "use-approved-button", "src/other/Page.tsx", 9)]
      : []));
    const report = await runDiagnostics({ policy, layers: controlLayers(registry), context, adapters: [adapter], gate: "required", mode: "ci" });
    expect(report.findings.map((finding) => [finding.locations[0], finding.controls])).toEqual([
      [expect.objectContaining({ path: "src/wealth/Summary.tsx" }), ["wealth/brand/approved-button"]],
    ]);
    const outcomes = Object.fromEntries(report.controls.map((outcome) => [outcome.control, outcome]));
    expect(outcomes["wealth/brand/approved-button"]).toMatchObject({ status: "not_met", layer: "portal", findings: [report.findings[0]!.id] });
    expect(outcomes["application/engineering/no-console"]).toMatchObject({ status: "met" });
    expect(outcomes["firm/accessibility/button-name"]).toMatchObject({
      status: "incomplete",
      evidence: [expect.objectContaining({ provider: "screen-reader", status: "manual" }), expect.objectContaining({ provider: "axe", status: "unavailable" })],
      reasons: ["Manual review is required and cannot be satisfied automatically", "axe/button-name: Provider axe is not in the approved catalog"],
    });
    expect(report.gate).toMatchObject({ status: "fail", exitCode: EXIT_CODES.fail });

    const again = await runDiagnostics({ policy, layers: controlLayers(registry), context, adapters: [adapter], gate: "required", mode: "ci" });
    expect(again.digest).toBe(report.digest);
    expect(again.findings.map((finding) => finding.id)).toEqual(report.findings.map((finding) => finding.id));
  });

  it("isolates a failing adapter and never reports its Controls as met", async () => {
    const report = await runDiagnostics({ policy, layers: controlLayers(registry), context, adapters: [eslintAdapter(() => [], true)], gate: "recommended", mode: "local" });
    expect(report.runs.find((run) => run.provider === "wealth-design")).toMatchObject({ completeness: "unavailable", reason: "The eslint adapter failed: worker crashed" });
    expect(report.controls.find((outcome) => outcome.control === "wealth/brand/approved-button")!.status).toBe("incomplete");
    expect(report.controls.find((outcome) => outcome.control === "application/engineering/no-console")!.status).toBe("incomplete");
    expect(report.gate).toMatchObject({ status: "pass", exitCode: 0 });
    expect(report.gate.reasons.length).toBeGreaterThan(0);
  });

  it("reports an unavailable rule without hiding the rest of the provider's evidence", async () => {
    const adapter: ProviderAdapter = {
      engine: "eslint",
      async run(plans) {
        return plans.map((plan) => (plan.provider === "eslint" ? { ...unavailable(plan, "no-console is not defined"), completeness: "partial" as const, engineVersion: "9.39.5" } : { provider: plan.provider, engineVersion: "9.39.5", completeness: "complete" as const, reason: null, ruleStatus: { "use-approved-button": "complete" as const }, capabilities: [], denied: [], files: 1, drafts: [] }));
      },
    };
    const report = await runDiagnostics({ policy, layers: controlLayers(registry), context, adapters: [adapter], gate: "required", mode: "ci" });
    expect(report.controls.find((outcome) => outcome.control === "wealth/brand/approved-button")!.status).toBe("met");
    expect(report.controls.find((outcome) => outcome.control === "application/engineering/no-console")).toMatchObject({ status: "incomplete", evidence: [expect.objectContaining({ status: "unavailable" })] });
  });
});
