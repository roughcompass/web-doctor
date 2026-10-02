import {
  canonicalJson,
  digestDocument,
  effectivePolicySnapshotSchema,
  sha256,
  type EffectivePolicySnapshot,
  type PolicyControl,
  type PolicyFactProvenance,
} from "../contracts/index.js";
import { WEB_DOCTOR_VERSION } from "../version.js";
import type { ComposedPolicy } from "./policy-composition.js";

export interface EffectivePolicyOptions {
  composition: ComposedPolicy;
  resolverVersion?: string;
  webDoctorVersion?: string;
  capabilityCertainty?: Readonly<Record<string, "observed" | "inferred" | "unknown" | "conflicting">>;
  /** The project facts the resolution used; without them the snapshot records incomplete facts. */
  facts?: PolicyFactProvenance;
}

const NO_FACTS: PolicyFactProvenance = { status: "incomplete", detectorRelease: null, configurationDigest: null, factDocumentDigest: null, extensionStateDigest: null };

export function createEffectivePolicySnapshot(options: EffectivePolicyOptions): EffectivePolicySnapshot {
  const composition = options.composition;
  const payload = {
    schema: "web-doctor.effective-policy" as const,
    schemaVersion: 3 as const,
    webDoctorVersion: options.webDoctorVersion ?? WEB_DOCTOR_VERSION,
    registryDigest: composition.registryDigest,
    resolverVersion: options.resolverVersion ?? "1.0.0",
    portals: [...composition.portals].sort(),
    capabilities: Object.fromEntries(Object.entries(options.capabilityCertainty ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    facts: { ...(options.facts ?? NO_FACTS) },
    contributions: [...composition.contributions].sort((left, right) => left.id.localeCompare(right.id)),
    controls: composition.controls
      .map((entry) => ({ control: normalizeControl(entry.control), policyContribution: entry.policyContribution }))
      .sort((left, right) => `${left.control.id}\0${left.policyContribution.id}`.localeCompare(`${right.control.id}\0${right.policyContribution.id}`)),
    exceptions: [...composition.exceptions].sort(),
    conflicts: [...composition.conflicts].sort(),
    unresolvedApplicability: [...composition.unresolvedApplicability].sort(),
  };
  return effectivePolicySnapshotSchema.parse({ ...payload, digest: sha256(canonicalJson(payload)) });
}

export function verifyEffectivePolicyDigest(snapshot: EffectivePolicySnapshot): boolean {
  const { digest, ...payload } = snapshot;
  return digest === sha256(canonicalJson(payload));
}

function normalizeControl(control: PolicyControl): PolicyControl {
  return {
    ...control,
    evidence: uniqueSorted(control.evidence, (entry) => canonicalJson(entry)),
    verification: uniqueSorted(control.verification, (entry) => canonicalJson(entry)),
  };
}

function uniqueSorted<Value>(values: readonly Value[], key: (value: Value) => string): Value[] {
  return [...new Map(values.map((value) => [key(value), value])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

export function registryDigestForEffectivePolicy(registry: Parameters<typeof digestDocument>[0]): string {
  return digestDocument(registry).digest;
}