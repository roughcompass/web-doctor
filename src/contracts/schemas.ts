import * as z from "zod/v4";
import {
  applicabilitySchema,
  compatibilitySchema,
  digestSchema,
  identifierSchema,
  internalNpmSourceSchema,
  nonEmptyStringSchema,
  packageArtifactReferenceSchema,
  packagePathSchema,
  sourceLocationSchema,
  sourceProvenanceSchema,
  versionSchema,
  versionedDocumentFields,
} from "./common.js";
import {
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

export const policyControlSchema = z.strictObject({
  id: identifierSchema,
  title: nonEmptyStringSchema,
  rationale: nonEmptyStringSchema,
  strength: requirementStrengthSchema,
  applicability: applicabilitySchema,
  evidence: z.array(evidenceRequirementSchema).min(1),
  remediation: nonEmptyStringSchema.optional(),
  verification: z.array(verificationSchema).min(1),
  exceptionPolicy: nonEmptyStringSchema.optional(),
});

export const policyPackSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.policy-pack", 1),
  id: identifierSchema,
  version: versionSchema,
  owner: nonEmptyStringSchema,
  layer: policyLayerSchema,
  compatibility: compatibilitySchema,
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

export const effectivePolicySnapshotSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.effective-policy", 1),
  digest: digestSchema,
  registryDigest: digestSchema,
  resolverVersion: versionSchema,
  portals: z.array(identifierSchema),
  capabilities: z.record(identifierSchema, factCertaintySchema),
  contributions: z.array(contributionReferenceSchema),
  controls: z.array(effectiveControlSchema),
  exceptions: z.array(identifierSchema),
  conflicts: z.array(nonEmptyStringSchema),
  unresolvedApplicability: z.array(identifierSchema),
});

export const normalizedFindingSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.finding", 1),
  id: identifierSchema,
  provider: identifierSchema,
  providerVersion: versionSchema,
  rule: identifierSchema,
  evidenceKind: evidenceKindSchema,
  locations: z.array(sourceLocationSchema),
  severity: z.enum(["error", "warning", "information"]),
  certainty: factCertaintySchema,
  classification: findingClassificationSchema,
  message: nonEmptyStringSchema,
  controls: z.array(identifierSchema),
  remediation: z.array(nonEmptyStringSchema),
  verification: z.array(verificationSchema),
  completeness: providerCompletenessSchema,
  registryDigest: digestSchema,
  policyDigest: digestSchema,
}).superRefine((finding, context) => {
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
  ...versionedDocumentFields("web-doctor.registry-snapshot", 1),
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

export const mcpResponseSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.mcp-response", 1),
  requestId: nonEmptyStringSchema,
  tool: identifierSchema,
  complete: z.boolean(),
  truncated: z.boolean(),
  registryDigest: digestSchema.optional(),
  evidence: z.array(sourceLocationSchema),
  warnings: z.array(nonEmptyStringSchema),
  continuationToken: nonEmptyStringSchema.optional(),
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
} as const;

export type PolicyControl = z.infer<typeof policyControlSchema>;
export type Contribution = z.infer<typeof contributionSchema>;
export type ContributionFixture = z.infer<typeof contributionFixtureSchema>;
export type PolicyPack = z.infer<typeof policyPackSchema>;
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

function addDuplicateIssues(
  values: readonly string[],
  path: PropertyKey[],
  context: z.core.$RefinementCtx<unknown>,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: "Values must be unique" });
  }
}