import { describe, expect, it } from "vitest";
import type { RegistrySnapshot } from "../../src/contracts/index.js";
import { evaluatePortalRequirement } from "../../src/runtime/portal-requirement.js";
import { resolvePortalSelection } from "../../src/runtime/portal-selection.js";

describe("required portal identity", () => {
  it("warns locally but fails CI without claiming conformance", () => {
    const selection = resolvePortalSelection({});
    expect(evaluatePortalRequirement({ mode: "local", required: true, selection, registry: snapshot() })).toEqual({
      status: "warning",
      complete: false,
      canContinue: true,
      exitCode: 0,
      portals: [],
      claimsPortalConformance: false,
      message: "Required portal identity is unresolved",
    });
    expect(evaluatePortalRequirement({ mode: "ci", required: true, selection, registry: snapshot() })).toMatchObject({
      status: "error",
      complete: false,
      canContinue: false,
      exitCode: 2,
      claimsPortalConformance: false,
    });
  });

  it("rejects unknown portal identities and accepts active identities", () => {
    const registry = snapshot();
    expect(evaluatePortalRequirement({
      mode: "ci",
      required: true,
      selection: resolvePortalSelection({ cli: ["unknown"] }),
      registry,
    })).toMatchObject({ status: "error", message: "Unknown or inactive portal identity: unknown" });
    expect(evaluatePortalRequirement({
      mode: "ci",
      required: true,
      selection: resolvePortalSelection({ cli: ["wealth"] }),
      registry,
    })).toMatchObject({ status: "resolved", complete: true, exitCode: 0, portals: ["wealth"] });
  });
});

function snapshot(): RegistrySnapshot {
  return {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 2,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: "a".repeat(40),
    catalogCommit: "b".repeat(40),
    catalogDigest: "c".repeat(64),
    portals: [{ id: "wealth", lifecycle: "active" }, { id: "legacy", lifecycle: "retired" }],
    contributions: [],
    policies: [],
    providers: [],
    guidance: [],
  };
}