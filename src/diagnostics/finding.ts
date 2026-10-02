import { redactValue } from "../core/redaction.js";
import {
  canonicalJson,
  normalizedFindingSchema,
  sha256,
  stableIdentifier,
  type EffectivePolicySnapshot,
  type FindingLocation,
  type FindingObligation,
  type NormalizedFinding,
} from "../contracts/index.js";

/**
 * Builds the one normalized finding every provider emits. Identity depends
 * only on what the finding says and where: the provider, rule, locations, and
 * message. The fingerprint drops line numbers so a baseline recognizes the
 * same issue after unrelated edits move it.
 */

export type FindingDraft = Omit<NormalizedFinding, "schema" | "schemaVersion" | "id" | "fingerprint" | "controls" | "obligations" | "remediation" | "verification" | "baseline" | "registryDigest" | "policyDigest" | "fix" | "suppression"> & {
  fix?: { available: boolean; description: string | null };
  suppression?: NormalizedFinding["suppression"];
  /** Text that recognizes the issue independently of its line, such as the flagged source line trimmed. */
  anchor?: string;
};

export interface FindingContext {
  obligations: readonly FindingObligation[];
  registryDigest: string;
  policyDigest: string;
  baseline?: NormalizedFinding["baseline"];
}

const MAX_STRING = 500;
const MAX_ITEMS = 50;
const MAX_DEPTH = 4;

export function buildFinding(draft: FindingDraft, context: FindingContext): NormalizedFinding {
  const obligations = [...new Map(context.obligations.map((obligation) => [obligation.control, obligation])).values()].sort((left, right) => compare(left.control, right.control));
  const locations = sortedLocations(draft.locations);
  // Provider messages and evidence can quote source; credentials never leave the finding.
  const { anchor, fix, suppression, ...unredacted } = draft;
  const rest = redactValue(unredacted).value;
  return normalizedFindingSchema.parse({
    ...rest,
    schema: "web-doctor.finding",
    schemaVersion: 2,
    id: findingId(draft.provider.id, draft.rule, locations, rest.message),
    fingerprint: findingFingerprint(draft.provider.id, draft.rule, locations, rest.message, anchor),
    locations,
    controls: obligations.map((obligation) => obligation.control),
    obligations,
    remediation: [...new Set(obligations.flatMap((obligation) => (obligation.remediation === null ? [] : [obligation.remediation])))],
    verification: [...new Map(obligations.flatMap((obligation) => obligation.verification).map((entry) => [canonicalJson(entry), entry])).values()],
    fix: { available: fix?.available ?? false, description: fix?.description ?? null, applied: false },
    suppression: suppression === undefined || suppression === null ? null : redactValue(suppression).value,
    baseline: context.baseline ?? "unknown",
    original: bounded(rest.original, 0) as Record<string, unknown>,
    registryDigest: context.registryDigest,
    policyDigest: context.policyDigest,
  });
}

/** The fingerprint a draft's finding will carry. */
export function fingerprintOf(draft: FindingDraft): string {
  return findingFingerprint(draft.provider.id, draft.rule, sortedLocations(draft.locations), draft.message, draft.anchor);
}

function sortedLocations(locations: readonly FindingLocation[]): FindingLocation[] {
  return [...locations].sort((left, right) => compare(canonicalJson(left), canonicalJson(right)));
}

export function findingId(provider: string, rule: string, locations: readonly FindingLocation[], message: string): string {
  return stableIdentifier("finding", { provider, rule, locations, message });
}

export function findingFingerprint(provider: string, rule: string, locations: readonly FindingLocation[], message: string, anchor?: string): string {
  const places = locations.map((location) => (location.kind === "source" ? { path: location.path } : { url: location.url, state: location.state, target: location.target }));
  return sha256(canonicalJson({ provider, rule, places, message, anchor: anchor ?? null }));
}

/** Each effective Control's obligation, with its own remediation and verification. */
export function obligationOf(entry: EffectivePolicySnapshot["controls"][number], layer: FindingObligation["layer"]): FindingObligation {
  return {
    control: entry.control.id,
    title: entry.control.title,
    strength: entry.control.strength,
    layer,
    policy: entry.policyContribution.id,
    contribution: entry.policyContribution.id,
    remediation: entry.control.remediation ?? null,
    verification: entry.control.verification,
  };
}

/** Provider evidence reduced to canonical JSON of bounded size, depth, and string length. */
function bounded(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : String(value);
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => bounded(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined && typeof item !== "function").slice(0, MAX_ITEMS).map(([key, item]) => [key, bounded(item, depth + 1)]));
  }
  return null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
