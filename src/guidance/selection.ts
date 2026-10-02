import { type FactDocument, compareCodeUnits } from "@repo-facts/contract";
import type { EffectivePolicySnapshot, FactCertainty, GuidanceEntry, NormalizedFinding, RegistrySnapshot, RepositoryConfig } from "../contracts/index.js";
import { CAPABILITY_VOCABULARY, policyFactsFor } from "../core/policy-facts.js";
import type { ProjectSnapshot } from "../facts/project-snapshot.js";
import { evaluateApplicability, type ApplicabilityReason } from "../runtime/applicability.js";

/**
 * Selects the guidance that applies to this project from the facts it
 * depends on. Applicability uses the same derivation as effective policy:
 * shared facts from the pinned release, extension facts, repository
 * configuration, and the selected portals. When a fact a guidance entry needs
 * is unknown, conflicting, skipped, stale, or unavailable, the entry is
 * unresolved and says why; it never falls back to generic advice.
 */

export type GuidanceStatus = "applicable" | "unresolved" | "not_applicable";

export interface GuidanceDependency {
  kind: "capability" | "dependency" | "runtime" | "metadata";
  name: string;
  value: string | number | boolean | null;
  certainty: FactCertainty;
}

export interface GuidanceSelection {
  guidance: string;
  version: string;
  classification: GuidanceEntry["classification"];
  /**
   * The classification this project's evidence supports: guidance that
   * claims a defect from measurement stays measurement-required until a
   * measurement is supplied.
   */
  effectiveClassification: GuidanceEntry["classification"];
  status: GuidanceStatus;
  reasons: ApplicabilityReason[];
  unresolved: string[];
  dependsOn: GuidanceDependency[];
  controls: string[];
  findings: string[];
  /** True only when an effective required Control makes the guidance mandatory. */
  mandatory: boolean;
  evidence: { required: string[]; present: string[] };
  entry: GuidanceEntry;
}

export interface GuidanceSelectionInput {
  registry: RegistrySnapshot;
  snapshot: ProjectSnapshot;
  policy: EffectivePolicySnapshot;
  config: RepositoryConfig | null;
  file?: string;
  findings?: readonly NormalizedFinding[];
  /** The working tree the caller is asking about; a different snapshot is stale. */
  expectedTreeDigest?: string;
  /** Whether measured evidence, such as a profile, was supplied. */
  measured?: boolean;
}

export function selectGuidance(input: GuidanceSelectionInput): GuidanceSelection[] {
  const { snapshot, policy } = input;
  const facts = policyFactsFor(snapshot, input.registry, input.config);
  const shared = snapshot.shared.status === "complete" ? snapshot.shared.document : null;
  const stale = input.expectedTreeDigest !== undefined && input.expectedTreeDigest !== snapshot.treeDigest;
  const effective = new Map(policy.controls.map((entry) => [entry.control.id, entry.control]));
  return input.registry.guidance.map((entry): GuidanceSelection => {
    const result = evaluateApplicability(entry.applicability, {
      ...facts.facts,
      portals: policy.portals,
      ...(input.file === undefined ? {} : { file: input.file }),
    });
    const dependsOn: GuidanceDependency[] = [
      ...(entry.applicability.capabilities ?? []).map((item) => ({ kind: "capability" as const, name: item.name, value: facts.facts.capabilities?.[item.name] ?? null, certainty: facts.capabilityCertainty[item.name] ?? "unknown" })),
      ...(entry.applicability.dependencies ?? []).map((item) => ({ kind: "dependency" as const, name: item.name, value: facts.facts.dependencies?.[item.name] ?? null, certainty: certaintyOf(facts.facts.dependencies?.[item.name]) })),
      ...(entry.applicability.runtimes ?? []).map((item) => ({ kind: "runtime" as const, name: item.name, value: facts.facts.runtimes?.[item.name] ?? null, certainty: certaintyOf(facts.facts.runtimes?.[item.name]) })),
      ...Object.keys(entry.applicability.applicationMetadata ?? {}).map((name) => ({ kind: "metadata" as const, name, value: facts.facts.applicationMetadata?.[name] ?? null, certainty: certaintyOf(facts.facts.applicationMetadata?.[name]) })),
    ];
    const unresolved: string[] = [];
    let status: GuidanceStatus = result.status === "match" ? "applicable" : result.status === "no-match" ? "not_applicable" : "unresolved";
    const needsFacts = dependsOn.length > 0;
    if (needsFacts && stale) {
      status = "unresolved";
      unresolved.push("The project facts are stale: they describe a different working tree than the one asked about");
    } else if (needsFacts && shared === null) {
      status = "unresolved";
      unresolved.push(`Shared repository facts are unavailable: ${snapshot.shared.status === "incomplete" ? snapshot.shared.reason : "unknown"}`);
    } else if (status === "unresolved") {
      for (const dependency of dependsOn.filter((item) => item.value === null)) unresolved.push(explain(dependency, shared));
      for (const reason of result.reasons.filter((item) => item.status === "unresolved" && item.predicate !== "capabilities" && item.predicate !== "dependencies" && item.predicate !== "runtimes" && item.predicate !== "applicationMetadata")) unresolved.push(reason.message);
      if (unresolved.length === 0) unresolved.push(...result.reasons.filter((item) => item.status === "unresolved").map((item) => item.message));
    }
    const controls = entry.controls.filter((id) => effective.has(id));
    const findings = (input.findings ?? []).filter((finding) => finding.controls.some((id) => entry.controls.includes(id)));
    const unmeasured = entry.classification === "defect" && entry.evidencePrerequisites.includes("measured") && input.measured !== true;
    return {
      guidance: entry.id,
      version: entry.version,
      classification: entry.classification,
      effectiveClassification: unmeasured ? "measurement_required" : entry.classification,
      status,
      reasons: result.reasons,
      unresolved: [...new Set(unresolved)],
      dependsOn,
      controls,
      findings: findings.map((finding) => finding.id),
      mandatory: controls.some((id) => effective.get(id)?.strength === "required"),
      evidence: { required: [...entry.evidencePrerequisites].sort(), present: [...new Set(findings.map((finding) => finding.evidenceKind))].sort() },
      entry,
    };
  }).sort((left, right) => compareCodeUnits(left.guidance, right.guidance));
}

function certaintyOf(value: unknown): FactCertainty {
  return value === undefined || value === null ? "unknown" : "observed";
}

/** Why a fact is not established: conflicting candidates, skipped inputs, or no evidence. */
function explain(dependency: GuidanceDependency, shared: FactDocument | null): string {
  if (dependency.certainty === "conflicting") return `The ${dependency.kind} ${dependency.name} has conflicting facts`;
  const categories = dependency.kind === "capability"
    ? Object.entries(CAPABILITY_VOCABULARY).filter(([, names]) => names.includes(dependency.name)).map(([category]) => category)
    : dependency.kind === "dependency" ? ["dependencies", "resolved_dependencies"] : dependency.kind === "runtime" ? ["runtime_requirements"] : [];
  const skipped = categories.flatMap((category) => shared?.categories[category]?.search.skipped ?? []);
  if (skipped.length > 0) return `The ${dependency.kind} ${dependency.name} is unknown because inputs were skipped: ${[...new Set(skipped)].slice(0, 3).join(", ")}`;
  if (dependency.kind === "runtime") {
    const fact = shared?.categories.runtime_requirements?.facts.find((candidate) => candidate.key === dependency.name);
    if (fact?.state === "conflicting") return `The runtime ${dependency.name} has conflicting facts`;
  }
  if (dependency.kind === "metadata") return `Application metadata ${dependency.name} is not configured`;
  return `No fact establishes the ${dependency.kind} ${dependency.name}`;
}
