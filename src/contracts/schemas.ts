import semver from "semver";
import * as z from "zod/v4";
import {
  applicabilitySchema,
  compatibilitySchema,
  digestSchema,
  gitCommitSchema,
  identifierSchema,
  internalNpmSourceSchema,
  nonEmptyStringSchema,
  npmIntegritySchema,
  packageArtifactReferenceSchema,
  packagePathSchema,
  sourceLocationSchema,
  sourceProvenanceSchema,
  versionSchema,
  versionedDocumentFields,
} from "./common.js";
import {
  approvedPatternKindSchema,
  evidenceKindSchema,
  factCertaintySchema,
  findingClassificationSchema,
  lifecycleSchema,
  policyLayerSchema,
  providerCapabilitySchema,
  providerCompletenessSchema,
  requirementStrengthSchema,
} from "./vocabularies.js";

const evidenceRequirementSchema = z.strictObject({
  provider: identifierSchema,
  rule: identifierSchema.optional(),
  kind: evidenceKindSchema,
  required: z.boolean(),
}).superRefine((evidence, context) => {
  if (evidence.kind === "manual" && evidence.rule !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["rule"],
      message: "Manual evidence cannot name an executable provider rule",
    });
  }
});

const verificationSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
});

const policyControlFields = {
  id: identifierSchema,
  title: nonEmptyStringSchema,
  rationale: nonEmptyStringSchema,
  strength: requirementStrengthSchema,
  applicability: applicabilitySchema,
  evidence: z.array(evidenceRequirementSchema).min(1),
  remediation: nonEmptyStringSchema.optional(),
  verification: z.array(verificationSchema).min(1),
  exceptionPolicy: nonEmptyStringSchema.optional(),
};

/**
 * An approved enterprise pattern that guidance prefers over generic advice
 * wherever its Control applies: a component, design token, API, analytics
 * event, runtime integration, content term, or remediation pattern.
 */
export const approvedPatternSchema = z.strictObject({
  kind: approvedPatternKindSchema,
  name: nonEmptyStringSchema,
  /** The package or module that provides the pattern. */
  module: nonEmptyStringSchema.optional(),
  usage: nonEmptyStringSchema,
  /** Direct imports and discouraged terms the pattern supersedes. */
  replaces: z.strictObject({
    modules: z.array(nonEmptyStringSchema).min(1).optional(),
    terms: z.array(nonEmptyStringSchema).min(1).optional(),
  }).optional(),
});

export const policyControlV1Schema = z.strictObject(policyControlFields);

export const policyControlSchema = z.strictObject({
  ...policyControlFields,
  patterns: z.array(approvedPatternSchema).min(1).optional(),
}).superRefine((control, context) => {
  const seen = new Set<string>();
  for (const [index, pattern] of (control.patterns ?? []).entries()) {
    const key = `${pattern.kind}\0${pattern.name}\0${pattern.module ?? ""}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["patterns", index], message: `Duplicate ${pattern.kind} pattern ${pattern.name}` });
    seen.add(key);
  }
});

const policyPackFields = {
  id: identifierSchema,
  version: versionSchema,
  owner: nonEmptyStringSchema,
  layer: policyLayerSchema,
  compatibility: compatibilitySchema,
};

/** Policy packs before approved patterns. Still accepted and read as version 2 without patterns. */
export const policyPackV1Schema = z.strictObject({
  ...versionedDocumentFields("web-doctor.policy-pack", 1),
  ...policyPackFields,
  controls: z.array(policyControlV1Schema).min(1),
});

export const policyPackSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.policy-pack", 2),
  ...policyPackFields,
  controls: z.array(policyControlSchema).min(1),
});

const providerRuleSchema = z.strictObject({
  id: identifierSchema,
  title: nonEmptyStringSchema,
  evidenceKind: evidenceKindSchema,
});

export const providerManifestSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.provider-manifest", 1),
  id: identifierSchema,
  version: versionSchema,
  owner: nonEmptyStringSchema,
  adapterVersion: versionSchema,
  engine: identifierSchema,
  engineRange: nonEmptyStringSchema,
  compatibility: compatibilitySchema,
  evidenceKinds: z.array(evidenceKindSchema).min(1),
  completeness: z.array(providerCompletenessSchema).min(1),
  capabilities: z.array(providerCapabilitySchema),
  invocationModes: z.array(identifierSchema).min(1),
  rules: z.array(providerRuleSchema).min(1),
  artifacts: z.array(packageArtifactReferenceSchema).min(1),
}).superRefine((manifest, context) => {
  if (manifest.evidenceKinds.includes("rendered") && !manifest.capabilities.includes("browser")) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "Rendered evidence requires the browser capability",
    });
  }

  const declaredEvidenceKinds = new Set(manifest.evidenceKinds);
  for (const [index, rule] of manifest.rules.entries()) {
    if (!declaredEvidenceKinds.has(rule.evidenceKind)) {
      context.addIssue({
        code: "custom",
        path: ["rules", index, "evidenceKind"],
        message: `Rule evidence kind ${rule.evidenceKind} is not declared by the provider`,
      });
    }
  }

  addDuplicateIssues(manifest.evidenceKinds, ["evidenceKinds"], context);
  addDuplicateIssues(manifest.completeness, ["completeness"], context);
  addDuplicateIssues(manifest.capabilities, ["capabilities"], context);
  addDuplicateIssues(
    manifest.rules.map((rule) => rule.id),
    ["rules"],
    context,
  );
});

const contributionTypeSchema = z.enum(["policy", "provider", "guidance", "adapter"]);
const contributionDocumentKindSchema = z.enum(["policy", "provider", "guidance"]);
const fixtureContractKindSchema = z.enum(["policyPack", "providerManifest", "guidanceEntry"]);

const contributionDocumentSchema = z.strictObject({
  kind: contributionDocumentKindSchema,
  path: packagePathSchema,
});

export const contributionSchema = z
  .strictObject({
    ...versionedDocumentFields("web-doctor.contribution", 1),
    id: identifierSchema,
    type: contributionTypeSchema,
    owner: nonEmptyStringSchema,
    compatibility: compatibilitySchema,
    portals: z.array(identifierSchema),
    layers: z.array(policyLayerSchema),
    documents: z.array(contributionDocumentSchema).min(1),
    runtimeArtifacts: z.array(packageArtifactReferenceSchema),
    dependencies: z.array(identifierSchema),
    fixtures: z.array(packagePathSchema).min(1),
    provenance: sourceProvenanceSchema,
  })
  .superRefine((contribution, context) => {
    const documentKinds = new Set(contribution.documents.map((document) => document.kind));
    const requiredKind = contribution.type === "adapter" ? "provider" : contribution.type;
    if (!documentKinds.has(requiredKind)) {
      context.addIssue({
        code: "custom",
        path: ["documents"],
        message: `Contribution type ${contribution.type} requires a ${requiredKind} document`,
      });
    }
    if ((contribution.type === "provider" || contribution.type === "adapter") && contribution.runtimeArtifacts.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["runtimeArtifacts"],
        message: "Executable contributions require at least one runtime artifact",
      });
    }
    addDuplicateIssues(contribution.portals, ["portals"], context);
    addDuplicateIssues(contribution.layers, ["layers"], context);
    addDuplicateIssues(contribution.dependencies, ["dependencies"], context);
    addDuplicateIssues(contribution.fixtures, ["fixtures"], context);
    addDuplicateIssues(
      contribution.documents.map((document) => `${document.kind}\0${document.path}`),
      ["documents"],
      context,
    );
  });

export const contributionFixtureSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.fixture", 1),
  id: identifierSchema,
  contract: fixtureContractKindSchema,
  input: packagePathSchema,
  expected: z.enum(["accept", "reject"]),
});

const portalSchema = z.strictObject({
  id: identifierSchema,
  lifecycle: lifecycleSchema,
  replacement: identifierSchema.optional(),
}).superRefine((portal, context) => {
  if (portal.lifecycle === "active" && portal.replacement !== undefined) {
    context.addIssue({ code: "custom", path: ["replacement"], message: "An active portal cannot name a replacement" });
  }
  if (portal.replacement === portal.id) {
    context.addIssue({ code: "custom", path: ["replacement"], message: "A portal cannot replace itself" });
  }
});

export const catalogEntrySchema = z.strictObject({
  id: identifierSchema,
  type: contributionTypeSchema,
  owner: identifierSchema,
  source: internalNpmSourceSchema,
  manifestPath: packagePathSchema,
  portals: z.array(identifierSchema),
  layers: z.array(policyLayerSchema),
  compatibility: compatibilitySchema,
  lifecycle: lifecycleSchema,
  replacement: identifierSchema.optional(),
  migration: z.strictObject({
    guidance: nonEmptyStringSchema,
  }).optional(),
  dependencies: z.array(identifierSchema),
}).superRefine((entry, context) => {
  if (entry.lifecycle === "active" && (entry.replacement !== undefined || entry.migration !== undefined)) {
    context.addIssue({ code: "custom", path: ["lifecycle"], message: "An active contribution cannot declare replacement or migration metadata" });
  }
  if (entry.replacement === entry.id) {
    context.addIssue({ code: "custom", path: ["replacement"], message: "A contribution cannot replace itself" });
  }
  addDuplicateIssues(entry.portals, ["portals"], context);
  addDuplicateIssues(entry.layers, ["layers"], context);
  addDuplicateIssues(entry.dependencies, ["dependencies"], context);
});

export const catalogSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.catalog", 1),
  portals: z.array(portalSchema),
  entries: z.array(catalogEntrySchema),
});

const codeownersTeamSchema = nonEmptyStringSchema.regex(/^@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);

const registryOwnerSchema = z.strictObject({
  id: identifierSchema,
  name: nonEmptyStringSchema,
  codeownersTeam: codeownersTeamSchema,
  namespaces: z.array(identifierSchema).min(1),
  portals: z.array(identifierSchema),
});

export const registryOwnershipSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.registry-ownership", 1),
  platformReviewTeam: codeownersTeamSchema,
  owners: z.array(registryOwnerSchema).min(1),
}).superRefine((ownership, context) => {
  addDuplicateIssues(ownership.owners.map((owner) => owner.id), ["owners"], context);
  addDuplicateIssues(ownership.owners.flatMap((owner) => owner.namespaces), ["owners", "namespaces"], context);
  addDuplicateIssues(ownership.owners.flatMap((owner) => owner.portals), ["owners", "portals"], context);
});

const lockedContributionSchema = catalogEntrySchema.extend({
  manifestDigest: digestSchema,
  contractVersion: z.int().positive(),
  resolvedDependencies: z.array(identifierSchema),
});

export const contributionLockSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.contribution-lock", 1),
  catalogDigest: digestSchema,
  contributions: z.array(lockedContributionSchema),
});

const contributionReferenceSchema = z.strictObject({
  id: identifierSchema,
  type: contributionTypeSchema,
  owner: identifierSchema,
  source: internalNpmSourceSchema,
  manifestPath: packagePathSchema,
  manifestDigest: digestSchema,
  lifecycle: lifecycleSchema,
  compatibility: compatibilitySchema,
  portals: z.array(identifierSchema),
  layers: z.array(policyLayerSchema),
});

const effectiveControlSchema = z.strictObject({
  control: policyControlSchema,
  policyContribution: contributionReferenceSchema,
});

/** The project facts an effective policy was resolved from: the pinned shared release and Web Doctor's extension state. */
const policyFactProvenanceSchema = z.strictObject({
  status: z.enum(["complete", "incomplete"]),
  detectorRelease: versionSchema.nullable(),
  configurationDigest: digestSchema.nullable(),
  factDocumentDigest: digestSchema.nullable(),
  extensionStateDigest: digestSchema.nullable(),
});

export const effectivePolicySnapshotSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.effective-policy", 3),
  digest: digestSchema,
  webDoctorVersion: versionSchema,
  registryDigest: digestSchema,
  resolverVersion: versionSchema,
  portals: z.array(identifierSchema),
  capabilities: z.record(identifierSchema, factCertaintySchema),
  facts: policyFactProvenanceSchema,
  contributions: z.array(contributionReferenceSchema),
  controls: z.array(effectiveControlSchema),
  exceptions: z.array(identifierSchema),
  conflicts: z.array(nonEmptyStringSchema),
  unresolvedApplicability: z.array(identifierSchema),
});

const findingLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("source"),
    path: nonEmptyStringSchema,
    line: z.int().positive(),
    column: z.int().positive(),
    endLine: z.int().positive().nullable(),
    endColumn: z.int().positive().nullable(),
  }),
  z.strictObject({
    kind: z.literal("rendered"),
    url: nonEmptyStringSchema,
    route: nonEmptyStringSchema.nullable(),
    state: nonEmptyStringSchema,
    viewport: z.strictObject({ width: z.int().positive(), height: z.int().positive() }),
    target: z.array(nonEmptyStringSchema).min(1),
  }),
]);

const findingProviderSchema = z.strictObject({
  id: identifierSchema,
  version: versionSchema,
  engine: identifierSchema,
  engineVersion: versionSchema,
  contribution: identifierSchema.nullable(),
});

/** One Control's obligation for a finding, with that Control's own remediation and verification. */
const findingObligationSchema = z.strictObject({
  control: identifierSchema,
  title: nonEmptyStringSchema,
  strength: requirementStrengthSchema,
  layer: policyLayerSchema,
  policy: identifierSchema,
  contribution: identifierSchema,
  remediation: nonEmptyStringSchema.nullable(),
  verification: z.array(verificationSchema),
});

export const normalizedFindingSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.finding", 2),
  id: z.string().regex(/^finding_[a-f0-9]{64}$/),
  /** Line-independent identity for comparing runs, such as against a baseline. */
  fingerprint: digestSchema,
  provider: findingProviderSchema,
  rule: nonEmptyStringSchema,
  evidenceKind: evidenceKindSchema,
  locations: z.array(findingLocationSchema).min(1),
  severity: z.enum(["error", "warning", "information"]),
  certainty: factCertaintySchema,
  classification: findingClassificationSchema,
  message: nonEmptyStringSchema,
  controls: z.array(identifierSchema),
  obligations: z.array(findingObligationSchema),
  remediation: z.array(nonEmptyStringSchema),
  verification: z.array(verificationSchema),
  fix: z.strictObject({ available: z.boolean(), description: nonEmptyStringSchema.nullable(), applied: z.literal(false) }),
  /** An in-source suppression the provider reported. It is recorded for review and does not waive a Control. */
  suppression: z.strictObject({ kind: z.literal("inline"), justification: nonEmptyStringSchema.nullable() }).nullable(),
  baseline: z.enum(["introduced", "existing", "unknown"]),
  /** The provider's own evidence, bounded and without source text. */
  original: z.record(z.string(), z.unknown()),
  completeness: providerCompletenessSchema,
  registryDigest: digestSchema,
  policyDigest: digestSchema,
}).superRefine((finding, context) => {
  const obligated = [...new Set(finding.obligations.map((obligation) => obligation.control))].sort();
  if (obligated.join("\0") !== [...finding.controls].sort().join("\0")) {
    context.addIssue({ code: "custom", path: ["controls"], message: "Controls must list exactly the Controls with obligations" });
  }
  if (finding.completeness === "unavailable" && finding.classification !== "unresolved") {
    context.addIssue({
      code: "custom",
      path: ["classification"],
      message: "Unavailable provider evidence must produce an unresolved finding",
    });
  }
  if (finding.completeness === "complete" && finding.classification === "unresolved") {
    context.addIssue({
      code: "custom",
      path: ["classification"],
      message: "A complete finding cannot be unresolved",
    });
  }
});

const providerRunSchema = z.strictObject({
  provider: identifierSchema,
  version: versionSchema,
  engine: identifierSchema,
  engineVersion: versionSchema.nullable(),
  contribution: identifierSchema.nullable(),
  completeness: providerCompletenessSchema,
  reason: nonEmptyStringSchema.nullable(),
  scope: z.strictObject({
    mode: z.enum(["full", "changed-files", "changed-lines"]),
    files: z.int().nonnegative(),
    fullProjectOnly: z.boolean(),
  }),
  capabilities: z.array(providerCapabilitySchema),
  denied: z.array(nonEmptyStringSchema),
  rules: z.array(nonEmptyStringSchema),
  findings: z.int().nonnegative(),
  /** For rendered providers, each target that was tested: URL, state, and viewport. */
  testedScope: z.array(nonEmptyStringSchema),
});

const controlOutcomeSchema = z.strictObject({
  control: identifierSchema,
  title: nonEmptyStringSchema,
  strength: requirementStrengthSchema,
  layer: policyLayerSchema,
  status: z.enum(["met", "not_met", "incomplete", "not_evaluated"]),
  evidence: z.array(z.strictObject({
    provider: identifierSchema,
    rule: nonEmptyStringSchema.nullable(),
    kind: evidenceKindSchema,
    required: z.boolean(),
    status: z.enum(["complete", "partial", "unavailable", "not_run", "manual", "out_of_scope"]),
    findings: z.int().nonnegative(),
  })),
  findings: z.array(z.string().regex(/^finding_[a-f0-9]{64}$/)),
  reasons: z.array(nonEmptyStringSchema),
  /** What the evidence cannot establish, such as conformance beyond the tested rendered states. */
  limitations: z.array(nonEmptyStringSchema),
  /** Verification that automated evidence does not satisfy and that remains after this run. */
  obligations: z.array(z.strictObject({ kind: nonEmptyStringSchema, description: nonEmptyStringSchema, source: nonEmptyStringSchema })),
});

export const diagnosticsReportSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.diagnostics-report", 1),
  digest: digestSchema,
  registryDigest: digestSchema,
  policyDigest: digestSchema,
  scope: z.strictObject({
    mode: z.enum(["full", "changed-files", "changed-lines"]),
    files: z.array(nonEmptyStringSchema),
    base: nonEmptyStringSchema.nullable(),
    baseline: digestSchema.nullable(),
  }),
  runs: z.array(providerRunSchema),
  findings: z.array(normalizedFindingSchema),
  controls: z.array(controlOutcomeSchema),
  fullProjectOnly: z.array(z.strictObject({ provider: identifierSchema, reason: nonEmptyStringSchema })),
  gate: z.strictObject({
    level: requirementStrengthSchema,
    status: z.enum(["pass", "fail", "incomplete", "conflict"]),
    exitCode: z.int().nonnegative(),
    reasons: z.array(nonEmptyStringSchema),
  }),
});

export const guidanceEntrySchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.guidance-entry", 1),
  id: identifierSchema,
  version: versionSchema,
  owner: nonEmptyStringSchema,
  applicability: applicabilitySchema,
  evidencePrerequisites: z.array(evidenceKindSchema),
  classification: findingClassificationSchema,
  explanation: nonEmptyStringSchema,
  alternatives: z.array(nonEmptyStringSchema),
  tradeoffs: z.array(nonEmptyStringSchema),
  verification: z.array(verificationSchema).min(1),
  controls: z.array(identifierSchema),
});

export const registrySnapshotSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.registry-snapshot", 2),
  webDoctorVersion: versionSchema,
  webDoctorCommit: sourceProvenanceSchema.shape.commit,
  catalogCommit: sourceProvenanceSchema.shape.commit,
  catalogDigest: digestSchema,
  portals: z.array(portalSchema),
  contributions: z.array(contributionReferenceSchema),
  policies: z.array(policyPackSchema),
  providers: z.array(providerManifestSchema),
  guidance: z.array(guidanceEntrySchema),
});

/** Both provenance chains behind a response: the Web Doctor build and registry, and the project facts. */
const responseProvenanceSchema = z.strictObject({
  webDoctor: z.strictObject({
    version: versionSchema,
    commit: gitCommitSchema,
    registryDigest: digestSchema,
    catalogCommit: gitCommitSchema,
    catalogDigest: digestSchema,
  }),
  repoFacts: z.strictObject({
    status: z.enum(["complete", "incomplete", "unavailable"]),
    reason: nonEmptyStringSchema.nullable(),
    release: versionSchema.nullable(),
    commit: gitCommitSchema.nullable(),
    configurationDigest: digestSchema.nullable(),
    factDocumentDigest: digestSchema.nullable(),
    incompleteCategories: z.array(nonEmptyStringSchema),
  }),
  extensions: z.strictObject({
    release: versionSchema,
    stateDigest: digestSchema,
    indexDigest: digestSchema,
    incompleteCategories: z.array(nonEmptyStringSchema),
  }).nullable(),
  project: z.strictObject({
    root: nonEmptyStringSchema,
    snapshotDigest: digestSchema,
    treeDigest: digestSchema,
  }).nullable(),
  policy: z.strictObject({
    digest: digestSchema,
    portals: z.array(identifierSchema),
  }).nullable(),
});

const updateNoticeSchema = z.strictObject({
  status: z.enum(["current", "outdated", "unknown"]),
  installedVersion: versionSchema,
  availableVersion: versionSchema.nullable(),
  installationMode: nonEmptyStringSchema,
  command: nonEmptyStringSchema.nullable(),
  reason: nonEmptyStringSchema,
});

export const mcpResponseSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.mcp-response", 2),
  requestId: nonEmptyStringSchema,
  tool: identifierSchema,
  complete: z.boolean(),
  truncated: z.boolean(),
  continuationToken: nonEmptyStringSchema.optional(),
  provenance: responseProvenanceSchema,
  update: updateNoticeSchema.nullable(),
  evidence: z.array(sourceLocationSchema),
  warnings: z.array(nonEmptyStringSchema),
  data: z.unknown(),
}).superRefine((response, context) => {
  if (response.truncated && response.continuationToken === undefined) {
    context.addIssue({
      code: "custom",
      path: ["continuationToken"],
      message: "A truncated response must provide a continuation token",
    });
  }
});

const repoFactsPackageSchema = z.strictObject({
  name: z.string().regex(/^@repo-facts\/[a-z0-9-]+$/),
  version: versionSchema,
  integrity: npmIntegritySchema,
  commit: gitCommitSchema,
  contentDigest: digestSchema,
});

export const repoFactsReleaseSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.repo-facts-release", 1),
  release: versionSchema,
  commit: gitCommitSchema,
  packages: z.array(repoFactsPackageSchema).min(1),
}).superRefine((release, context) => {
  if (semver.valid(release.release) !== release.release) {
    context.addIssue({ code: "custom", path: ["release"], message: "The detector release must be an exact version" });
  }
  const names = release.packages.map((entry) => entry.name);
  if (names.join("\0") !== [...new Set(names)].sort().join("\0")) {
    context.addIssue({ code: "custom", path: ["packages"], message: "Packages must be unique and sorted by name" });
  }
  for (const required of ["@repo-facts/bundle", "@repo-facts/contract"]) {
    if (!names.includes(required)) context.addIssue({ code: "custom", path: ["packages"], message: `${required} is required` });
  }
  for (const [index, entry] of release.packages.entries()) {
    if (entry.version !== release.release) {
      context.addIssue({ code: "custom", path: ["packages", index, "version"], message: `${entry.name}@${entry.version} is not the lockstep release ${release.release}` });
    }
    if (entry.commit !== release.commit) {
      context.addIssue({ code: "custom", path: ["packages", index, "commit"], message: `${entry.name} was built from another commit` });
    }
  }
});

/** An application's optional `web-doctor.config.json`: portal membership, metadata, protected paths, exceptions, and CI gating. */
export const repositoryConfigSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.repository-config", 1),
  portals: z.array(identifierSchema).optional(),
  applicationMetadata: z.record(nonEmptyStringSchema, z.union([z.string(), z.number(), z.boolean()])).optional(),
  protectedDirectories: z.array(nonEmptyStringSchema.regex(/^[^/\\]+$/)).optional(),
  exceptions: z.array(z.strictObject({
    controlId: identifierSchema,
    exceptionId: identifierSchema,
    authorization: nonEmptyStringSchema,
  })).optional(),
  ci: z.strictObject({
    gate: requirementStrengthSchema.optional(),
    requirePortal: z.boolean().optional(),
  }).optional(),
});

/** Measured rendering cost for one interaction, as a developer exports it from a profiler. */
export const profileEvidenceSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.profile-evidence", 1),
  interaction: nonEmptyStringSchema,
  source: nonEmptyStringSchema,
  /** A component whose slowest commit meets or exceeds this many milliseconds is a hotspot. */
  commitBudgetMs: z.int().positive(),
  components: z.array(z.strictObject({
    /** A symbol id such as src/Row.tsx#Row, or a component display name. */
    component: nonEmptyStringSchema,
    commits: z.int().nonnegative(),
    actualDurationMs: z.int().nonnegative(),
    maxCommitMs: z.int().nonnegative(),
  })).min(1),
});

const reviewDecisionSchema = z.strictObject({
  status: z.enum(["approved", "rejected"]),
  /** Who is accountable for the decision. */
  decidedBy: nonEmptyStringSchema,
  decidedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scope: nonEmptyStringSchema,
  /** Terms every use must keep; a use that breaks one is not approved. */
  conditions: z.array(nonEmptyStringSchema),
  evidence: z.array(nonEmptyStringSchema),
});

/**
 * The recorded legal and security approval for a third-party analyzer
 * engine that a provider contribution may run, with each approved release
 * pinned by registry integrity, installed content, rule set, and output
 * schema. Without an approved record, no catalog entry may embed the engine.
 */
export const providerApprovalSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.provider-approval", 1),
  engine: identifierSchema,
  packageName: nonEmptyStringSchema,
  legal: reviewDecisionSchema,
  security: reviewDecisionSchema.extend({
    /** The exact invocation the security review approved. */
    configuration: z.strictObject({
      arguments: z.array(nonEmptyStringSchema),
      environment: z.record(z.string(), z.string()),
      network: z.literal(false),
    }),
  }),
  releases: z.array(z.strictObject({
    version: versionSchema,
    integrity: npmIntegritySchema,
    /** SHA-256 over the installed package's files, excluding its dependencies. */
    contentDigest: digestSchema,
    /** SHA-256 of the canonical rule catalog this release reports. */
    rulesetDigest: digestSchema,
    outputSchemaVersions: z.array(z.int().positive()).min(1),
    license: z.strictObject({ name: nonEmptyStringSchema, digest: digestSchema }),
  })).min(1),
});

export const contractSchemas = {
  internalNpmSource: internalNpmSourceSchema,
  contribution: contributionSchema,
  contributionFixture: contributionFixtureSchema,
  policyPack: policyPackSchema,
  providerManifest: providerManifestSchema,
  catalog: catalogSchema,
  registryOwnership: registryOwnershipSchema,
  contributionLock: contributionLockSchema,
  registrySnapshot: registrySnapshotSchema,
  effectivePolicySnapshot: effectivePolicySnapshotSchema,
  normalizedFinding: normalizedFindingSchema,
  guidanceEntry: guidanceEntrySchema,
  mcpResponse: mcpResponseSchema,
  repoFactsRelease: repoFactsReleaseSchema,
  repositoryConfig: repositoryConfigSchema,
  diagnosticsReport: diagnosticsReportSchema,
  profileEvidence: profileEvidenceSchema,
  providerApproval: providerApprovalSchema,
} as const;

/** Earlier versions a reader still accepts, by document kind and version. */
export const previousContractSchemas = {
  policyPack: { 1: policyPackV1Schema },
} as const satisfies Partial<Record<keyof typeof contractSchemas, Readonly<Record<number, z.ZodType>>>>;

export type PolicyControl = z.infer<typeof policyControlSchema>;
export type Contribution = z.infer<typeof contributionSchema>;
export type ContributionFixture = z.infer<typeof contributionFixtureSchema>;
export type PolicyPack = z.infer<typeof policyPackSchema>;
export type PolicyPackV1 = z.infer<typeof policyPackV1Schema>;
export type ApprovedPattern = z.infer<typeof approvedPatternSchema>;
export type ProviderApproval = z.infer<typeof providerApprovalSchema>;
export type ProviderManifest = z.infer<typeof providerManifestSchema>;
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export type RegistryOwnership = z.infer<typeof registryOwnershipSchema>;
export type ContributionLock = z.infer<typeof contributionLockSchema>;
export type RegistrySnapshot = z.infer<typeof registrySnapshotSchema>;
export type EffectivePolicySnapshot = z.infer<typeof effectivePolicySnapshotSchema>;
export type NormalizedFinding = z.infer<typeof normalizedFindingSchema>;
export type GuidanceEntry = z.infer<typeof guidanceEntrySchema>;
export type McpResponse = z.infer<typeof mcpResponseSchema>;
export type RepoFactsRelease = z.infer<typeof repoFactsReleaseSchema>;
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
export type DiagnosticsReport = z.infer<typeof diagnosticsReportSchema>;
export type ProfileEvidence = z.infer<typeof profileEvidenceSchema>;
export type ProviderRun = z.infer<typeof providerRunSchema>;
export type ControlOutcome = z.infer<typeof controlOutcomeSchema>;
export type FindingLocation = z.infer<typeof findingLocationSchema>;
export type FindingObligation = z.infer<typeof findingObligationSchema>;
export type ResponseProvenance = z.infer<typeof responseProvenanceSchema>;
export type UpdateNotice = z.infer<typeof updateNoticeSchema>;
export type PolicyFactProvenance = z.infer<typeof policyFactProvenanceSchema>;

function addDuplicateIssues(
  values: readonly string[],
  path: PropertyKey[],
  context: z.core.$RefinementCtx<unknown>,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: "Values must be unique" });
  }
}