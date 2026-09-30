import { describe, expect, it } from "vitest";
import {
  UnsupportedSchemaVersionError,
  contractSchemas,
  parseContract,
  type ContractKind,
} from "../../src/contracts/index.js";

const DIGEST = "a".repeat(64);
const COMMIT = "c".repeat(40);
const INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const compatibility = { webDoctor: ">=0.1.0" };
const location = { path: "src/App.tsx", line: 1, column: 1 };
const verification = { kind: "test", description: "Run the focused test" };
const control = {
  id: "firm/accessibility/button-name",
  title: "Buttons have accessible names",
  rationale: "Interactive controls need an accessible name.",
  strength: "required",
  applicability: {},
  evidence: [{ provider: "axe", rule: "button-name", kind: "rendered", required: true }],
  verification: [verification],
};
const provenance = { repository: "ssh://git.internal/firm/accessibility.git", commit: COMMIT };
const npmSource = {
  schema: "web-doctor.npm-source",
  schemaVersion: 1,
  registry: "internal",
  packageName: "@firm/accessibility-policy",
  version: "1.0.0",
  integrity: INTEGRITY,
  provenance,
};
const catalogEntry = {
  id: "firm/accessibility",
  type: "policy",
  owner: "enterprise-accessibility",
  source: npmSource,
  manifestPath: "web-doctor.json",
  portals: [],
  layers: ["firmwide"],
  compatibility,
  lifecycle: "active",
  dependencies: [],
};
const contributionReference = {
  id: "firm/accessibility",
  type: "policy",
  owner: "enterprise-accessibility",
  source: npmSource,
  manifestPath: "web-doctor.json",
  manifestDigest: DIGEST,
  lifecycle: "active",
  compatibility,
  portals: [],
  layers: ["firmwide"],
};

const fixtures = {
  internalNpmSource: npmSource,
  contribution: {
    schema: "web-doctor.contribution",
    schemaVersion: 1,
    id: "firm/accessibility",
    type: "policy",
    owner: "Enterprise Accessibility",
    compatibility,
    portals: [],
    layers: ["firmwide"],
    documents: [{ kind: "policy", path: "policy.json" }],
    runtimeArtifacts: [],
    dependencies: [],
    fixtures: ["fixtures/policy.json"],
    provenance,
  },
  contributionFixture: {
    schema: "web-doctor.fixture",
    schemaVersion: 1,
    id: "policy/accept",
    contract: "policyPack",
    input: "fixtures/policy-input.json",
    expected: "accept",
  },
  policyPack: {
    schema: "web-doctor.policy-pack",
    schemaVersion: 1,
    id: "firm/accessibility",
    version: "1.0.0",
    owner: "Enterprise Accessibility",
    layer: "firmwide",
    compatibility,
    controls: [control],
  },
  providerManifest: {
    schema: "web-doctor.provider-manifest",
    schemaVersion: 1,
    id: "axe",
    version: "4.13.0",
    owner: "Web Platform",
    adapterVersion: "1",
    engine: "axe-core",
    engineRange: "^4.13.0",
    compatibility,
    evidenceKinds: ["rendered"],
    completeness: ["complete", "partial", "unavailable"],
    capabilities: ["browser"],
    invocationModes: ["runtime"],
    rules: [{ id: "button-name", title: "Button has an accessible name", evidenceKind: "rendered" }],
    artifacts: [{ path: "dist/provider.js", digest: DIGEST }],
  },
  catalog: {
    schema: "web-doctor.catalog",
    schemaVersion: 1,
    portals: [{ id: "wealth", lifecycle: "active" }],
    entries: [catalogEntry],
  },
  registryOwnership: {
    schema: "web-doctor.registry-ownership",
    schemaVersion: 1,
    platformReviewTeam: "@platform/web-doctor",
    owners: [
      {
        id: "enterprise-accessibility",
        name: "Enterprise Accessibility",
        codeownersTeam: "@firm/accessibility",
        namespaces: ["firm/accessibility"],
        portals: [],
      },
    ],
  },
  contributionLock: {
    schema: "web-doctor.contribution-lock",
    schemaVersion: 1,
    catalogDigest: DIGEST,
    contributions: [{ ...catalogEntry, manifestDigest: DIGEST, contractVersion: 1, resolvedDependencies: [] }],
  },
  registrySnapshot: {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 1,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: COMMIT,
    catalogCommit: COMMIT,
    catalogDigest: DIGEST,
    portals: [{ id: "wealth", lifecycle: "active" }],
    contributions: [contributionReference],
    policies: [],
    providers: [],
    guidance: [],
  },
  effectivePolicySnapshot: {
    schema: "web-doctor.effective-policy",
    schemaVersion: 1,
    digest: DIGEST,
    registryDigest: DIGEST,
    resolverVersion: "0.1.0",
    portals: ["wealth"],
    capabilities: { react: "observed" },
    contributions: [contributionReference],
    controls: [{ control, policyContribution: contributionReference }],
    exceptions: [],
    conflicts: [],
    unresolvedApplicability: [],
  },
  normalizedFinding: {
    schema: "web-doctor.finding",
    schemaVersion: 1,
    id: "finding/button-name",
    provider: "axe",
    providerVersion: "4.13.0",
    rule: "button-name",
    evidenceKind: "rendered",
    locations: [location],
    severity: "error",
    certainty: "observed",
    classification: "defect",
    message: "Button has no accessible name.",
    controls: ["firm/accessibility/button-name"],
    remediation: ["Give the button an accessible name."],
    verification: [verification],
    completeness: "complete",
    registryDigest: DIGEST,
    policyDigest: DIGEST,
  },
  guidanceEntry: {
    schema: "web-doctor.guidance-entry",
    schemaVersion: 1,
    id: "react/upgrade/19",
    version: "1.0.0",
    owner: "Web Platform",
    applicability: { capabilities: [{ name: "react", range: "<19" }] },
    evidencePrerequisites: ["static"],
    classification: "risk",
    explanation: "Prepare removed APIs before upgrading React.",
    alternatives: ["Upgrade through a supported intermediate release."],
    tradeoffs: ["A staged upgrade takes longer but isolates compatibility failures."],
    verification: [verification],
    controls: [],
  },
  mcpResponse: {
    schema: "web-doctor.mcp-response",
    schemaVersion: 1,
    requestId: "request-1",
    tool: "project_overview",
    complete: true,
    truncated: false,
    registryDigest: DIGEST,
    evidence: [location],
    warnings: [],
    data: { framework: "vite" },
  },
} as const;

describe("contract schemas", () => {
  it("parses a valid fixture for every versioned document", () => {
    for (const [kind, fixture] of Object.entries(fixtures) as [ContractKind, unknown][]) {
      expect(() => contractSchemas[kind].parse(fixture)).not.toThrow();
      expect(parseContract(kind, fixture)).toEqual(fixture);
    }
  });

  it("reports unsupported versions before structural validation", () => {
    for (const [kind, fixture] of Object.entries(fixtures) as [ContractKind, Record<string, unknown>][]) {
      expect(() => parseContract(kind, { ...fixture, schemaVersion: 99 })).toThrow(
        new UnsupportedSchemaVersionError(kind, 99, [1]),
      );
    }
  });

  it.each(["^1.2.3", "latest", "npm:other@1.2.3", "git+ssh://git.internal/example.git#main"])(
    "rejects floating npm source version %s",
    (version) => {
      expect(() => contractSchemas.internalNpmSource.parse({ ...npmSource, version })).toThrow(
        /exact version/,
      );
    },
  );

  it("rejects alternate registries, missing integrity, and non-SHA-512 integrity", () => {
    expect(contractSchemas.internalNpmSource.safeParse({ ...npmSource, registry: "public" }).success).toBe(false);
    expect(contractSchemas.internalNpmSource.safeParse({ ...npmSource, integrity: undefined }).success).toBe(false);
    expect(
      contractSchemas.internalNpmSource.safeParse({
        ...npmSource,
        integrity: `sha256-${Buffer.alloc(32, 1).toString("base64")}`,
      }).success,
    ).toBe(false);
  });

  it.each(["../policy", "https://registry.internal/policy.tgz", "@missing-scope"])(
    "rejects invalid npm package name %s",
    (packageName) => {
      expect(contractSchemas.internalNpmSource.safeParse({ ...npmSource, packageName }).success).toBe(false);
    },
  );

  it("requires source repository and immutable commit provenance", () => {
    expect(
      contractSchemas.internalNpmSource.safeParse({ ...npmSource, provenance: { commit: COMMIT } }).success,
    ).toBe(false);
    expect(
      contractSchemas.internalNpmSource.safeParse({
        ...npmSource,
        provenance: { ...provenance, commit: "main" },
      }).success,
    ).toBe(false);
  });

  it.each(["/web-doctor.json", "../web-doctor.json", "metadata\\web-doctor.json", "./web-doctor.json"])(
    "rejects unsafe package path %s",
    (manifestPath) => {
      expect(contractSchemas.catalog.safeParse({ ...fixtures.catalog, entries: [{ ...catalogEntry, manifestPath }] }).success).toBe(false);
    },
  );
});