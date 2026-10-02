export * from "./contracts/index.js";
export { validatePolicyAuthoring } from "./authoring/policy.js";
export type { PolicyValidationIssue, PolicyValidationOptions, PolicyValidationReport } from "./authoring/policy.js";
export { validateProviderAuthoring } from "./authoring/provider.js";
export type { ProviderValidationIssue, ProviderValidationOptions, ProviderValidationReport } from "./authoring/provider.js";
export { packContribution } from "./authoring/contribution-package.js";
export type { ContributionPackOptions, ContributionPackResult } from "./authoring/contribution-package.js";
export { prepareCatalogProposal } from "./authoring/catalog-proposal.js";
export type { CatalogProposalOptions, CatalogProposalResult } from "./authoring/catalog-proposal.js";
export { createWebDoctorServer, runWebDoctorStdioServer } from "./mcp.js";
export { generateContributionLock, writeContributionLock } from "./registry/lock.js";
export type { ContributionManifestMetadata } from "./registry/lock.js";
export { ownershipCoverageIssues } from "./registry/ownership.js";
export { materializeCatalogContributions } from "./registry/materialize.js";
export { readInternalNpmArtifact } from "./registry/npm-artifact.js";
export type { NpmArtifactResolverOptions, ResolvedNpmArtifact } from "./registry/npm-artifact.js";
export { validateCatalog } from "./registry/validate.js";
export type { CatalogValidationIssue, CatalogValidationResult } from "./registry/validate.js";
export type { ApprovedRuntimeArtifact } from "./registry/command.js";
export { validateRegistryPullRequest } from "./registry/pr.js";
export type { PullRequestValidationOptions } from "./registry/pr.js";
export { buildRegistryProvenance, compareRegistryProvenance } from "./registry/provenance.js";
export type { ContributionProvenance, RegistryProvenance, RegistryProvenanceChange } from "./registry/provenance.js";
export { compileRegistrySnapshot } from "./registry/snapshot.js";
export type { CompiledRegistrySnapshot, RegistrySnapshotCompilerOptions } from "./registry/snapshot.js";
export { assembleEmbeddedRegistry } from "./registry/assemble.js";
export type { EmbeddedRegistryAssembly } from "./registry/assemble.js";
export { buildRegistryReleaseArtifacts, verifyRegistryReleaseArtifacts } from "./registry/release.js";
export type { RegistryReleaseArtifacts, RegistryReleaseOptions } from "./registry/release.js";
export { WEB_DOCTOR_VERSION } from "./version.js";
export { buildBuildProvenance, loadBuildProvenance } from "./runtime/provenance.js";
export type { BuildProvenance, BuildProvenanceOptions, RuntimeContributionProvenance } from "./runtime/provenance.js";
export { loadEmbeddedRegistry } from "./runtime/embedded-registry.js";
export type { EmbeddedRegistryOptions, LoadedEmbeddedRegistry } from "./runtime/embedded-registry.js";
export { resolvePortalSelection } from "./runtime/portal-selection.js";
export type { PortalSelectionInput, PortalSelectionResult, PortalSource, PortalSourceSelection } from "./runtime/portal-selection.js";
export { evaluateApplicability } from "./runtime/applicability.js";
export type { ApplicabilityFacts, ApplicabilityReason, ApplicabilityResult, ApplicabilityStatus } from "./runtime/applicability.js";
export { composePolicy } from "./runtime/policy-composition.js";
export type { ComposedControl, ComposedPolicy, ControlDirective, PolicyCompositionOptions } from "./runtime/policy-composition.js";
export { createEffectivePolicySnapshot, registryDigestForEffectivePolicy, verifyEffectivePolicyDigest } from "./runtime/effective-policy.js";
export type { EffectivePolicyOptions } from "./runtime/effective-policy.js";
export { evaluatePortalRequirement } from "./runtime/portal-requirement.js";
export type { PortalRequirementOptions, PortalRequirementResult } from "./runtime/portal-requirement.js";
export { resolvePackageUpdateState } from "./runtime/update-state.js";
export type { EnterprisePackageDistribution, InstallationMode, PackageUpdateOptions, PackageUpdateState, PackageUpdateStatus } from "./runtime/update-state.js";
export { WebDoctorRuntime } from "./runtime/runtime.js";
export {
  loadRepoFactsRelease,
  recordRepoFactsRelease,
  verifyInstalledRepoFacts,
  writeRepoFactsRelease,
  REPO_FACTS_BUNDLE,
  REPO_FACTS_CONTRACT,
  REPO_FACTS_SCOPE,
} from "./facts/repo-facts-release.js";
export type { InstalledRepoFactsOptions, InstalledRepoFactsState, RecordRepoFactsOptions } from "./facts/repo-facts-release.js";
export { discoverApplicationRoot, repositoryRootOf } from "./facts/application-root.js";
export type { ApplicationRoot, ApplicationRootMarker, ApplicationRootOptions } from "./facts/application-root.js";
export { DEPENDENCY_DIRECTORIES, NULL_OBJECT_ID, WorkingTreeListing, WorkingTreeReader } from "./facts/working-tree-reader.js";
export type { WorkingTreeExclusion, WorkingTreeExclusionReason, WorkingTreeScanOptions } from "./facts/working-tree-reader.js";
export { SharedFactsAnalyzer, SUPPORTED_FACT_DOCUMENT_VERSIONS, acceptSharedDocument, provenanceFor } from "./facts/shared-facts.js";
export type {
  SharedFactsAnalyzerOptions,
  SharedFactsAvailability,
  SharedFactsComplete,
  SharedFactsIncomplete,
  SharedFactsIncompleteReason,
  SharedFactsProvenance,
  SharedFactsResult,
  SkippedInput,
} from "./facts/shared-facts.js";
export { DEFAULT_INDEX_LIMITS, PROJECT_INDEX_SCHEMA, SOURCE_EXTENSIONS, buildProjectIndex, isSourcePath } from "./facts/project-index.js";
export type {
  ImportTarget,
  IndexCertainty,
  IndexLocation,
  IndexSkip,
  IndexSymbolKind,
  IndexedExport,
  IndexedFrame,
  IndexedImport,
  IndexedLifecycles,
  IndexedMessage,
  IndexedModule,
  IndexedMount,
  IndexedRoute,
  IndexedRuntime,
  StaticValue,
  IndexedProp,
  IndexedReference,
  IndexedSymbol,
  IndexedUse,
  ProjectIndex,
  ProjectIndexLimits,
  ProjectIndexOptions,
  ReferenceKind,
} from "./facts/project-index.js";
export { WEB_DOCTOR_EXTENSIONS, WEB_DOCTOR_EXTENSION_RELEASE, analyzeExtensions, extensionStateDigest, mergedCategories } from "./facts/extensions.js";
export { IndexSession } from "./facts/project-index.js";
export { ProjectState } from "./facts/project-state.js";
export type { ProjectStateOptions, ProjectStateStats, RefreshReport } from "./facts/project-state.js";
export { RecordingReader } from "./facts/recording-reader.js";
export { SHARED_EXTENSION_INPUTS } from "./facts/source-detectors.js";
export type { ExtensionAnalysisOptions, ExtensionDetectorFactory, ExtensionFacts } from "./facts/extensions.js";
export { analyzeProject, snapshotDigest, snapshotOf } from "./facts/project-snapshot.js";
export type { ProjectAnalysisOptions, ProjectSnapshot } from "./facts/project-snapshot.js";
export {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  QUERY_RESULT_SCHEMA,
  QueryError,
  dataPath,
  encodeContinuation,
  explainSymbol,
  factView,
  projectOverview,
  queryProvenance,
  runtimeBoundaries,
  serviceDependencies,
  tests,
  usages,
  verificationCommands,
} from "./facts/queries.js";
export type {
  CategorySummary,
  DataPathSegment,
  EvidenceView,
  FactView,
  Narrowing,
  PageOptions,
  QueryName,
  QueryPage,
  QueryParameters,
  QueryProvenance,
  QueryResult,
  ServiceView,
  SymbolExplanation,
  Unresolved,
} from "./facts/queries.js";
export { installManagedUpdate, planUpgradeCommand, readManagedPointer, rollbackManagedUpdate } from "./runtime/managed-updater.js";
export type { ManagedUpdateOptions, ManagedUpdateResult, ManagedVersionPointer, UpgradeCommandOptions } from "./runtime/managed-updater.js";