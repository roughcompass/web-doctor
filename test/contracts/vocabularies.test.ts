import { describe, expect, it } from "vitest";
import {
  evidenceKindSchema,
  factCertaintySchema,
  lifecycleSchema,
  mcpResponseSchema,
  normalizedFindingSchema,
  providerCapabilitySchema,
  providerCompletenessSchema,
  providerManifestSchema,
  requirementStrengthSchema,
} from "../../src/contracts/index.js";

const DIGEST = "a".repeat(64);

describe("contract vocabularies", () => {
  it("rejects unsupported vocabulary values", () => {
    for (const [schema, value] of [
      [providerCapabilitySchema, "shell-root"],
      [evidenceKindSchema, "guess"],
      [providerCompletenessSchema, "mostly"],
      [requirementStrengthSchema, "mandatory-ish"],
      [lifecycleSchema, "deleted"],
      [factCertaintySchema, "probably"],
    ] as const) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects rendered providers without browser capability", () => {
    expect(
      providerManifestSchema.safeParse({
        schema: "web-doctor.provider-manifest",
        schemaVersion: 1,
        id: "axe",
        version: "4.13.0",
        owner: "Web Platform",
        adapterVersion: "1",
        engine: "axe-core",
        engineRange: "^4.13.0",
        compatibility: { webDoctor: ">=0.1.0" },
        evidenceKinds: ["rendered"],
        completeness: ["complete"],
        capabilities: ["filesystem-read"],
        invocationModes: ["runtime"],
        rules: [{ id: "button-name", title: "Button name", evidenceKind: "rendered" }],
        artifacts: [{ path: "dist/provider.js", digest: DIGEST }],
      }).success,
    ).toBe(false);
  });

  it("rejects unavailable evidence represented as a proven defect", () => {
    expect(
      normalizedFindingSchema.safeParse({
        schema: "web-doctor.finding",
        schemaVersion: 1,
        id: "finding/example",
        provider: "axe",
        providerVersion: "4.13.0",
        rule: "button-name",
        evidenceKind: "rendered",
        locations: [],
        severity: "warning",
        certainty: "unknown",
        classification: "defect",
        message: "The browser did not start.",
        controls: [],
        remediation: [],
        verification: [],
        completeness: "unavailable",
        registryDigest: DIGEST,
        policyDigest: DIGEST,
      }).success,
    ).toBe(false);
  });

  it("rejects truncated MCP responses without continuation", () => {
    expect(
      mcpResponseSchema.safeParse({
        schema: "web-doctor.mcp-response",
        schemaVersion: 1,
        requestId: "request-1",
        tool: "project_overview",
        complete: false,
        truncated: true,
        evidence: [],
        warnings: [],
        data: {},
      }).success,
    ).toBe(false);
  });
});