import { describe, expect, it } from "vitest";
import { canonicalJson, normalizedFindingSchema, type FindingObligation } from "../../src/contracts/index.js";
import { buildFinding, fingerprintOf, type FindingDraft } from "../../src/diagnostics/finding.js";

const DIGEST = "a".repeat(64);
const firmwide: FindingObligation = {
  control: "firm/accessibility/button-name",
  title: "Buttons have accessible names",
  strength: "required",
  layer: "firmwide",
  policy: "firm/accessibility",
  contribution: "firm/accessibility",
  remediation: "Provide a visible or programmatic accessible name.",
  verification: [{ kind: "axe", description: "Run axe against each rendered interaction state." }],
};
const wealth: FindingObligation = { ...firmwide, control: "wealth/brand/approved-button", title: "Wealth buttons", layer: "portal", policy: "wealth/brand", contribution: "wealth/brand", remediation: "Use the approved Wealth button.", verification: [{ kind: "eslint", description: "Run the Wealth rule." }] };

function draft(line: number): FindingDraft {
  return {
    provider: { id: "wealth-design", version: "1.0.0", engine: "eslint", engineVersion: "9.39.5", contribution: "wealth/design" },
    rule: "use-approved-button",
    evidenceKind: "static",
    locations: [{ kind: "source", path: "src/wealth/Summary.tsx", line, column: 5, endLine: line, endColumn: 21 }],
    severity: "error",
    certainty: "observed",
    classification: "defect",
    message: "Use the approved Wealth button.",
    completeness: "complete",
    original: { ruleId: "wealth-design/use-approved-button", messageId: "approved", severity: 2, callback: () => undefined, long: "x".repeat(900), nested: { a: { b: { c: { d: { e: 1 } } } } } },
    fix: { available: true, description: "Replace the element with WealthButton" },
    anchor: "<button onClick={save}>Save</button>",
  };
}

describe("normalized findings", () => {
  it("builds a valid finding whose identity is stable across repeated runs and input order", () => {
    const first = buildFinding(draft(12), { obligations: [wealth, firmwide], registryDigest: DIGEST, policyDigest: DIGEST });
    const again = buildFinding(draft(12), { obligations: [firmwide, wealth, firmwide], registryDigest: DIGEST, policyDigest: DIGEST });
    expect(normalizedFindingSchema.parse(first)).toEqual(first);
    expect(canonicalJson(again)).toBe(canonicalJson(first));
    expect(first.id).toMatch(/^finding_[0-9a-f]{64}$/);
    expect(first.controls).toEqual(["firm/accessibility/button-name", "wealth/brand/approved-button"]);
    expect(first.remediation).toEqual(["Provide a visible or programmatic accessible name.", "Use the approved Wealth button."]);
    expect(first.verification).toHaveLength(2);
    expect(first.fix).toEqual({ available: true, description: "Replace the element with WealthButton", applied: false });
    expect(first.baseline).toBe("unknown");
  });

  it("changes identity when the location changes but keeps the line-independent fingerprint", () => {
    const original = buildFinding(draft(12), { obligations: [firmwide], registryDigest: DIGEST, policyDigest: DIGEST });
    const moved = buildFinding(draft(40), { obligations: [firmwide], registryDigest: DIGEST, policyDigest: DIGEST });
    expect(moved.id).not.toBe(original.id);
    expect(moved.fingerprint).toBe(original.fingerprint);
    expect(fingerprintOf(draft(40))).toBe(original.fingerprint);
    expect(buildFinding({ ...draft(12), anchor: "<button>Other</button>" }, { obligations: [firmwide], registryDigest: DIGEST, policyDigest: DIGEST }).fingerprint).not.toBe(original.fingerprint);
  });

  it("keeps original provider evidence bounded and free of functions", () => {
    const finding = buildFinding(draft(12), { obligations: [firmwide], registryDigest: DIGEST, policyDigest: DIGEST });
    expect(finding.original).not.toHaveProperty("callback");
    expect((finding.original.long as string).length).toBe(501);
    expect(finding.original.nested).toEqual({ a: { b: { c: null } } });
    expect(finding.original.ruleId).toBe("wealth-design/use-approved-button");
  });
});
