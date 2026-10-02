import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseContract, parsePolicyPack, type GuidanceEntry, type PolicyPack, type ProviderManifest, type RegistrySnapshot } from "../../src/contracts/index.js";
import { FULL_SCOPE, controlLayers, runDiagnostics, type ProviderAdapter, type ProviderContext } from "../../src/diagnostics/providers.js";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { patternsForFile, recommendForFinding } from "../../src/guidance/patterns.js";
import type { GuidanceSelection } from "../../src/guidance/selection.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const DIGEST = "a".repeat(64);
const verification = [{ kind: "test", description: "Run the focused check." }];

function pack(id: string, layer: PolicyPack["layer"], controls: PolicyPack["controls"]): PolicyPack {
  return { schema: "web-doctor.policy-pack", schemaVersion: 2, id, version: "1.0.0", owner: "Fixture", layer, compatibility: { webDoctor: ">=0.1.0" }, controls };
}

const buttonName = { provider: "axe", rule: "button-name", kind: "rendered" as const, required: true };
const restrictedImports = { provider: "eslint", rule: "no-restricted-imports", kind: "static" as const, required: true };

const policies: PolicyPack[] = [
  pack("firm/accessibility", "firmwide", [{
    id: "firm/accessibility/button-name", title: "Buttons have accessible names", rationale: "Assistive technology announces the name", strength: "required",
    applicability: {}, evidence: [buttonName, { provider: "screen-reader", kind: "manual", required: true }],
    remediation: "Give every button an accessible name with visible text, aria-label, or aria-labelledby.", verification,
  }]),
  pack("firm/engineering", "firmwide", [{
    id: "firm/engineering/restricted-imports", title: "Restricted imports are not used", rationale: "Shared clients own these integrations", strength: "required",
    applicability: {}, evidence: [restrictedImports], remediation: "Remove the restricted import.", verification,
  }]),
  pack("wealth/design", "portal", [{
    id: "wealth/design/icon-button", title: "Icon actions use the Wealth icon button", rationale: "Consistent names and focus styles", strength: "required",
    applicability: {}, evidence: [buttonName], remediation: "Use the Wealth IconButton.", verification,
    patterns: [{ kind: "component", name: "IconButton", module: "@wealth/ui", usage: "Render icon-only actions as <IconButton icon={...} label={...} />; label becomes the accessible name.", replaces: { modules: ["@mui/material/IconButton"] } }],
  }]),
  pack("advisor/design", "portal", [{
    id: "advisor/design/icon-button", title: "Icon actions use the Advisor action button", rationale: "Advisor toolbars share one action control", strength: "required",
    applicability: {}, evidence: [buttonName], verification,
    patterns: [{ kind: "component", name: "ActionButton", module: "@advisor/ui", usage: "Render icon-only actions as <ActionButton icon={...} title={...} />." }],
  }]),
  pack("platform/analytics", "platform", [{
    id: "platform/analytics/approved-client", title: "Analytics goes through the firm client", rationale: "Consent and data classification", strength: "required",
    applicability: { files: { include: ["src/checkout/**"] } }, evidence: [restrictedImports], verification,
    patterns: [
      { kind: "api", name: "track", module: "@firm/analytics", usage: "Call track(event, properties) with an approved event name.", replaces: { modules: ["@adobe/alloy"] } },
      { kind: "analytics-event", name: "checkout.payment_submitted", usage: "Emit when the payment form submits successfully." },
    ],
  }, {
    id: "platform/analytics/tokens", title: "Checkout uses design tokens", rationale: "Theming", strength: "recommended",
    applicability: { files: { include: ["src/checkout/**"] } }, evidence: [{ provider: "design-review", kind: "manual", required: true }], verification,
    patterns: [
      { kind: "design-token", name: "color.action.primary", module: "@firm/tokens", usage: "Use the token instead of a literal color for primary actions." },
      { kind: "runtime-integration", name: "registerMicrofrontend", module: "@firm/runtime", usage: "Register the checkout microfrontend through the firm runtime.", replaces: { modules: ["single-spa"] } },
    ],
  }]),
  pack("application/content", "application", [{
    id: "application/content/action-labels", title: "Actions use application terms", rationale: "Consistent vocabulary", strength: "recommended",
    applicability: {}, evidence: [{ ...buttonName, required: false }, { provider: "content-review", kind: "manual", required: true }], verification,
    patterns: [{ kind: "content-term", name: "Account settings", usage: "Label the account action \"Account settings\".", replaces: { terms: ["Profile", "Settings"] } }],
  }]),
];

const axe: ProviderManifest = {
  schema: "web-doctor.provider-manifest", schemaVersion: 1, id: "axe", version: "4.13.0", owner: "Fixture", adapterVersion: "1.0.0", engine: "axe-core", engineRange: "^4.13.0",
  compatibility: { webDoctor: ">=0.1.0" }, evidenceKinds: ["rendered"], completeness: ["complete", "partial", "unavailable"], capabilities: ["browser"], invocationModes: ["runtime"],
  rules: [{ id: "button-name", title: "Buttons have discernible text", evidenceKind: "rendered" }], artifacts: [{ path: "scan.mjs", digest: DIGEST }],
};

function registryOf(selected: readonly PolicyPack[], guidance: GuidanceEntry[] = []): RegistrySnapshot {
  return {
    schema: "web-doctor.registry-snapshot", schemaVersion: 2, webDoctorVersion: "0.1.0", webDoctorCommit: "a".repeat(40), catalogCommit: "b".repeat(40), catalogDigest: DIGEST,
    portals: [{ id: "wealth", lifecycle: "active" }, { id: "advisor", lifecycle: "active" }, { id: "retail", lifecycle: "active" }],
    contributions: selected.map((policy) => ({
      id: policy.id, type: "policy" as const, owner: "fixture",
      source: { schema: "web-doctor.npm-source" as const, schemaVersion: 1 as const, registry: "internal" as const, packageName: `@fixture/${policy.id.replace("/", "-")}`, version: "1.0.0", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, provenance: { repository: "ssh://git.internal/fixture.git", commit: "c".repeat(40) } },
      manifestPath: "web-doctor.json", manifestDigest: DIGEST, lifecycle: "active" as const, compatibility: { webDoctor: ">=0.1.0" },
      portals: policy.id.startsWith("wealth/") ? ["wealth"] : policy.id.startsWith("advisor/") ? ["advisor"] : [], layers: [policy.layer],
    })),
    policies: [...selected], providers: [axe], guidance,
  };
}

const RENDERED = { kind: "rendered" as const, url: "http://127.0.0.1:4000/orders", route: "/orders", state: "toolbar", viewport: { width: 1280, height: 800 }, target: ["#toolbar > button"] };

const adapters: ProviderAdapter[] = [
  {
    engine: "axe-core",
    async run(plans) {
      return plans.map((plan) => ({
        provider: plan.provider, engineVersion: "4.13.0", completeness: "complete" as const, reason: null, ruleStatus: { "button-name": "complete" as const }, capabilities: ["browser" as const], denied: [], files: 0, testedScope: ["http://127.0.0.1:4000/orders (toolbar)"],
        drafts: [{ provider: { id: "axe", version: "4.13.0", engine: "axe-core", engineVersion: "4.13.0", contribution: null }, rule: "button-name", evidenceKind: "rendered" as const, locations: [RENDERED], severity: "error" as const, certainty: "observed" as const, classification: "defect" as const, message: "Buttons must have discernible text", completeness: "complete" as const, original: { id: "button-name" } }],
      }));
    },
  },
  {
    engine: "eslint",
    async run(plans) {
      const at = (file: string) => ({ provider: { id: "eslint", version: "9.39.5", engine: "eslint", engineVersion: "9.39.5", contribution: null }, rule: "no-restricted-imports", evidenceKind: "static" as const, locations: [{ kind: "source" as const, path: file, line: 1, column: 1, endLine: 1, endColumn: 30 }], severity: "error" as const, certainty: "observed" as const, classification: "defect" as const, message: "'@adobe/alloy' import is restricted", completeness: "complete" as const, original: { ruleId: "no-restricted-imports" } });
      return plans.map((plan) => ({ provider: plan.provider, engineVersion: "9.39.5", completeness: "complete" as const, reason: null, ruleStatus: { "no-restricted-imports": "complete" as const }, capabilities: ["filesystem-read" as const], denied: [], files: 2, drafts: [at("src/checkout/Pay.tsx"), at("src/legacy/Old.tsx")] }));
    },
  },
];

let workspace: string;
let snapshot: ProjectSnapshot;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-patterns-")));
  await materialize(workspace, {
    "package.json": '{"name":"checkout","dependencies":{"react":"18.3.1"}}\n',
    "src/checkout/Pay.tsx": 'import { createInstance } from "@adobe/alloy";\nimport { registerApplication } from "single-spa";\n\nexport function Pay() {\n  createInstance({ name: "alloy" });\n  registerApplication;\n  return <form />;\n}\n',
    "src/legacy/Old.tsx": 'import { createInstance } from "@adobe/alloy";\n\nexport function Old() {\n  createInstance({ name: "alloy" });\n  return null;\n}\n',
  });
  const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: path.resolve(import.meta.dirname, "../..") }) });
  snapshot = await analyzeProject({ root: workspace, repositoryRoot: workspace, analyzer });
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function findingsFor(portals: string[], selected: readonly PolicyPack[] = policies) {
  const registry = registryOf(selected);
  const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry, portalSelection: { cli: portals } }) });
  const context: ProviderContext = { root: workspace, repositoryRoot: null, registryRoot: workspace, registry, providerContributions: {}, snapshot, scope: FULL_SCOPE, runtime: { authorized: true, targets: [{ url: RENDERED.url, state: RENDERED.state }] } };
  const report = await runDiagnostics({ policy, layers: controlLayers(registry), context, adapters, gate: "required", mode: "local" });
  const byRule = (rule: string, file?: string) => report.findings.find((finding) => finding.rule === rule && (file === undefined || finding.locations.some((location) => location.kind === "source" && location.path === file)))!;
  return { registry, policy, layers: controlLayers(registry), byRule };
}

describe("approved enterprise patterns", () => {
  it("keeps generic remediation when no effective Control supplies a pattern", async () => {
    const { policy, layers, byRule } = await findingsFor(["retail"]);
    const recommendation = recommendForFinding({ finding: byRule("button-name"), policy, layers });
    expect(recommendation).toMatchObject({ status: "generic", conflicts: [], mandatory: false, generic: { remediation: ["Give every button an accessible name with visible text, aria-label, or aria-labelledby."], replaced: false } });
    expect(recommendation.reason).toBe("No effective Control supplies a substitute pattern; generic remediation applies with the approved terms");
    expect(recommendation.approved.map((pattern) => [pattern.role, pattern.name])).toEqual([["refinement", "Account settings"]]);
    expect(recommendation.obligations.map((obligation) => obligation.control)).toEqual(["application/content/action-labels", "firm/accessibility/button-name"]);
  });

  it("recommends the approved component and application term while retaining the firmwide requirement", async () => {
    const { policy, layers, byRule } = await findingsFor(["wealth"]);
    const finding = byRule("button-name");
    const recommendation = recommendForFinding({ finding, policy, layers });
    expect(recommendation.status).toBe("approved");
    expect(recommendation.approved.map((pattern) => [pattern.role, pattern.kind, pattern.name, pattern.module, pattern.mandatory, pattern.sources.map((source) => `${source.layer}:${source.control}`)])).toEqual([
      ["substitute", "component", "IconButton", "@wealth/ui", true, ["portal:wealth/design/icon-button"]],
      ["refinement", "content-term", "Account settings", null, false, ["application:application/content/action-labels"]],
    ]);
    expect(recommendation.generic).toEqual({ remediation: ["Give every button an accessible name with visible text, aria-label, or aria-labelledby."], replaced: true });
    expect(recommendation.obligations).toEqual(finding.obligations);
    expect(recommendation.obligations.map((obligation) => [obligation.layer, obligation.control])).toEqual([
      ["application", "application/content/action-labels"],
      ["firmwide", "firm/accessibility/button-name"],
      ["portal", "wealth/design/icon-button"],
    ]);
    expect(recommendation).toMatchObject({ mandatory: true, modifiesProject: false, policyDigest: policy.digest });
  });

  it("reports a conflict instead of choosing between Controls that require different patterns", async () => {
    const { policy, layers, byRule } = await findingsFor(["wealth", "advisor"]);
    const recommendation = recommendForFinding({ finding: byRule("button-name"), policy, layers });
    expect(recommendation.status).toBe("conflict");
    expect(recommendation.generic.replaced).toBe(false);
    expect(recommendation.conflicts).toHaveLength(1);
    expect(recommendation.conflicts[0]!.message).toBe("advisor/design/icon-button, wealth/design/icon-button require different approved component patterns: ActionButton from @advisor/ui, IconButton from @wealth/ui");
    expect(recommendation.approved.map((pattern) => pattern.name)).toEqual(["Account settings"]);
  });

  it("accumulates a pattern that every contributing Control accepts", async () => {
    const shared = pack("advisor/design", "portal", [{ ...policies[3]!.controls[0]!, patterns: [policies[3]!.controls[0]!.patterns![0]!, policies[2]!.controls[0]!.patterns![0]!] }]);
    const { policy, layers, byRule } = await findingsFor(["wealth", "advisor"], policies.map((candidate) => (candidate.id === "advisor/design" ? shared : candidate)));
    const recommendation = recommendForFinding({ finding: byRule("button-name"), policy, layers });
    expect(recommendation.status).toBe("approved");
    expect(recommendation.approved.find((pattern) => pattern.kind === "component")).toMatchObject({ name: "IconButton", sources: [{ control: "advisor/design/icon-button" }, { control: "wealth/design/icon-button" }] });
  });

  it("replaces generic remediation only where the pattern's Control applies to the finding's file", async () => {
    const { policy, layers, byRule } = await findingsFor(["retail"]);
    const inScope = recommendForFinding({ finding: byRule("no-restricted-imports", "src/checkout/Pay.tsx"), policy, layers });
    const outOfScope = recommendForFinding({ finding: byRule("no-restricted-imports", "src/legacy/Old.tsx"), policy, layers });
    expect(inScope).toMatchObject({ status: "approved", generic: { remediation: ["Remove the restricted import."], replaced: true } });
    expect(inScope.approved.map((pattern) => pattern.name)).toEqual(["checkout.payment_submitted", "track"]);
    expect(outOfScope).toMatchObject({ status: "generic", approved: [], generic: { remediation: ["Remove the restricted import."], replaced: false } });
  });

  it("keeps generic remediation for a finding from another effective policy", async () => {
    const { layers, byRule } = await findingsFor(["wealth"]);
    const { policy: other } = await findingsFor(["retail"]);
    const recommendation = recommendForFinding({ finding: byRule("button-name"), policy: other, layers });
    expect(recommendation).toMatchObject({ status: "stale", approved: [], generic: { replaced: false } });
  });

  it("adds registry guidance alternatives to generic remediation without letting them override a pattern", async () => {
    const { policy, layers, byRule } = await findingsFor(["wealth"]);
    const finding = byRule("button-name");
    const entry: GuidanceEntry = { schema: "web-doctor.guidance-entry", schemaVersion: 1, id: "accessibility/icon-button-name", version: "1.0.0", owner: "Accessibility", applicability: {}, evidencePrerequisites: ["rendered"], classification: "defect", explanation: "Icon-only buttons need a name.", alternatives: ["Add aria-label to the button"], tradeoffs: [], verification, controls: ["firm/accessibility/button-name"] };
    const selection = { guidance: entry.id, status: "applicable", findings: [finding.id], entry } as unknown as GuidanceSelection;
    const recommendation = recommendForFinding({ finding, policy, layers, guidance: [selection] });
    expect(recommendation.status).toBe("approved");
    expect(recommendation.generic.remediation).toEqual(["Give every button an accessible name with visible text, aria-label, or aria-labelledby.", "Add aria-label to the button"]);
  });

  it("offers file patterns with the superseded imports the source index finds", async () => {
    const { policy, layers } = await findingsFor(["retail"]);
    const checkout = patternsForFile({ policy, layers, snapshot, file: "src/checkout/Pay.tsx" });
    expect(checkout.patterns.map((pattern) => [pattern.kind, pattern.name, pattern.mandatory, pattern.occurrences.map((occurrence) => `${occurrence.specifier}@${occurrence.line}`)])).toEqual([
      ["analytics-event", "checkout.payment_submitted", true, []],
      ["api", "track", true, ["@adobe/alloy@1"]],
      ["design-token", "color.action.primary", false, []],
      ["runtime-integration", "registerMicrofrontend", false, ["single-spa@2"]],
      ["content-term", "Account settings", false, []],
    ]);
    const legacy = patternsForFile({ policy, layers, snapshot, file: "src/legacy/Old.tsx" });
    expect(legacy.patterns.map((pattern) => pattern.name)).toEqual(["Account settings"]);
    expect(legacy.patterns[0]!.occurrences).toEqual([]);
  });

  it("reads version 1 policy packs as version 2 packs without patterns", () => {
    const v1 = { ...policies[0]!, schemaVersion: 1 };
    expect(parseContract("policyPack", v1)).toEqual(v1);
    expect(parsePolicyPack(v1)).toEqual({ ...v1, schemaVersion: 2 });
    expect(() => parseContract("policyPack", { ...policies[2]!, schemaVersion: 1 })).toThrow();
    const duplicate = { ...policies[2]!, controls: [{ ...policies[2]!.controls[0]!, patterns: [policies[2]!.controls[0]!.patterns![0]!, policies[2]!.controls[0]!.patterns![0]!] }] };
    expect(() => parseContract("policyPack", duplicate)).toThrow(/Duplicate component pattern IconButton/);
  });
});

