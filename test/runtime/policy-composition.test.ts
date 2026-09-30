import { describe, expect, it } from "vitest";
import type { PolicyControl, PolicyPack, RegistrySnapshot } from "../../src/contracts/index.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";

describe("additive policy composition", () => {
  it("accumulates every layer and retains a firmwide Control against lower weakening and disablement", () => {
    const registry = snapshot([
      policy("firm/control", "firmwide", "required", "firm/control", "security-approved"),
      policy("portal/control", "portal", "required"),
      policy("platform/control", "platform", "recommended"),
      policy("application/control", "application", "informational"),
      policy("application/weaken", "application", "recommended", "firm/control"),
    ]);
    const result = composePolicy({
      registry,
      portalSelection: { cli: ["wealth", "wealth"], repository: ["wealth"] },
      directives: [{ controlId: "firm/control", action: "disable", layer: "application" }],
    });

    expect(result.portals).toEqual(["wealth"]);
    expect(result.controls.map((entry) => entry.control.id)).toEqual([
      "application/control", "firm/control", "platform/control", "portal/control",
    ]);
    expect(result.controls.find((entry) => entry.control.id === "firm/control")?.control.strength).toBe("required");
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.stringContaining("cannot weaken firm/control"),
      expect.stringContaining("cannot disable firm/control"),
    ]));
  });

  it("applies an explicit exception authorized by the higher Control", () => {
    const registry = snapshot([policy("firm/control", "firmwide", "required", "firm/control", "security-approved")]);
    const result = composePolicy({
      registry,
      directives: [{
        controlId: "firm/control",
        action: "disable",
        layer: "application",
        exceptionId: "exceptions/approved-1",
        authorization: "security-approved",
      }],
    });
    expect(result.controls).toEqual([]);
    expect(result.exceptions).toEqual(["exceptions/approved-1"]);
    expect(result.conflicts).toEqual([]);
  });

  it("filters portal contributions and preserves unresolved portal obligations", () => {
    const registry = snapshot([policy("portal/control", "portal", "required")]);
    expect(composePolicy({ registry, portalSelection: { cli: ["advisor"] } }).controls).toEqual([]);
    expect(composePolicy({ registry }).unresolvedApplicability).toEqual(["portal/control"]);
  });
});

function policy(
  id: string,
  layer: PolicyPack["layer"],
  strength: PolicyControl["strength"],
  controlId = id,
  exceptionPolicy?: string,
): PolicyPack {
  return {
    schema: "web-doctor.policy-pack",
    schemaVersion: 1,
    id,
    version: "1.0.0",
    owner: `${id} owner`,
    layer,
    compatibility: { webDoctor: ">=0.1.0" },
    controls: [{
      id: controlId,
      title: id,
      rationale: `Apply ${id}.`,
      strength,
      applicability: {},
      evidence: [{ provider: "eslint", rule: id, kind: "static", required: true }],
      verification: [{ kind: "test", description: `Verify ${id}.` }],
      ...(exceptionPolicy === undefined ? {} : { exceptionPolicy }),
    }],
  };
}

function snapshot(policies: PolicyPack[]): RegistrySnapshot {
  return {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 1,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: "a".repeat(40),
    catalogCommit: "b".repeat(40),
    catalogDigest: "c".repeat(64),
    portals: [{ id: "wealth", lifecycle: "active" }],
    contributions: policies.map((entry) => ({
      id: entry.id,
      type: "policy",
      owner: entry.id,
      source: {
        schema: "web-doctor.npm-source",
        schemaVersion: 1,
        registry: "internal",
        packageName: `@fixture/${entry.id.replace("/", "-")}`,
        version: "1.0.0",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        provenance: { repository: `ssh://git.internal/${entry.id}.git`, commit: "d".repeat(40) },
      },
      manifestPath: "web-doctor.json",
      manifestDigest: "e".repeat(64),
      lifecycle: "active",
      compatibility: entry.compatibility,
      portals: layerPortals(entry.layer),
      layers: [entry.layer],
    })),
    policies,
    providers: [],
    guidance: [],
  };
}

function layerPortals(layer: PolicyPack["layer"]): string[] {
  return layer === "portal" ? ["wealth"] : [];
}