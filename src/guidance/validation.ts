import semver from "semver";
import type { GuidanceEntry, PolicyPack } from "../contracts/index.js";

/**
 * Checks guidance entries beyond their schema: problems that would make
 * advice unsupported or self-contradictory. Catalog validation, snapshot
 * compilation, and embedded loading all refuse entries with problems, so
 * none can reach a package snapshot.
 */

export interface GuidanceProblem {
  code: "duplicate_guidance" | "unsupported_evidence" | "missing_measurement" | "unknown_control" | "invalid_range" | "never_applies";
  guidance: string;
  message: string;
}

const MEASUREMENT_KINDS = new Set(["measurement", "profile", "trace"]);

export function guidanceProblems(input: { guidance: readonly GuidanceEntry[]; policies: readonly PolicyPack[] }): GuidanceProblem[] {
  const problems: GuidanceProblem[] = [];
  const controls = new Set(input.policies.flatMap((policy) => policy.controls.map((control) => control.id)));
  const counts = new Map<string, number>();
  for (const entry of input.guidance) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) problems.push({ code: "duplicate_guidance", guidance: id, message: `Guidance ${id} is defined ${count} times` });
  }
  for (const entry of input.guidance) {
    const add = (code: GuidanceProblem["code"], message: string) => problems.push({ code, guidance: entry.id, message });
    if (entry.classification === "defect" && !entry.evidencePrerequisites.some((kind) => kind !== "manual")) {
      add("unsupported_evidence", "A proven defect needs static, rendered, or measured evidence, not manual review alone");
    }
    if (entry.classification === "measurement_required" && !entry.verification.some((item) => MEASUREMENT_KINDS.has(item.kind))) {
      add("missing_measurement", "Measurement-required guidance must say how to measure with a measurement, profile, or trace verification");
    }
    for (const control of entry.controls) {
      if (!controls.has(control)) add("unknown_control", `References Control ${control}, which no policy defines`);
    }
    const ranges: [string, string, string | undefined][] = [
      ...(entry.applicability.capabilities ?? []).map((item) => ["capability", item.name, item.range] as [string, string, string | undefined]),
      ...(entry.applicability.dependencies ?? []).map((item) => ["dependency", item.name, item.range] as [string, string, string | undefined]),
      ...(entry.applicability.runtimes ?? []).map((item) => ["runtime", item.name, item.range] as [string, string, string | undefined]),
    ];
    const byName = new Map<string, string[]>();
    for (const [kind, name, range] of ranges) {
      if (range === undefined) continue;
      if (semver.validRange(range) === null) {
        add("invalid_range", `The ${kind} range ${range} for ${name} is not a valid version range`);
        continue;
      }
      const key = `${kind}:${name}`;
      for (const other of byName.get(key) ?? []) {
        if (!semver.intersects(range, other)) add("never_applies", `The ${kind} ranges ${other} and ${range} for ${name} never overlap`);
      }
      byName.set(key, [...(byName.get(key) ?? []), range]);
    }
    const include = entry.applicability.files?.include ?? [];
    const excluded = include.filter((pattern) => (entry.applicability.files?.exclude ?? []).includes(pattern));
    if (include.length > 0 && excluded.length === include.length) add("never_applies", "Every included file pattern is also excluded");
  }
  return problems.sort((left, right) => `${left.guidance}\0${left.code}\0${left.message}`.localeCompare(`${right.guidance}\0${right.code}\0${right.message}`));
}

export class GuidanceValidationError extends Error {
  override readonly name = "GuidanceValidationError";

  constructor(readonly problems: readonly GuidanceProblem[]) {
    super(`Guidance cannot enter the registry snapshot:\n${problems.map((problem) => `${problem.guidance}: ${problem.message}`).join("\n")}`);
  }
}

export function assertValidGuidance(input: { guidance: readonly GuidanceEntry[]; policies: readonly PolicyPack[] }): void {
  const problems = guidanceProblems(input);
  if (problems.length > 0) throw new GuidanceValidationError(problems);
}
