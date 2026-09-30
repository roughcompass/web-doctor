import { describe, expect, it } from "vitest";
import { canonicalJson, type PolicyPack, type RegistrySnapshot } from "../../src/contracts/index.js";
import { createEffectivePolicySnapshot, verifyEffectivePolicyDigest } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";

describe("effective policy snapshots", () => {
  it("is permutation-stable and preserves shared evidence across distinct Controls", () => {
    const registry = snapshot();
    const first = createEffectivePolicySnapshot({
      composition: composePolicy({ registry, portalSelection: { cli: ["wealth", "advisor", "wealth"] } }),
      capabilityCertainty: { react: "observed", browser: "inferred" },
    });
    const second = createEffectivePolicySnapshot({
      composition: composePolicy({ registry, portalSelection: { cli: ["advisor", "wealth"] } }),
      capabilityCertainty: { browser: "inferred", react: "observed" },
    });

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.controls).toHaveLength(2);
    expect(first.controls.map((entry) => entry.control.evidence[0]?.rule)).toEqual(["shared-rule", "shared-rule"]);
    expect(first.controls.every((entry) => entry.control.evidence.length === 1)).toBe(true);
    expect(verifyEffectivePolicyDigest(first)).toBe(true);
    expect(verifyEffectivePolicyDigest({ ...first, portals: ["wealth"] })).toBe(false);
  });
});

function snapshot(): RegistrySnapshot {
  const policies: PolicyPack[] = ["advisor", "wealth"].map((portal) => ({
    schema: "web-doctor.policy-pack",
    schemaVersion: 1,
    id: `${portal}/policy`,
    version: "1.0.0",
    owner: `${portal} team`,
    layer: "portal",
    compatibility: { webDoctor: ">=0.1.0" },
    controls: [{
      id: `${portal}/policy/control`,
      title: `${portal} control`,
      rationale: `Apply ${portal} requirements.`,
      strength: "required",
      applicability: { portals: { anyOf: [portal] } },
      evidence: [
        { provider: "eslint", rule: "shared-rule", kind: "static", required: true },
        { provider: "eslint", rule: "shared-rule", kind: "static", required: true },
      ],
      verification: [{ kind: "test", description: "Run shared evidence." }],
    }],
  }));
  return {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 1,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: "a".repeat(40),
    catalogCommit: "b".repeat(40),
    catalogDigest: "c".repeat(64),
    portals: [{ id: "wealth", lifecycle: "active" }, { id: "advisor", lifecycle: "active" }],
    contributions: policies.map((policy) => ({
      id: policy.id,
      type: "policy",
      owner: policy.id,
      source: {
        schema: "web-doctor.npm-source",
        schemaVersion: 1,
        registry: "internal",
        packageName: `@fixture/${policy.id.replace("/", "-")}`,
        version: "1.0.0",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        provenance: { repository: `ssh://git.internal/${policy.id}.git`, commit: "d".repeat(40) },
      },
      manifestPath: "web-doctor.json",
      manifestDigest: "e".repeat(64),
      lifecycle: "active",
      compatibility: policy.compatibility,
      portals: [policy.id.split("/")[0]!],
      layers: ["portal"],
    })),
    policies,
    providers: [],
    guidance: [],
  };
}