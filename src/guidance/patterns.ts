import { compareCodeUnits } from "@repo-facts/contract";
import type { ApprovedPattern, EffectivePolicySnapshot, FindingObligation, NormalizedFinding, PolicyControl, PolicyLayer, RequirementStrength } from "../contracts/index.js";
import type { ProjectSnapshot } from "../facts/project-snapshot.js";
import { evaluateApplicability } from "../runtime/applicability.js";
import type { GuidanceSelection } from "./selection.js";

/**
 * Approved enterprise patterns in place of generic advice. A pattern applies
 * only through an effective Control: for a finding, a Control the finding
 * already carries as an obligation; for a file, a Control whose file scope
 * includes it. Components, tokens, APIs, analytics events, runtime
 * integrations, and remediation patterns substitute for generic remediation.
 * Content terms refine it. Every obligation stays attached, and patterns
 * from different Controls that disagree are reported as a conflict instead
 * of being resolved by layer order.
 */

export type PatternRole = "substitute" | "refinement";

export interface PatternSource {
  control: string;
  layer: PolicyLayer | null;
  strength: RequirementStrength;
  policy: string;
}

export interface PatternOccurrence {
  path: string;
  line: number;
  column: number;
  specifier: string;
}

export interface PatternUse {
  kind: ApprovedPattern["kind"];
  name: string;
  module: string | null;
  usage: string;
  replaces: { modules: string[]; terms: string[] };
  role: PatternRole;
  /** True only when a required effective Control supplies the pattern. */
  mandatory: boolean;
  sources: PatternSource[];
  /** Imports of superseded modules, from Web Doctor's source index. */
  occurrences: PatternOccurrence[];
}

export interface PatternConflict {
  kind: ApprovedPattern["kind"];
  subject: string;
  patterns: PatternUse[];
  message: string;
}

export interface FindingRecommendation {
  finding: string;
  status: "approved" | "generic" | "conflict" | "stale";
  reason: string;
  approved: PatternUse[];
  conflicts: PatternConflict[];
  /** Remediation from Controls without patterns and from matching registry guidance. */
  generic: { remediation: string[]; replaced: boolean };
  /** Every Control obligation of the finding, unchanged. */
  obligations: FindingObligation[];
  mandatory: boolean;
  policyDigest: string;
  modifiesProject: false;
}

export interface FilePatterns {
  file: string;
  patterns: PatternUse[];
  conflicts: PatternConflict[];
  /** Controls whose applicability to this file is unresolved; their patterns are not offered. */
  unresolved: string[];
  policyDigest: string;
  modifiesProject: false;
}

export interface FindingRecommendationInput {
  finding: NormalizedFinding;
  policy: EffectivePolicySnapshot;
  layers: ReadonlyMap<string, PolicyLayer>;
  guidance?: readonly GuidanceSelection[];
}

export function recommendForFinding(input: FindingRecommendationInput): FindingRecommendation {
  const { finding, policy } = input;
  const effective = new Map(policy.controls.map((entry) => [entry.control.id, entry]));
  const guided = (input.guidance ?? []).filter((selection) => selection.status === "applicable" && selection.findings.includes(finding.id)).flatMap((selection) => selection.entry.alternatives);
  const base = { finding: finding.id, obligations: finding.obligations, policyDigest: policy.digest, modifiesProject: false as const };
  if (finding.policyDigest !== policy.digest) {
    return { ...base, status: "stale", reason: "The finding was produced under a different effective policy; run the check again before applying approved patterns", approved: [], conflicts: [], generic: { remediation: unique([...finding.remediation, ...guided]), replaced: false }, mandatory: false };
  }
  const contributing = finding.obligations.flatMap((obligation) => {
    const entry = effective.get(obligation.control);
    return entry?.control.patterns === undefined ? [] : [{ control: entry.control, source: { control: obligation.control, layer: obligation.layer, strength: obligation.strength, policy: obligation.policy } }];
  });
  const withPatterns = new Set(contributing.map((item) => item.control.id));
  const generic = unique([...finding.obligations.filter((obligation) => !withPatterns.has(obligation.control)).flatMap((obligation) => (obligation.remediation === null ? [] : [obligation.remediation])), ...guided]);
  const { approved, conflicts } = combine(contributing, () => []);
  const substitutes = approved.filter((pattern) => pattern.role === "substitute");
  const status = conflicts.length > 0 ? "conflict" : substitutes.length > 0 ? "approved" : "generic";
  const reason = status === "conflict"
    ? "Effective Controls supply approved patterns that disagree; resolve the conflict in policy before choosing one"
    : status === "approved"
      ? `Approved ${substitutes.map((pattern) => pattern.name).join(", ")} from ${[...new Set(substitutes.flatMap((pattern) => pattern.sources.map((source) => source.control)))].join(", ")} ${substitutes.length === 1 ? "replaces" : "replace"} generic remediation`
      : approved.length > 0 ? "No effective Control supplies a substitute pattern; generic remediation applies with the approved terms" : "No effective Control of this finding supplies an approved pattern";
  return { ...base, status, reason, approved, conflicts, generic: { remediation: generic, replaced: status === "approved" }, mandatory: approved.some((pattern) => pattern.mandatory) };
}

export interface FilePatternsInput {
  policy: EffectivePolicySnapshot;
  layers: ReadonlyMap<string, PolicyLayer>;
  snapshot: ProjectSnapshot;
  file: string;
}

export function patternsForFile(input: FilePatternsInput): FilePatterns {
  const { policy, file } = input;
  const unresolvedByPolicy = new Set(policy.unresolvedApplicability);
  const unresolved: string[] = [];
  const contributing: { control: PolicyControl; source: PatternSource }[] = [];
  for (const entry of policy.controls) {
    if (entry.control.patterns === undefined) continue;
    const { files, ...rest } = entry.control.applicability;
    if (unresolvedByPolicy.has(entry.control.id) && Object.keys(rest).length > 0) {
      unresolved.push(entry.control.id);
      continue;
    }
    if (files !== undefined && evaluateApplicability({ files }, { file }).status !== "match") continue;
    contributing.push({ control: entry.control, source: { control: entry.control.id, layer: input.layers.get(entry.control.id) ?? null, strength: entry.control.strength, policy: entry.policyContribution.id } });
  }
  const imports = input.snapshot.extensions.index.modules.find((module) => module.path === file)?.imports ?? [];
  const occurrencesOf = (pattern: ApprovedPattern): PatternOccurrence[] => imports.flatMap((imported) => {
    const specifier = imported.specifier;
    if (specifier === null || !(pattern.replaces?.modules ?? []).some((module) => specifier === module || specifier.startsWith(`${module}/`))) return [];
    return [{ path: file, line: imported.location.line, column: imported.location.column, specifier }];
  });
  const { approved, conflicts } = combine(contributing, occurrencesOf);
  return { file, patterns: approved, conflicts, unresolved: unresolved.sort(compareCodeUnits), policyDigest: policy.digest, modifiesProject: false };
}

/**
 * Accumulates compatible patterns. For a substitute kind, the patterns every
 * contributing Control accepts are approved; Controls with no pattern in
 * common conflict. Content terms accumulate unless two Controls replace the
 * same term with different names.
 */
function combine(contributing: readonly { control: PolicyControl; source: PatternSource }[], occurrencesOf: (pattern: ApprovedPattern) => PatternOccurrence[]): { approved: PatternUse[]; conflicts: PatternConflict[] } {
  const uses = new Map<string, PatternUse>();
  for (const { control, source } of contributing) {
    for (const pattern of control.patterns ?? []) {
      const key = identity(pattern);
      const existing = uses.get(key);
      if (existing !== undefined) {
        if (!existing.sources.some((item) => item.control === source.control)) existing.sources.push(source);
        existing.mandatory ||= source.strength === "required";
        continue;
      }
      uses.set(key, {
        kind: pattern.kind,
        name: pattern.name,
        module: pattern.module ?? null,
        usage: pattern.usage,
        replaces: { modules: [...(pattern.replaces?.modules ?? [])].sort(compareCodeUnits), terms: [...(pattern.replaces?.terms ?? [])].sort(compareCodeUnits) },
        role: pattern.kind === "content-term" ? "refinement" : "substitute",
        mandatory: source.strength === "required",
        sources: [source],
        occurrences: occurrencesOf(pattern),
      });
    }
  }
  const all = [...uses.values()].map((use) => ({ ...use, sources: use.sources.sort((left, right) => compareCodeUnits(left.control, right.control)) }));
  const approved: PatternUse[] = [];
  const conflicts: PatternConflict[] = [];

  for (const kind of [...new Set(all.filter((use) => use.role === "substitute").map((use) => use.kind))].sort(compareCodeUnits)) {
    const ofKind = all.filter((use) => use.kind === kind);
    const controls = [...new Set(ofKind.flatMap((use) => use.sources.map((source) => source.control)))];
    const common = ofKind.filter((use) => controls.every((control) => use.sources.some((source) => source.control === control)));
    if (common.length > 0) approved.push(...common);
    else conflicts.push({ kind, subject: kind, patterns: ofKind, message: `${controls.join(", ")} require different approved ${kind} patterns: ${ofKind.map(label).join(", ")}` });
  }

  const terms = all.filter((use) => use.role === "refinement");
  const conflicted = new Set<PatternUse>();
  for (const term of [...new Set(terms.flatMap((use) => use.replaces.terms))].sort(compareCodeUnits)) {
    const replacing = terms.filter((use) => use.replaces.terms.includes(term));
    if (new Set(replacing.map((use) => use.name)).size < 2) continue;
    for (const use of replacing) conflicted.add(use);
    conflicts.push({ kind: "content-term", subject: term, patterns: replacing, message: `${[...new Set(replacing.flatMap((use) => use.sources.map((source) => source.control)))].join(", ")} replace "${term}" with different terms: ${replacing.map((use) => `"${use.name}"`).join(", ")}` });
  }
  approved.push(...terms.filter((use) => !conflicted.has(use)));
  return { approved: approved.sort(byPattern), conflicts };
}

function identity(pattern: ApprovedPattern): string {
  return `${pattern.kind}\0${pattern.name}\0${pattern.module ?? ""}`;
}

function label(use: PatternUse): string {
  return use.module === null ? use.name : `${use.name} from ${use.module}`;
}

function byPattern(left: PatternUse, right: PatternUse): number {
  return compareCodeUnits(left.role, right.role) * -1 || compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.name, right.name) || compareCodeUnits(left.module ?? "", right.module ?? "");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
