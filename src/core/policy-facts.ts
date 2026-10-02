import type { DocumentFact, FactDocument } from "@repo-facts/contract";
import semver from "semver";
import type { FactCertainty, PolicyFactProvenance, RegistrySnapshot, RepositoryConfig } from "../contracts/index.js";
import type { ProjectSnapshot } from "../facts/project-snapshot.js";
import type { ApplicabilityFacts } from "../runtime/applicability.js";

/**
 * Applicability facts for effective policy, derived only from the validated
 * shared fact document and repository configuration.
 *
 * Capabilities use a bounded vocabulary: a name the registry references is
 * present when a shared fact establishes it, absent only when the category
 * that would report it was searched completely, and otherwise unknown.
 * Unknown and conflicting facts are left out, so the dependent predicate is
 * unresolved rather than guessed.
 */

export const CAPABILITY_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  frameworks: ["angular", "express", "gatsby", "next", "preact", "react", "remix", "solid", "svelte", "vue"],
  build_tools: ["babel", "esbuild", "parcel", "rollup", "rspack", "swc", "tsup", "typescript", "vite", "webpack"],
  test_frameworks: ["cypress", "jest", "mocha", "playwright", "vitest"],
  package_managers: ["npm", "pnpm", "yarn"],
  composition: ["iframe", "import-map", "module-federation", "single-spa"],
};

export interface PolicyFacts {
  facts: Omit<ApplicabilityFacts, "portals" | "file">;
  capabilityCertainty: Record<string, FactCertainty>;
  provenance: PolicyFactProvenance;
}

export function policyFactsFor(snapshot: ProjectSnapshot | null, registry: RegistrySnapshot, config: RepositoryConfig | null): PolicyFacts {
  const shared = snapshot?.shared.status === "complete" ? snapshot.shared.document : null;
  const referenced = referencedNames(registry);
  const capabilities: Record<string, string | boolean> = {};
  const capabilityCertainty: Record<string, FactCertainty> = {};
  for (const name of referenced.capabilities) {
    const resolved: CapabilityResolution = shared === null ? { certainty: "unknown", value: undefined } : capability(shared, name);
    capabilityCertainty[name] = resolved.certainty;
    if (resolved.value !== undefined) capabilities[name] = resolved.value;
  }
  const dependencies: Record<string, string | false> = {};
  for (const name of referenced.dependencies) {
    const value = shared === null ? undefined : dependency(shared, name);
    if (value !== undefined) dependencies[name] = value;
  }
  const runtimes: Record<string, string> = {};
  for (const name of referenced.runtimes) {
    const fact = shared?.categories.runtime_requirements?.facts.find((candidate) => candidate.key === name);
    const range = fact !== undefined && established(fact) ? (fact.value as { range?: unknown }).range : undefined;
    if (typeof range === "string") runtimes[name] = range;
  }
  return {
    facts: {
      ...(shared === null ? {} : { capabilities, dependencies, runtimes }),
      ...(config?.applicationMetadata === undefined ? {} : { applicationMetadata: config.applicationMetadata }),
    },
    capabilityCertainty,
    provenance: {
      status: snapshot?.shared.status === "complete" ? "complete" : "incomplete",
      detectorRelease: snapshot?.shared.provenance?.detectorRelease ?? null,
      configurationDigest: snapshot?.shared.provenance?.configurationDigest ?? null,
      factDocumentDigest: snapshot?.shared.status === "complete" ? snapshot.shared.documentDigest : null,
      extensionStateDigest: snapshot?.extensions.digest ?? null,
    },
  };
}

function referencedNames(registry: RegistrySnapshot): { capabilities: string[]; dependencies: string[]; runtimes: string[] } {
  const applicability = [...registry.policies.flatMap((policy) => policy.controls.map((control) => control.applicability)), ...registry.guidance.map((entry) => entry.applicability)];
  const unique = (values: string[]) => [...new Set(values)].sort();
  return {
    capabilities: unique(applicability.flatMap((entry) => (entry.capabilities ?? []).map((item) => item.name))),
    dependencies: unique(applicability.flatMap((entry) => (entry.dependencies ?? []).map((item) => item.name))),
    runtimes: unique(applicability.flatMap((entry) => (entry.runtimes ?? []).map((item) => item.name))),
  };
}

/** A capability's certainty and, when established, its version, `true`, or `false` for established absence. */
interface CapabilityResolution {
  certainty: FactCertainty;
  value: string | boolean | undefined;
}

function capability(shared: FactDocument, name: string): CapabilityResolution {
  for (const [category, vocabulary] of Object.entries(CAPABILITY_VOCABULARY)) {
    const facts = (shared.categories[category]?.facts ?? []).filter((fact) => capabilityId(category, fact) === name);
    const present = facts.find(established);
    if (present !== undefined) {
      const version = category === "frameworks" ? frameworkVersion(shared, present) : undefined;
      return { certainty: present.state as FactCertainty, value: version ?? true };
    }
    if (facts.some((fact) => fact.state === "conflicting")) return { certainty: "conflicting", value: undefined };
    if (vocabulary.includes(name)) {
      const entry = shared.categories[category];
      const searched = entry !== undefined && entry.search.complete && entry.search.skipped.length === 0 && (entry.state === "absent" || entry.facts.length > 0);
      const bounded = category !== "composition";
      return searched && bounded ? { certainty: "observed", value: false } : { certainty: "unknown", value: undefined };
    }
  }
  return { certainty: "unknown", value: undefined };
}

function capabilityId(category: string, fact: DocumentFact): string | undefined {
  const value = fact.value;
  if (category === "frameworks") return typeof value === "object" && value !== null ? String((value as { id?: unknown }).id ?? "") : undefined;
  if (category === "package_managers") return typeof value === "string" ? value : undefined;
  if (category === "composition") return typeof value === "object" && value !== null ? String((value as { mechanism?: unknown }).mechanism ?? "") : undefined;
  return fact.key;
}

/** The resolved version of a framework's package, or its one declared specifier. */
function frameworkVersion(shared: FactDocument, fact: DocumentFact): string | undefined {
  const value = fact.value as { package?: unknown };
  const version = typeof value.package === "string" ? dependency(shared, value.package) : undefined;
  return typeof version === "string" ? version : undefined;
}

/** A resolved version, else one exact version or range declared everywhere, else absent after a complete search. */
function dependency(shared: FactDocument, name: string): string | false | undefined {
  const resolved = new Set((shared.categories.resolved_dependencies?.facts ?? []).filter(established).filter((fact) => (fact.value as { name?: unknown }).name === name).map((fact) => String((fact.value as { version?: unknown }).version)));
  if (resolved.size === 1) return [...resolved][0]!;
  if (resolved.size > 1) return undefined;
  const declared = (shared.categories.dependencies?.facts ?? []).filter((fact) => (fact.value as { name?: unknown }).name === name);
  if (declared.some((fact) => !established(fact))) return undefined;
  const specifiers = new Set(declared.map((fact) => String((fact.value as { specifier?: unknown }).specifier)));
  if (specifiers.size === 1) {
    const specifier = [...specifiers][0]!;
    return semver.valid(specifier) ?? (semver.validRange(specifier) === null ? undefined : specifier);
  }
  if (specifiers.size > 1) return undefined;
  const entry = shared.categories.dependencies;
  return entry !== undefined && entry.search.complete && entry.search.skipped.length === 0 ? false : undefined;
}

function established(fact: DocumentFact): boolean {
  return fact.state === "observed" || fact.state === "inferred";
}
