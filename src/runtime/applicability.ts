import { minimatch } from "minimatch";
import semver from "semver";
import type { PolicyControl } from "../contracts/index.js";

export type ApplicabilityStatus = "match" | "no-match" | "unresolved";

export interface ApplicabilityFacts {
  portals?: readonly string[];
  file?: string;
  capabilities?: Readonly<Record<string, string | true>>;
  dependencies?: Readonly<Record<string, string>>;
  runtimes?: Readonly<Record<string, string>>;
  applicationMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ApplicabilityReason {
  predicate: "portals" | "files" | "capabilities" | "dependencies" | "runtimes" | "applicationMetadata";
  status: ApplicabilityStatus;
  message: string;
}

export interface ApplicabilityResult {
  status: ApplicabilityStatus;
  reasons: ApplicabilityReason[];
}

export function evaluateApplicability(
  applicability: PolicyControl["applicability"],
  facts: ApplicabilityFacts,
): ApplicabilityResult {
  const reasons: ApplicabilityReason[] = [];
  if (applicability.portals !== undefined) {
    if (facts.portals === undefined) reasons.push(reason("portals", "unresolved", "Selected portals are unavailable"));
    else {
      const matches = applicability.portals.anyOf.some((portal) => facts.portals!.includes(portal));
      reasons.push(reason("portals", matches ? "match" : "no-match", matches ? "A selected portal matched" : "No selected portal matched"));
    }
  }
  if (applicability.files !== undefined) {
    if (facts.file === undefined) reasons.push(reason("files", "unresolved", "Target file is unavailable"));
    else {
      const included = applicability.files.include === undefined || applicability.files.include.some((pattern) => minimatch(facts.file!, pattern));
      const excluded = applicability.files.exclude?.some((pattern) => minimatch(facts.file!, pattern)) ?? false;
      reasons.push(reason("files", included && !excluded ? "match" : "no-match", excluded ? "Target file is excluded" : included ? "Target file matched" : "Target file did not match includes"));
    }
  }
  evaluateVersionPredicates("capabilities", applicability.capabilities, facts.capabilities, reasons);
  evaluateVersionPredicates("dependencies", applicability.dependencies, facts.dependencies, reasons);
  evaluateVersionPredicates("runtimes", applicability.runtimes, facts.runtimes, reasons);
  if (applicability.applicationMetadata !== undefined) {
    if (facts.applicationMetadata === undefined) reasons.push(reason("applicationMetadata", "unresolved", "Application metadata is unavailable"));
    else {
      let status: ApplicabilityStatus = "match";
      let message = "Application metadata matched";
      for (const [key, expected] of Object.entries(applicability.applicationMetadata)) {
        if (!(key in facts.applicationMetadata)) {
          status = "unresolved";
          message = `Application metadata ${key} is unavailable`;
        } else if (facts.applicationMetadata[key] !== expected) {
          status = "no-match";
          message = `Application metadata ${key} did not match`;
          break;
        }
      }
      reasons.push(reason("applicationMetadata", status, message));
    }
  }
  const status = reasons.some((entry) => entry.status === "no-match")
    ? "no-match"
    : reasons.some((entry) => entry.status === "unresolved") ? "unresolved" : "match";
  return { status, reasons };
}

function evaluateVersionPredicates(
  predicate: "capabilities" | "dependencies" | "runtimes",
  requirements: readonly { name: string; range?: string | undefined }[] | undefined,
  facts: Readonly<Record<string, string | true>> | undefined,
  reasons: ApplicabilityReason[],
): void {
  if (requirements === undefined) return;
  if (facts === undefined) {
    reasons.push(reason(predicate, "unresolved", `${label(predicate)} are unavailable`));
    return;
  }
  let status: ApplicabilityStatus = "match";
  let message = `${label(predicate)} matched`;
  for (const requirement of requirements) {
    const observed = facts[requirement.name];
    if (observed === undefined || (requirement.range !== undefined && observed === true)) {
      status = "unresolved";
      message = `${predicate} ${requirement.name} is unavailable`;
    } else if (requirement.range !== undefined && typeof observed === "string" && !semver.satisfies(observed, requirement.range)) {
      status = "no-match";
      message = `${predicate} ${requirement.name}@${observed} is outside ${requirement.range}`;
      break;
    }
  }
  reasons.push(reason(predicate, status, message));
}

function reason(predicate: ApplicabilityReason["predicate"], status: ApplicabilityStatus, message: string): ApplicabilityReason {
  return { predicate, status, message };
}

function label(predicate: ApplicabilityReason["predicate"]): string {
  return predicate[0]!.toUpperCase() + predicate.slice(1);
}