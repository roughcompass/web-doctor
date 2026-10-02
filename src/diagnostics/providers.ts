import {
  diagnosticsReportSchema,
  digestDocument,
  type ControlOutcome,
  type DiagnosticsReport,
  type EffectivePolicySnapshot,
  type EvidenceKind,
  type GuidanceEntry,
  type NormalizedFinding,
  type PolicyControl,
  type PolicyLayer,
  type ProviderCapability,
  type ProviderCompleteness,
  type ProviderManifest,
  type ProviderRun,
  type RegistrySnapshot,
  type RequirementStrength,
} from "../contracts/index.js";
import type { ProjectSnapshot } from "../facts/project-snapshot.js";
import { evaluateApplicability } from "../runtime/applicability.js";
import { buildFinding, fingerprintOf, obligationOf, type FindingDraft } from "./finding.js";
import type { RuntimeRequest } from "./runtime-request.js";

/**
 * The provider adapter lifecycle, independent of any one analyzer:
 *
 * 1. Plan: collect the evidence effective Controls require and group it by
 *    approved provider. Unknown providers and undeclared rules are planned as
 *    unavailable rather than dropped.
 * 2. Run: each adapter serves the plans for its engine in isolation. A failed
 *    adapter makes its providers unavailable without hiding other results.
 * 3. Normalize: provider output becomes findings that carry every applicable
 *    Control's obligation.
 * 4. Evaluate: each Control's outcome follows from the completeness of the
 *    evidence it requires, never from the absence of findings alone.
 */

export const BUILTIN_ESLINT = "eslint";

export type ScopeMode = "full" | "changed-files" | "changed-lines";

export interface DiagnosticScope {
  mode: ScopeMode;
  /** Files in scope for changed modes; empty for a full run. */
  files: readonly string[];
  /** Changed line ranges by file, for changed-line mode. */
  lines: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  base: string | null;
}

export const FULL_SCOPE: DiagnosticScope = { mode: "full", files: [], lines: new Map(), base: null };

export interface EvidenceRequirement {
  provider: string;
  rule: string | null;
  kind: EvidenceKind;
  required: boolean;
  control: EffectivePolicySnapshot["controls"][number];
  /** The Control's own evidence entry this requirement was planned from. */
  source: PolicyControl["evidence"][number];
}

export interface ProviderPlan {
  provider: string;
  engine: string;
  manifest: ProviderManifest | null;
  contribution: string | null;
  rules: string[];
  requirements: EvidenceRequirement[];
  /** Why the plan cannot run at all, such as an unapproved provider. */
  unavailable: string | null;
}

export interface ProviderExecution {
  provider: string;
  engineVersion: string | null;
  completeness: ProviderCompleteness;
  reason: string | null;
  /** Completeness of each requested rule; a rule the run could not load is unavailable. */
  ruleStatus: Readonly<Record<string, ProviderCompleteness>>;
  capabilities: ProviderCapability[];
  denied: string[];
  files: number;
  drafts: FindingDraft[];
  /** For rendered providers, each target that was tested. */
  testedScope?: string[];
}

export interface ProviderContext {
  root: string;
  repositoryRoot: string | null;
  registryRoot: string;
  registry: RegistrySnapshot;
  /** The contribution that embeds each provider manifest and its artifacts. */
  providerContributions: Readonly<Record<string, string>>;
  snapshot: ProjectSnapshot;
  scope: DiagnosticScope;
  /** Rendered checks run only with an explicit, authorized request. */
  runtime?: RuntimeRequest | null;
}

export interface ProviderAdapter {
  readonly engine: string;
  /** Runs every plan for this engine; returns one execution per plan. */
  run(plans: readonly ProviderPlan[], context: ProviderContext): Promise<ProviderExecution[]>;
}

export interface DiagnosticsRequest {
  policy: EffectivePolicySnapshot;
  layers: ReadonlyMap<string, PolicyLayer>;
  context: ProviderContext;
  adapters: readonly ProviderAdapter[];
  gate: RequirementStrength;
  mode: "local" | "ci";
  /** Findings from an earlier report; matching fingerprints are existing debt. */
  baseline?: { digest: string; findings: readonly NormalizedFinding[] } | null;
  /** Problems that block evaluation, such as a portal conflict. */
  blockers?: readonly string[];
  /** Registry guidance; manual-review entries add verification that automated evidence cannot satisfy. */
  guidance?: readonly GuidanceEntry[];
  /**
   * Controls whose applicability is unresolved for reasons other than file
   * scope, which diagnostics evaluate per finding. Defaults to the policy's
   * unresolved Controls that have any predicate besides files.
   */
  unresolved?: ReadonlySet<string>;
}

/** Each Control's policy layer, from the policy packs that define it. */
export function controlLayers(registry: RegistrySnapshot): Map<string, PolicyLayer> {
  return new Map(registry.policies.flatMap((policy) => policy.controls.map((control) => [control.id, policy.layer] as const)));
}

/** Groups the evidence effective Controls require by approved provider. */
export function planProviders(policy: EffectivePolicySnapshot, registry: RegistrySnapshot, providerContributions: Readonly<Record<string, string>> = {}): ProviderPlan[] {
  const plans = new Map<string, ProviderPlan>();
  const manifests = new Map(registry.providers.map((manifest) => [manifest.id, manifest]));
  const contributionOf = (id: string) => providerContributions[id] ?? null;
  const planFor = (provider: string): ProviderPlan => {
    const existing = plans.get(provider);
    if (existing !== undefined) return existing;
    const manifest = manifests.get(provider) ?? null;
    const plan: ProviderPlan = {
      provider,
      engine: manifest?.engine ?? (provider === BUILTIN_ESLINT ? BUILTIN_ESLINT : "unknown"),
      manifest,
      contribution: manifest === null ? null : contributionOf(provider),
      rules: [],
      requirements: [],
      unavailable: manifest === null && provider !== BUILTIN_ESLINT ? `Provider ${provider} is not in the approved catalog` : null,
    };
    plans.set(provider, plan);
    return plan;
  };
  for (const entry of policy.controls) {
    for (const evidence of entry.control.evidence) {
      if (evidence.kind === "manual") continue;
      let provider = evidence.provider;
      let rule = evidence.rule ?? null;
      // `eslint` evidence naming `namespace/rule` belongs to the approved plugin with that namespace.
      if (provider === BUILTIN_ESLINT && rule !== null && rule.includes("/")) {
        const namespace = rule.slice(0, rule.indexOf("/"));
        if (manifests.get(namespace)?.engine === BUILTIN_ESLINT) {
          provider = namespace;
          rule = rule.slice(namespace.length + 1);
        }
      }
      const plan = planFor(provider);
      if (rule !== null && !plan.rules.includes(rule)) plan.rules.push(rule);
      plan.requirements.push({ provider, rule, kind: evidence.kind, required: evidence.required, control: entry, source: evidence });
    }
  }
  return [...plans.values()].map((plan) => ({ ...plan, rules: plan.rules.sort() })).sort((left, right) => compare(left.provider, right.provider));
}

export async function runDiagnostics(request: DiagnosticsRequest): Promise<DiagnosticsReport> {
  const { policy, context } = request;
  const plans = planProviders(policy, context.registry, context.providerContributions);
  const fullProjectOnly: DiagnosticsReport["fullProjectOnly"] = [];
  const executions = new Map<string, ProviderExecution>();
  const notRun = new Map<string, string>();
  const runnable: ProviderPlan[] = [];
  for (const plan of plans) {
    if (plan.unavailable !== null) {
      executions.set(plan.provider, unavailable(plan, plan.unavailable));
    } else if (plan.manifest !== null && plan.manifest.invocationModes.includes("runtime") && context.runtime?.authorized !== true) {
      notRun.set(plan.provider, "Rendered checks need an authorized runtime request that names running targets");
    } else if (context.scope.mode !== "full" && plan.manifest !== null && plan.manifest.invocationModes.includes("full-project") && !plan.manifest.invocationModes.includes("changed-files")) {
      fullProjectOnly.push({ provider: plan.provider, reason: `${plan.provider} checks the whole project and does not run in ${context.scope.mode} mode` });
    } else runnable.push(plan);
  }
  for (const engine of [...new Set(runnable.map((plan) => plan.engine))].sort()) {
    const enginePlans = runnable.filter((plan) => plan.engine === engine);
    const adapter = request.adapters.find((candidate) => candidate.engine === engine);
    if (adapter === undefined) {
      for (const plan of enginePlans) executions.set(plan.provider, unavailable(plan, `No adapter is available for the ${engine} engine`));
      continue;
    }
    try {
      const results = await adapter.run(enginePlans, context);
      for (const plan of enginePlans) executions.set(plan.provider, results.find((result) => result.provider === plan.provider) ?? unavailable(plan, `The ${engine} adapter returned no result`));
    } catch (error) {
      for (const plan of enginePlans) executions.set(plan.provider, unavailable(plan, `The ${engine} adapter failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  const findings = normalize(request, plans, executions);
  const outOfScope = new Set(fullProjectOnly.map((entry) => entry.provider));
  const controls = evaluateControls(request, plans, executions, findings, outOfScope);
  const runs = plans.map((plan): ProviderRun => {
    const execution = executions.get(plan.provider);
    return {
      provider: plan.provider,
      version: plan.manifest?.version ?? execution?.engineVersion ?? "0.0.0",
      engine: plan.engine === "unknown" ? "unknown" : plan.engine,
      engineVersion: execution?.engineVersion ?? null,
      contribution: plan.contribution,
      completeness: execution?.completeness ?? "unavailable",
      reason: execution === undefined ? (outOfScope.has(plan.provider) ? "Full-project provider skipped in a changed-file run" : notRun.get(plan.provider) ?? "Not run") : execution.reason,
      scope: { mode: context.scope.mode, files: execution?.files ?? 0, fullProjectOnly: outOfScope.has(plan.provider) },
      capabilities: execution?.capabilities ?? [],
      denied: execution?.denied ?? [],
      rules: plan.rules,
      findings: findings.filter((finding) => finding.provider.id === plan.provider).length,
      testedScope: execution?.testedScope ?? [],
    };
  });
  const payload = {
    schema: "web-doctor.diagnostics-report" as const,
    schemaVersion: 1 as const,
    registryDigest: policy.registryDigest,
    policyDigest: policy.digest,
    scope: { mode: context.scope.mode, files: [...context.scope.files].sort(), base: context.scope.base, baseline: request.baseline?.digest ?? null },
    runs,
    findings,
    controls,
    fullProjectOnly: fullProjectOnly.sort((left, right) => compare(left.provider, right.provider)),
    gate: gateOf(request, controls, findings),
  };
  return diagnosticsReportSchema.parse({ ...payload, digest: digestDocument(payload).digest });
}

function normalize(request: DiagnosticsRequest, plans: readonly ProviderPlan[], executions: ReadonlyMap<string, ProviderExecution>): NormalizedFinding[] {
  const baseline = new Set(request.baseline?.findings.map((finding) => finding.fingerprint) ?? []);
  const findings = new Map<string, NormalizedFinding>();
  for (const plan of plans) {
    const execution = executions.get(plan.provider);
    for (const draft of execution?.drafts ?? []) {
      const source = draft.locations.find((location) => location.kind === "source");
      const obligations = plan.requirements
        .filter((requirement) => requirement.rule === draft.rule || requirement.rule === null)
        .filter((requirement) => source === undefined || requirement.control.control.applicability.files === undefined || evaluateApplicability({ files: requirement.control.control.applicability.files }, { file: source.path }).status === "match")
        .map((requirement) => obligationOf(requirement.control, request.layers.get(requirement.control.control.id) ?? "application"));
      if (obligations.length === 0) continue;
      const onChangedLines = source === undefined || request.context.scope.mode !== "changed-lines" || changedLine(request.context.scope, source.path, source.line, source.endLine ?? source.line);
      const compared = (request.baseline !== undefined && request.baseline !== null) || request.context.scope.mode === "changed-lines";
      const classification = !onChangedLines || baseline.has(fingerprintOf(draft)) ? "existing" : compared ? "introduced" : "unknown";
      const finding = buildFinding(draft, { obligations, registryDigest: request.policy.registryDigest, policyDigest: request.policy.digest, baseline: classification });
      findings.set(finding.id, finding);
    }
  }
  return [...findings.values()].sort((left, right) => compare(left.id, right.id));
}

function evaluateControls(
  request: DiagnosticsRequest,
  plans: readonly ProviderPlan[],
  executions: ReadonlyMap<string, ProviderExecution>,
  findings: readonly NormalizedFinding[],
  outOfScope: ReadonlySet<string>,
): ControlOutcome[] {
  const unresolved = request.unresolved ?? new Set(request.policy.controls
    .filter((entry) => request.policy.unresolvedApplicability.includes(entry.control.id))
    .filter((entry) => Object.keys(entry.control.applicability).some((predicate) => predicate !== "files"))
    .map((entry) => entry.control.id));
  const planned = plans.flatMap((plan) => plan.requirements);
  return request.policy.controls.map((entry): ControlOutcome => {
    const control = entry.control;
    const related = findings.filter((finding) => finding.controls.includes(control.id));
    const reasons: string[] = [];
    const evidence = control.evidence.map((requirement) => {
      const planning = planned.find((item) => item.control.control.id === control.id && item.source === requirement);
      const provider = planning?.provider ?? requirement.provider;
      const rule = planning?.rule ?? requirement.rule ?? null;
      const count = related.filter((finding) => finding.provider.id === provider && (rule === null || finding.rule === rule)).length;
      let status: ControlOutcome["evidence"][number]["status"];
      if (requirement.kind === "manual") status = "manual";
      else if (outOfScope.has(provider) || !inScope(request.context.scope, control)) status = "out_of_scope";
      else {
        const execution = executions.get(provider);
        status = execution === undefined ? "not_run" : rule === null ? execution.completeness : execution.ruleStatus[rule] ?? execution.completeness;
        if (execution !== undefined && status !== "complete" && execution.reason !== null) reasons.push(`${provider}${rule === null ? "" : `/${rule}`}: ${execution.reason}`);
      }
      return { provider, rule, kind: requirement.kind, required: requirement.required, status, findings: count };
    });
    const required = evidence.filter((item) => item.required);
    let status: ControlOutcome["status"];
    if (required.some((item) => item.findings > 0)) status = "not_met";
    else if (unresolved.has(control.id)) {
      status = "not_evaluated";
      reasons.push("Applicability is unresolved for this project");
    } else if (required.length > 0 && required.every((item) => item.status === "out_of_scope")) {
      status = "not_evaluated";
      reasons.push("No required evidence is in the selected scope");
    } else if (required.every((item) => item.status === "complete" || item.status === "out_of_scope")) status = "met";
    else {
      status = "incomplete";
      if (required.some((item) => item.status === "manual")) reasons.push("Manual review is required and cannot be satisfied automatically");
    }
    if (status === "not_met" && related.every((finding) => finding.baseline === "existing")) reasons.push("Only existing findings; nothing introduced in this scope");
    const rendered = evidence.filter((item) => item.kind === "rendered");
    const tested = [...new Set(rendered.flatMap((item) => executions.get(item.provider)?.testedScope ?? []))].sort();
    const limitations = rendered.length === 0 ? [] : [tested.length === 0
      ? "No rendered state was tested, so rendered accessibility evidence is missing"
      : `Automated rendered checks cover only detectable rules in the tested states (${tested.join("; ")}); they do not establish WCAG conformance`];
    return {
      control: control.id,
      title: control.title,
      strength: control.strength,
      layer: request.layers.get(control.id) ?? "application",
      status,
      evidence,
      findings: related.map((finding) => finding.id),
      reasons: [...new Set(reasons)].sort(),
      limitations,
      obligations: remainingObligations(request, entry, evidence, tested),
    };
  });
}

/**
 * Verification a run did not perform: every verification entry except the
 * automated check that completed for this Control, manual-review guidance
 * that applies to it, and, for rendered evidence, the states nobody tested.
 */
function remainingObligations(
  request: DiagnosticsRequest,
  entry: EffectivePolicySnapshot["controls"][number],
  evidence: readonly ControlOutcome["evidence"][number][],
  tested: readonly string[],
): ControlOutcome["obligations"] {
  const completed = new Set<string>(evidence.filter((item) => item.status === "complete").map((item) => (item.kind === "rendered" ? "axe" : item.kind === "static" ? "eslint" : item.kind)));
  const obligations = entry.control.verification
    .filter((item) => !completed.has(item.kind))
    .map((item) => ({ kind: item.kind, description: item.description, source: entry.control.id }));
  const rendered = evidence.some((item) => item.kind === "rendered");
  for (const guidance of request.guidance ?? []) {
    if (guidance.classification !== "manual_review") continue;
    const applies = guidance.controls.includes(entry.control.id) || (guidance.controls.length === 0 && rendered && guidance.evidencePrerequisites.includes("rendered"));
    if (applies) for (const item of guidance.verification) obligations.push({ kind: item.kind, description: item.description, source: guidance.id });
  }
  if (rendered) {
    obligations.push({ kind: "untested-states", description: tested.length === 0 ? "No rendered state was tested" : `States other than those tested (${tested.join("; ")}) remain untested`, source: "runtime-scope" });
  }
  return [...new Map(obligations.map((item) => [`${item.kind}\0${item.description}`, item])).values()];
}

const STRENGTH: Readonly<Record<RequirementStrength, number>> = { informational: 0, recommended: 1, required: 2 };
export const EXIT_CODES = { pass: 0, fail: 2, conflict: 3, incomplete: 4 } as const;

/**
 * The CI gate: conflicts and blockers first, then Controls at or above the
 * gate level with introduced findings, then incomplete required evidence.
 * Locally, incomplete evidence is advisory.
 */
function gateOf(request: DiagnosticsRequest, controls: readonly ControlOutcome[], findings: readonly NormalizedFinding[]): DiagnosticsReport["gate"] {
  const level = request.gate;
  const gated = controls.filter((outcome) => STRENGTH[outcome.strength] >= STRENGTH[level]);
  const blockers = [...(request.blockers ?? []), ...request.policy.conflicts];
  if (blockers.length > 0) return { level, status: "conflict", exitCode: EXIT_CODES.conflict, reasons: [...new Set(blockers)].sort() };
  const introduced = new Set(findings.filter((finding) => finding.baseline !== "existing").map((finding) => finding.id));
  const failing = gated.filter((outcome) => outcome.status === "not_met" && outcome.findings.some((id) => introduced.has(id)));
  if (failing.length > 0) return { level, status: "fail", exitCode: EXIT_CODES.fail, reasons: failing.map((outcome) => `${outcome.control} has ${outcome.findings.filter((id) => introduced.has(id)).length} introduced findings`) };
  const incomplete = gated.filter((outcome) => outcome.status === "incomplete");
  if (incomplete.length > 0) {
    const reasons = incomplete.map((outcome) => `${outcome.control} lacks complete required evidence`);
    return request.mode === "ci" ? { level, status: "incomplete", exitCode: EXIT_CODES.incomplete, reasons } : { level, status: "pass", exitCode: EXIT_CODES.pass, reasons };
  }
  return { level, status: "pass", exitCode: EXIT_CODES.pass, reasons: [] };
}

function inScope(scope: DiagnosticScope, control: EffectivePolicySnapshot["controls"][number]["control"]): boolean {
  if (scope.mode === "full" || control.applicability.files === undefined) return true;
  return scope.files.some((file) => evaluateApplicability({ files: control.applicability.files }, { file }).status === "match");
}

function changedLine(scope: DiagnosticScope, file: string, start: number, end: number): boolean {
  return (scope.lines.get(file) ?? []).some(([from, to]) => start <= to && end >= from);
}

export function unavailable(plan: Pick<ProviderPlan, "provider" | "rules">, reason: string): ProviderExecution {
  return { provider: plan.provider, engineVersion: null, completeness: "unavailable", reason, ruleStatus: Object.fromEntries(plan.rules.map((rule) => [rule, "unavailable" as const])), capabilities: [], denied: [], files: 0, drafts: [] };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
