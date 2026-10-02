import { describe, expect, it } from "vitest";
import findingExample from "../../examples/contracts/finding.json" with { type: "json" };
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
    const finding = { ...findingExample, certainty: "unknown", message: "The browser did not start.", completeness: "unavailable" };
    expect(normalizedFindingSchema.safeParse(finding).success).toBe(false);
    expect(normalizedFindingSchema.safeParse({ ...finding, classification: "unresolved" }).success).toBe(true);
  });

  it("rejects Controls that do not match the finding's obligations", () => {
    const finding = findingExample;
    expect(normalizedFindingSchema.safeParse({ ...finding, controls: ["firm/accessibility/button-name"] }).success).toBe(false);
  });

  it("rejects truncated MCP responses without continuation", () => {
    expect(
      mcpResponseSchema.safeParse({
        schema: "web-doctor.mcp-response",
        schemaVersion: 2,
        requestId: "request-1",
        tool: "project_overview",
        complete: false,
        truncated: true,
        provenance: {
          webDoctor: { version: "0.1.0", commit: "c".repeat(40), registryDigest: "a".repeat(64), catalogCommit: "c".repeat(40), catalogDigest: "a".repeat(64) },
          repoFacts: { status: "unavailable", reason: "not installed", release: null, commit: null, configurationDigest: null, factDocumentDigest: null, incompleteCategories: [] },
          extensions: null,
          project: null,
          policy: null,
        },
        update: null,
        evidence: [],
        warnings: [],
        data: {},
      }).success,
    ).toBe(false);
  });
});