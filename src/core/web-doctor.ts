import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InternalNpmSource, DiagnosticsReport, EffectivePolicySnapshot, McpResponse, NormalizedFinding, PolicyLayer, ProfileEvidence, RequirementStrength, UpdateNotice } from "../contracts/index.js";
import { AxeAdapter } from "../diagnostics/axe-adapter.js";
import { EslintAdapter } from "../diagnostics/eslint-adapter.js";
import { ReactDoctorAdapter } from "../diagnostics/react-doctor-adapter.js";
import { FULL_SCOPE, controlLayers, runDiagnostics, type DiagnosticScope, type ProviderAdapter } from "../diagnostics/providers.js";
import { describeTarget, DEFAULT_VIEWPORT, type RuntimeRequest } from "../diagnostics/runtime-request.js";
import { changedScope, fileScope } from "../diagnostics/scope.js";
import { discoverApplicationRoot, type ApplicationRoot } from "../facts/application-root.js";
import type { ProjectSnapshot } from "../facts/project-snapshot.js";
import { ProjectState } from "../facts/project-state.js";
import {
  dataPath,
  explainSymbol,
  projectOverview,
  runtimeBoundaries,
  serviceDependencies,
  tests,
  usages,
  verificationCommands,
  type PageOptions,
  type QueryResult,
} from "../facts/queries.js";
import { SharedFactsAnalyzer } from "../facts/shared-facts.js";
import { sharedRepairs } from "../guidance/impact.js";
import { patternsForFile, recommendForFinding } from "../guidance/patterns.js";
import { selectGuidance, type GuidanceSelection } from "../guidance/selection.js";
import { planUpgrade } from "../guidance/upgrade.js";
import { planVerification } from "../guidance/verification.js";
import { approvedRelease } from "../runtime/approved-release.js";
import { installManagedUpdate, planUpgradeCommand, rollbackManagedUpdate, type DependencyInstallOptions } from "../runtime/managed-updater.js";
import { composePolicy, type ComposedPolicy } from "../runtime/policy-composition.js";
import { evaluatePortalRequirement, type PortalRequirementResult } from "../runtime/portal-requirement.js";
import type { PortalSelectionInput, PortalSelectionResult } from "../runtime/portal-selection.js";
import { buildBuildProvenance, type BuildProvenance } from "../runtime/provenance.js";
import { WebDoctorRuntime } from "../runtime/runtime.js";
import { createEffectivePolicySnapshot } from "../runtime/effective-policy.js";
import type { EnterprisePackageDistribution, InstallationMode, PackageUpdateOptions } from "../runtime/update-state.js";
import { WEB_DOCTOR_VERSION } from "../version.js";
import { policyFactsFor } from "./policy-facts.js";
import { loadRepositoryConfig, type LoadedRepositoryConfig } from "./repository-config.js";
import type { ResponseBudget } from "./budget.js";
import { buildBudgetedResponse, requestIdOf, type ResponseParameters } from "./response.js";

/**
 * The application core behind the CLI and the MCP server. One instance pins
 * one embedded registry and one verified repo-facts release for its lifetime
 * and answers every operation with the same response envelope, so the two
 * surfaces return equivalent results for equivalent requests.
 */

export type Caller = "cli" | "mcp";
export type RunMode = "local" | "ci";

export interface UpdateConfiguration {
  distribution?: EnterprisePackageDistribution;
  installationMode?: InstallationMode;
  lookup?: PackageUpdateOptions["lookup"];
  /** The managed tool cache whose active pointer `web-doctor update` switches. */
  managedRoot?: string;
  /** Resolves the approved release coordinates; defaults to the enterprise registry manifest. */
  release?: (distribution: EnterprisePackageDistribution, version: string) => Promise<InternalNpmSource>;
  allowInsecureRegistry?: boolean;
  selfCheck?: (packageRoot: string) => Promise<void>;
  /** How the release's pinned dependencies install; they come from the update registry by default. */
  dependencies?: DependencyInstallOptions;
}

export type UpdateOutcome =
  | { status: "current" | "unknown"; reason: string }
  | { status: "action_required"; reason: string; command: string | null }
  | { status: "activated"; reason: string; active: { version: string; integrity: string }; previous: { version: string; integrity: string } | null }
  | { status: "failed"; reason: string };

export interface WebDoctorOptions {
  cwd: string;
  caller: Caller;
  root?: string;
  /** Portals named on the command line or in MCP launch arguments. */
  portals?: readonly string[];
  mode?: RunMode;
  registryRoot?: string;
  repoFactsMetadataPath?: string;
  watch?: boolean;
  update?: UpdateConfiguration;
  runtime?: WebDoctorRuntime;
  analyzer?: SharedFactsAnalyzer;
  /** Provider adapters by engine; defaults to the built-in ESLint, axe, and React Doctor adapters. */
  adapters?: readonly ProviderAdapter[];
  /**
   * Whether rendered checks may start a browser. The CLI allows them for an
   * explicit `--runtime` file; the MCP server only when launched with
   * `--allow-runtime`.
   */
  allowRuntime?: boolean;
  /** The byte budget for every response; defaults to 256 KiB. */
  budget?: ResponseBudget;
}

/** A continuation from an earlier, budget-reduced page of the same request. */
export interface Paged {
  continuation?: string;
}

export interface PolicyRequest {
  portals?: readonly string[];
  file?: string;
}

export interface ResolvedPolicy {
  snapshot: ProjectSnapshot;
  policy: EffectivePolicySnapshot;
  composition: ComposedPolicy;
  requirement: PortalRequirementResult;
}

export type ScopeRequest =
  | { mode: "full" }
  | { mode: "changed-files" | "changed-lines"; base: string }
  | { mode: "files"; files: readonly string[] };

export interface DiagnoseRequest {
  portals?: readonly string[];
  scope?: ScopeRequest;
  runtime?: RuntimeRequest | null;
  baseline?: DiagnosticsReport | null;
  gate?: RequirementStrength;
}

export interface Diagnosis {
  resolved: ResolvedPolicy;
  report: DiagnosticsReport;
  warnings: string[];
}

export interface PlanVerificationRequest {
  portals?: readonly string[];
  files?: readonly string[];
  controls?: readonly string[];
  measurements?: readonly { provider: string; profile: ProfileEvidence }[];
  report?: DiagnosticsReport | null;
}

export class OperationError extends Error {
  override readonly name = "OperationError";
}

export type ContextQuery =
  | { query: "project_overview" }
  | { query: "explain_symbol"; symbol: string; referenceLimit?: number }
  | { query: "usages"; symbol: string; kind?: "jsx" | "call" | "import" | "export" | "type" | "value"; path?: string }
  | { query: "data_path"; symbol: string }
  | { query: "runtime_boundaries"; category?: string }
  | { query: "tests"; path?: string; symbol?: string }
  | { query: "service_dependencies"; path?: string }
  | { query: "verification_commands"; kind?: string };

export class WebDoctor {
  readonly build: BuildProvenance;
  private updateNotice: Promise<UpdateNotice> | undefined;
  /** Diagnostics reports from this process by effective-policy digest, for explanation. */
  private readonly reports = new Map<string, DiagnosticsReport>();
  /** Recent diagnostics data by request id, so later pages do not rerun providers. */
  private readonly pages = new Map<string, Diagnosis>();

  private constructor(
    readonly options: WebDoctorOptions,
    readonly runtime: WebDoctorRuntime,
    readonly analyzer: SharedFactsAnalyzer,
    readonly application: ApplicationRoot,
    readonly configuration: LoadedRepositoryConfig,
    private readonly state: ProjectState,
  ) {
    this.build = buildBuildProvenance(runtime.registry.snapshot, analyzer.availability.status === "available" ? analyzer.availability.release : undefined);
  }

  static async open(options: WebDoctorOptions): Promise<WebDoctor> {
    const runtime = options.runtime ?? await WebDoctorRuntime.create(options.registryRoot === undefined ? {} : { root: options.registryRoot });
    const analyzer = options.analyzer ?? await SharedFactsAnalyzer.create(options.repoFactsMetadataPath === undefined ? {} : { metadataPath: options.repoFactsMetadataPath });
    const application = await discoverApplicationRoot({ cwd: options.cwd, ...(options.root === undefined ? {} : { root: options.root }) });
    const configuration = await loadRepositoryConfig(application.root);
    const state = await ProjectState.open({
      root: application.root,
      repositoryRoot: application.repositoryRoot,
      analyzer,
      ...(configuration.config?.protectedDirectories === undefined ? {} : { protectedDirectories: configuration.config.protectedDirectories }),
      watch: options.watch ?? options.caller === "mcp",
    });
    return new WebDoctor(options, runtime, analyzer, application, configuration, state);
  }

  get mode(): RunMode {
    return this.options.mode ?? "local";
  }

  /** The project snapshot as of the last observed change. */
  snapshot(): Promise<ProjectSnapshot> {
    return this.state.current();
  }

  /**
   * A context query. A page over the response budget is recomputed with
   * fewer items, so the query's own continuation still leads to the rest.
   */
  async context(request: ContextQuery, page: PageOptions = {}): Promise<McpResponse> {
    const snapshot = await this.snapshot();
    const { query, ...parameters } = request;
    const identity = { ...(parameters as ResponseParameters), limit: page.limit ?? null, continuation: page.continuation ?? null };
    let limit = page.limit;
    for (;;) {
      const result = runContextQuery(snapshot, request, { ...page, ...(limit === undefined ? {} : { limit }) });
      const { response, reduced } = await this.respondBudgeted(query, identity, snapshot, null, result, {
        complete: result.unresolved.length === 0 && result.page.truncated === false,
        truncated: result.page.truncated,
        continuation: result.page.continuation,
        budgetMode: "shrink",
      });
      if (!reduced || result.page.returned <= 1) return response;
      limit = Math.max(1, Math.floor(result.page.returned / 2));
    }
  }

  /** The effective policy for this application, optionally scoped to one file. */
  async resolvePolicy(request: PolicyRequest = {}): Promise<ResolvedPolicy> {
    const snapshot = await this.snapshot();
    const registry = this.runtime.registry.snapshot;
    const config = this.configuration.config;
    const facts = policyFactsFor(snapshot, registry, config);
    const portalSelection = this.portalSelection(request.portals);
    const composition = composePolicy({
      registry,
      portalSelection,
      facts: { ...facts.facts, ...(request.file === undefined ? {} : { file: request.file }) },
      directives: (config?.exceptions ?? []).map((exception) => ({ controlId: exception.controlId, action: "disable" as const, layer: "application" as const, exceptionId: exception.exceptionId, authorization: exception.authorization })),
    });
    const policy = createEffectivePolicySnapshot({ composition, capabilityCertainty: facts.capabilityCertainty, facts: facts.provenance });
    const requirement = evaluatePortalRequirement({
      mode: this.mode,
      required: this.mode === "ci" ? config?.ci?.requirePortal ?? true : false,
      selection: composition.portalSelection,
      registry,
    });
    return { snapshot, policy, composition, requirement };
  }

  async effectivePolicy(request: PolicyRequest & Paged = {}): Promise<McpResponse> {
    const resolved = await this.resolvePolicy(request);
    const requirement = resolved.requirement;
    const warnings = requirement.message === undefined ? [] : [requirement.message];
    const data = {
      policy: resolved.policy,
      portalSelection: normalizedSelection(resolved.composition.portalSelection),
      portalRequirement: requirement,
      file: request.file ?? null,
      guidance: this.guidanceFor(resolved, { file: request.file ?? null }).filter((selection) => selection.status !== "not_applicable").map(guidanceView),
      patterns: request.file === undefined ? null : patternsForFile({ policy: resolved.policy, layers: this.layers, snapshot: resolved.snapshot, file: request.file }),
    };
    const explicit = [...new Set(request.portals ?? this.options.portals ?? [])].sort();
    return this.respond("effective_guidance", { portals: explicit, file: request.file ?? null }, resolved.snapshot, resolved.policy, data, {
      complete: resolved.requirement.complete && resolved.policy.conflicts.length === 0 && resolved.policy.unresolvedApplicability.length === 0,
      warnings,
      ...windowOf(request),
    });
  }

  get layers(): Map<string, PolicyLayer> {
    return controlLayers(this.runtime.registry.snapshot);
  }

  /** Runs the providers effective policy requires over the requested scope. */
  async diagnose(request: DiagnoseRequest = {}): Promise<Diagnosis> {
    const resolved = await this.resolvePolicy(request.portals === undefined ? {} : { portals: request.portals });
    const registry = this.runtime.registry;
    const warnings: string[] = [];
    let runtime = request.runtime ?? null;
    if (runtime !== null && this.options.allowRuntime !== true) {
      warnings.push(this.options.caller === "mcp" ? "Rendered checks were not run: start the MCP server with --allow-runtime to authorize them" : "Rendered checks were not run: runtime checks are not authorized for this invocation");
      runtime = null;
    }
    const blockers = resolved.requirement.complete ? [] : [resolved.requirement.message ?? "Portal selection is incomplete"];
    const report = await runDiagnostics({
      policy: resolved.policy,
      layers: this.layers,
      context: {
        root: this.application.root,
        repositoryRoot: this.application.repositoryRoot,
        registryRoot: registry.root,
        registry: registry.snapshot,
        providerContributions: registry.providerContributions,
        snapshot: resolved.snapshot,
        scope: await this.scopeOf(request.scope ?? { mode: "full" }),
        runtime,
      },
      adapters: this.options.adapters ?? [new EslintAdapter(), new AxeAdapter(), new ReactDoctorAdapter()],
      gate: request.gate ?? this.configuration.config?.ci?.gate ?? "required",
      mode: this.mode,
      baseline: request.baseline === undefined || request.baseline === null ? null : { digest: request.baseline.digest, findings: request.baseline.findings },
      blockers,
      guidance: registry.snapshot.guidance,
    });
    this.reports.set(resolved.policy.digest, report);
    return { resolved, report, warnings };
  }

  async runDiagnostics(request: DiagnoseRequest & Paged = {}): Promise<McpResponse> {
    const parameters = diagnoseParameters(request, this.options.portals);
    let diagnosis: Diagnosis | undefined;
    if (request.continuation !== undefined) {
      const resolved = await this.resolvePolicy(request.portals === undefined ? {} : { portals: request.portals });
      diagnosis = this.pages.get(requestIdOf("run_diagnostics", parameters, resolved.snapshot, resolved.policy));
    }
    diagnosis ??= await this.diagnose(request);
    const { resolved, report, warnings } = diagnosis;
    this.pages.set(requestIdOf("run_diagnostics", parameters, resolved.snapshot, resolved.policy), diagnosis);
    while (this.pages.size > 8) this.pages.delete(this.pages.keys().next().value!);
    const incomplete = report.runs.filter((run) => run.completeness !== "complete").map((run) => `${run.provider} evidence is ${run.completeness}${run.reason === null ? "" : `: ${run.reason}`}`);
    return this.respond("run_diagnostics", parameters, resolved.snapshot, resolved.policy, report, {
      complete: incomplete.length === 0 && report.gate.status !== "incomplete" && report.gate.status !== "conflict",
      warnings: [...warnings, ...incomplete, ...report.fullProjectOnly.map((entry) => entry.reason)],
      ...windowOf(request),
    });
  }

  /** A finding with its Controls, approved patterns, shared-repair impact, and verification. */
  async explainFinding(request: { finding: string; portals?: readonly string[]; report?: DiagnosticsReport | null } & Paged): Promise<McpResponse> {
    const resolved = await this.resolvePolicy(request.portals === undefined ? {} : { portals: request.portals });
    const report = request.report ?? this.reports.get(resolved.policy.digest) ?? (await this.diagnose(request.portals === undefined ? {} : { portals: request.portals })).report;
    const finding = report.findings.find((candidate) => candidate.id === request.finding || candidate.fingerprint === request.finding);
    if (finding === undefined) throw new OperationError(`No finding ${request.finding} in diagnostics report ${report.digest}; run diagnostics again for the current project state`);
    const warnings = report.policyDigest === resolved.policy.digest ? [] : ["The report was produced under a different effective policy; approved patterns and verification reflect the current policy"];
    const guidance = this.guidanceFor(resolved, { findings: report.findings, file: sourceFileOf(finding) });
    const data = {
      finding,
      controls: report.controls.filter((outcome) => finding.controls.includes(outcome.control)),
      recommendation: recommendForFinding({ finding, policy: resolved.policy, layers: this.layers, guidance }),
      impact: sharedRepairs({ findings: report.findings, snapshot: resolved.snapshot }).repairs.find((repair) => repair.findings.includes(finding.id)) ?? null,
      guidance: guidance.filter((selection) => selection.findings.includes(finding.id)).map(guidanceView),
      verification: planVerification({ policy: resolved.policy, layers: this.layers, snapshot: resolved.snapshot, report, controls: finding.controls }),
      reportDigest: report.digest,
      modifiesProject: false,
    };
    return this.respond("explain_finding", { finding: request.finding, portals: explicitPortals(request.portals, this.options.portals), report: report.digest }, resolved.snapshot, resolved.policy, data, { complete: warnings.length === 0, warnings, ...windowOf(request) });
  }

  /** A Control's definition, provenance, latest outcome, and verification. */
  async explainControl(request: { control: string; portals?: readonly string[]; report?: DiagnosticsReport | null } & Paged): Promise<McpResponse> {
    const resolved = await this.resolvePolicy(request.portals === undefined ? {} : { portals: request.portals });
    const entry = resolved.policy.controls.find((candidate) => candidate.control.id === request.control) ?? null;
    const registry = this.runtime.registry.snapshot;
    const defined = registry.policies.find((policy) => policy.controls.some((control) => control.id === request.control)) ?? null;
    if (entry === null && defined === null) throw new OperationError(`No Control ${request.control} is defined in the embedded registry`);
    const report = request.report ?? this.reports.get(resolved.policy.digest) ?? null;
    const data = {
      control: entry?.control ?? defined!.controls.find((control) => control.id === request.control)!,
      effective: entry !== null,
      reason: entry !== null ? null : resolved.policy.exceptions.length > 0 && (this.configuration.config?.exceptions ?? []).some((exception) => exception.controlId === request.control) ? "An authorized exception removes it from effective policy" : "Its applicability or portal scope does not match this application",
      layer: this.layers.get(request.control) ?? null,
      policy: defined === null ? null : { id: defined.id, version: defined.version, owner: defined.owner },
      contribution: entry?.policyContribution ?? null,
      unresolvedApplicability: resolved.policy.unresolvedApplicability.includes(request.control),
      outcome: report?.controls.find((outcome) => outcome.control === request.control) ?? null,
      findings: report?.findings.filter((finding) => finding.controls.includes(request.control)).map((finding) => finding.id) ?? [],
      verification: entry === null ? null : planVerification({ policy: resolved.policy, layers: this.layers, snapshot: resolved.snapshot, report, controls: [request.control] }),
      reportDigest: report?.digest ?? null,
      modifiesProject: false,
    };
    return this.respond("explain_control", { control: request.control, portals: explicitPortals(request.portals, this.options.portals), report: report?.digest ?? null }, resolved.snapshot, resolved.policy, data, { complete: entry !== null && !data.unresolvedApplicability, ...windowOf(request) });
  }

  async planUpgrade(request: { package: string; target: string } & Paged): Promise<McpResponse> {
    const snapshot = await this.snapshot();
    const plan = planUpgrade({ snapshot, registry: this.runtime.registry.snapshot, config: this.configuration.config, package: request.package, target: request.target });
    return this.respond("plan_upgrade", { package: request.package, target: request.target }, snapshot, null, plan, { complete: plan.status !== "unresolved", warnings: plan.unresolved, ...windowOf(request) });
  }

  async planVerification(request: PlanVerificationRequest & Paged = {}): Promise<McpResponse> {
    const resolved = await this.resolvePolicy(request.portals === undefined ? {} : { portals: request.portals });
    const report = request.report ?? this.reports.get(resolved.policy.digest) ?? null;
    const plan = planVerification({
      policy: resolved.policy,
      layers: this.layers,
      snapshot: resolved.snapshot,
      report,
      ...(request.measurements === undefined ? {} : { measurements: request.measurements }),
      ...(request.files === undefined ? {} : { files: request.files }),
      ...(request.controls === undefined ? {} : { controls: request.controls }),
    });
    const parameters = {
      portals: explicitPortals(request.portals, this.options.portals),
      files: [...new Set(request.files ?? [])].sort(),
      controls: [...new Set(request.controls ?? [])].sort(),
      measurements: (request.measurements ?? []).map((entry) => `${entry.provider}:${entry.profile.interaction}`).sort(),
      report: report?.digest ?? null,
    };
    return this.respond("plan_verification", parameters, resolved.snapshot, resolved.policy, plan, { complete: plan.complete, ...windowOf(request) });
  }

  /** Registry guidance selected for this application, optionally for one file or a report's findings. */
  guidanceFor(resolved: ResolvedPolicy, options: { file?: string | null; findings?: readonly NormalizedFinding[] } = {}): GuidanceSelection[] {
    return selectGuidance({
      registry: this.runtime.registry.snapshot,
      snapshot: resolved.snapshot,
      policy: resolved.policy,
      config: this.configuration.config,
      ...(options.file === undefined || options.file === null ? {} : { file: options.file }),
      ...(options.findings === undefined ? {} : { findings: options.findings }),
    });
  }

  private async scopeOf(request: ScopeRequest): Promise<DiagnosticScope> {
    if (request.mode === "full") return FULL_SCOPE;
    if (request.mode === "files") return fileScope(request.files);
    if (this.application.repositoryRoot === null) throw new OperationError("A changed-file check needs a Git repository");
    return changedScope({ root: this.application.root, repositoryRoot: this.application.repositoryRoot, base: request.base, mode: request.mode });
  }

  async updateStatus(): Promise<McpResponse> {
    const notice = await this.update();
    return this.respond("update_status", {}, null, null, notice, { complete: notice.status !== "unknown" });
  }

  /**
   * `web-doctor update`. A managed installation verifies, stages, self-checks,
   * and activates the approved release for later processes, keeping the prior
   * version on any failure. Other installations only report the command.
   */
  async applyUpdate(): Promise<McpResponse> {
    const notice = await this.update();
    const configuration = this.options.update ?? {};
    let outcome: UpdateOutcome;
    if (notice.status !== "outdated") outcome = { status: notice.status, reason: notice.reason };
    else if (notice.installationMode !== "managed") outcome = { status: "action_required", reason: "Web Doctor never changes this installation; run the upgrade command", command: notice.command };
    else if (configuration.managedRoot === undefined || configuration.distribution === undefined) outcome = { status: "failed", reason: "A managed update needs WEB_DOCTOR_MANAGED_ROOT and an enterprise update registry" };
    else {
      try {
        const distribution = configuration.distribution;
        const source = await (configuration.release ?? ((target, version) => approvedRelease(target, version, configuration.allowInsecureRegistry === true ? { allowInsecureRegistry: true } : {})))(distribution, notice.availableVersion!);
        const result = await installManagedUpdate({
          root: configuration.managedRoot,
          source,
          registry: distribution.registry,
          ...(configuration.allowInsecureRegistry === true ? { allowInsecureRegistry: true } : {}),
          ...(configuration.selfCheck === undefined ? {} : { selfCheck: configuration.selfCheck }),
          ...(configuration.dependencies === undefined ? {} : { dependencies: configuration.dependencies }),
        });
        outcome = {
          status: "activated",
          reason: `Web Doctor ${result.active.version} is active for new processes; this process keeps ${WEB_DOCTOR_VERSION} and its registry snapshot`,
          active: { version: result.active.version, integrity: result.active.integrity },
          previous: result.previous === undefined ? null : { version: result.previous.version, integrity: result.previous.integrity },
        };
      } catch (error) {
        outcome = { status: "failed", reason: `The update was not activated and the previous version remains active: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return this.respond("update", {}, null, null, { notice, outcome }, { complete: outcome.status !== "unknown" && outcome.status !== "failed", ...(outcome.status === "failed" ? { warnings: [outcome.reason] } : {}) });
  }

  /**
   * `web-doctor update rollback`: a managed installation makes its retained
   * previous version active for new processes. Other installations roll back
   * through their package manager.
   */
  async applyRollback(): Promise<McpResponse> {
    const managedRoot = this.options.update?.managedRoot;
    let outcome: UpdateOutcome;
    if (managedRoot === undefined) outcome = { status: "action_required", reason: "Only a managed installation rolls back itself; install the prior exact version with the package manager and restore its lockfile", command: null };
    else {
      try {
        const result = await rollbackManagedUpdate(managedRoot);
        outcome = {
          status: "activated",
          reason: `Web Doctor ${result.active.version} is active again for new processes; this process keeps ${WEB_DOCTOR_VERSION}`,
          active: { version: result.active.version, integrity: result.active.integrity },
          previous: result.previous === undefined ? null : { version: result.previous.version, integrity: result.previous.integrity },
        };
      } catch (error) {
        outcome = { status: "failed", reason: `Rollback did not change the active version: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return this.respond("update_rollback", {}, null, null, { outcome }, { complete: outcome.status === "activated", ...(outcome.status === "failed" ? { warnings: [outcome.reason] } : {}) });
  }

  /** Package update state; looked up at most once per process and never changing the loaded registry. */
  update(): Promise<UpdateNotice> {
    this.updateNotice ??= this.lookupUpdate();
    return this.updateNotice;
  }

  async close(): Promise<void> {
    await this.state.close();
  }

  portalSelection(explicit?: readonly string[]): PortalSelectionInput {
    const named = explicit ?? this.options.portals;
    return {
      ...(named === undefined || named.length === 0 ? {} : { [this.options.caller]: named }),
      ...(this.configuration.config?.portals === undefined ? {} : { repository: this.configuration.config.portals }),
    };
  }

  async respond(
    tool: string,
    parameters: ResponseParameters,
    snapshot: ProjectSnapshot | null,
    policy: EffectivePolicySnapshot | null,
    data: unknown,
    status: ResponseStatus,
  ): Promise<McpResponse> {
    return (await this.respondBudgeted(tool, parameters, snapshot, policy, data, status)).response;
  }

  private async respondBudgeted(
    tool: string,
    parameters: ResponseParameters,
    snapshot: ProjectSnapshot | null,
    policy: EffectivePolicySnapshot | null,
    data: unknown,
    status: ResponseStatus,
  ): Promise<{ response: McpResponse; reduced: boolean }> {
    return buildBudgetedResponse({ build: this.build, availability: this.analyzer.availability, update: await this.update() }, {
      tool,
      parameters,
      snapshot,
      policy,
      data,
      complete: status.complete,
      ...(status.truncated === undefined ? {} : { truncated: status.truncated }),
      ...(status.continuation === undefined ? {} : { continuation: status.continuation }),
      ...(status.warnings === undefined ? {} : { warnings: status.warnings }),
      ...(status.window === undefined ? {} : { window: status.window }),
      ...(status.budgetMode === undefined ? {} : { budgetMode: status.budgetMode }),
      ...(this.options.budget === undefined ? {} : { budget: this.options.budget }),
    });
  }

  private async lookupUpdate(): Promise<UpdateNotice> {
    const installationMode = this.options.update?.installationMode ?? await detectInstallationMode(this.application.root);
    const state = await this.runtime.resolveUpdateState({
      installedVersion: WEB_DOCTOR_VERSION,
      installationMode,
      ...(this.options.update?.distribution === undefined ? {} : { distribution: this.options.update.distribution }),
      ...(this.options.update?.lookup === undefined ? {} : { lookup: this.options.update.lookup }),
    });
    let command: string | null = null;
    if (state.status === "outdated" && state.availableVersion !== undefined) {
      if (installationMode === "managed") command = "web-doctor update";
      else {
        try {
          const snapshot = await this.snapshot();
          const manager = snapshot.shared.status === "complete" ? snapshot.shared.document.categories.package_managers?.facts[0]?.value : undefined;
          command = planUpgradeCommand({
            mode: installationMode,
            packageName: state.packageName ?? "web-doctor",
            version: state.availableVersion,
            ...(manager === "npm" || manager === "pnpm" || manager === "yarn" ? { packageManager: manager } : {}),
          });
        } catch {
          command = null;
        }
      }
    }
    return {
      status: state.status,
      installedVersion: state.installedVersion,
      availableVersion: state.availableVersion ?? null,
      installationMode,
      command,
      reason: state.reason,
    };
  }
}

interface ResponseStatus {
  complete: boolean;
  truncated?: boolean;
  continuation?: string | null;
  warnings?: readonly string[];
  window?: string;
  budgetMode?: "window" | "shrink";
}

function windowOf(request: Paged): { window?: string } {
  return request.continuation === undefined ? {} : { window: request.continuation };
}

/** Registry guidance as a response item: the selection and the entry's advice, without repeating applicability. */
export function guidanceView(selection: GuidanceSelection) {
  const { entry, ...rest } = selection;
  return { ...rest, explanation: entry.explanation, alternatives: entry.alternatives, tradeoffs: entry.tradeoffs, verification: entry.verification, owner: entry.owner };
}

/** Request parameters for diagnostics, identical from either surface for equivalent requests. */
export function diagnoseParameters(request: DiagnoseRequest, launched?: readonly string[]) {
  const scope = request.scope ?? { mode: "full" as const };
  return {
    portals: explicitPortals(request.portals, launched),
    scope: scope.mode,
    base: scope.mode === "changed-files" || scope.mode === "changed-lines" ? scope.base : null,
    files: scope.mode === "files" ? [...new Set(scope.files)].sort() : [],
    runtime: (request.runtime?.targets ?? []).map((target) => describeTarget({ url: target.url, state: target.state, viewport: target.viewport ?? DEFAULT_VIEWPORT })),
    baseline: request.baseline?.digest ?? null,
    gate: request.gate ?? null,
  };
}

function explicitPortals(requested: readonly string[] | undefined, launched: readonly string[] | undefined): string[] {
  return [...new Set(requested ?? launched ?? [])].sort();
}

function sourceFileOf(finding: NormalizedFinding): string | null {
  const location = finding.locations.find((candidate) => candidate.kind === "source");
  return location?.kind === "source" ? location.path : null;
}

export interface NormalizedPortalSelection {
  status: PortalSelectionResult["status"];
  portals: string[];
  sources: { source: "explicit" | "repository" | "assignment"; portals: string[] }[];
  message?: string;
}

/** Portal selection with command-line and MCP arguments both reported as explicit, so either surface answers alike. */
export function normalizedSelection(selection: PortalSelectionResult): NormalizedPortalSelection {
  return {
    status: selection.status,
    portals: [...selection.portals],
    sources: selection.sources.map((entry) => ({ source: entry.source === "cli" || entry.source === "mcp" ? "explicit" as const : entry.source, portals: entry.portals })),
    ...(selection.status === "conflict" ? { message: selection.message } : {}),
  };
}

export function runContextQuery(snapshot: ProjectSnapshot, request: ContextQuery, page: PageOptions): QueryResult<unknown> {
  switch (request.query) {
    case "project_overview":
      return projectOverview(snapshot, page);
    case "explain_symbol":
      return explainSymbol(snapshot, { symbol: request.symbol, ...(request.referenceLimit === undefined ? {} : { referenceLimit: request.referenceLimit }) }, page);
    case "usages":
      return usages(snapshot, { symbol: request.symbol, ...(request.kind === undefined ? {} : { kind: request.kind }), ...(request.path === undefined ? {} : { path: request.path }) }, page);
    case "data_path":
      return dataPath(snapshot, { symbol: request.symbol }, page);
    case "runtime_boundaries":
      return runtimeBoundaries(snapshot, request.category === undefined ? {} : { category: request.category }, page);
    case "tests":
      return tests(snapshot, { ...(request.path === undefined ? {} : { path: request.path }), ...(request.symbol === undefined ? {} : { symbol: request.symbol }) }, page);
    case "service_dependencies":
      return serviceDependencies(snapshot, request.path === undefined ? {} : { path: request.path }, page);
    case "verification_commands":
      return verificationCommands(snapshot, request.kind === undefined ? {} : { kind: request.kind }, page);
  }
}

/**
 * How this Web Doctor is installed: an explicit managed launcher, a dependency
 * of the application (exact or ranged), or unknown.
 */
export async function detectInstallationMode(applicationRoot: string): Promise<InstallationMode> {
  const declared = process.env.WEB_DOCTOR_INSTALLATION_MODE;
  if (declared === "managed" || declared === "immutable-ci" || declared === "global") return declared;
  const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  if (!packageRoot.includes(`${path.sep}node_modules${path.sep}`)) return "unknown";
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(applicationRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const specifier = manifest.devDependencies?.["web-doctor"] ?? manifest.dependencies?.["web-doctor"];
    if (specifier === undefined) return "unknown";
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(specifier) ? "project-exact" : "project-range";
  } catch {
    return "unknown";
  }
}
