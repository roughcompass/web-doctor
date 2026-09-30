import { intersects, satisfies, validRange } from "semver";
import type { Catalog, CatalogEntry, RegistryOwnership } from "../contracts/index.js";
import { WEB_DOCTOR_VERSION } from "../version.js";
import { ownershipCoverageIssues } from "./ownership.js";

export interface CatalogValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface CatalogValidationResult {
  valid: boolean;
  issues: CatalogValidationIssue[];
}

export function validateCatalog(
  catalog: Catalog,
  ownership: RegistryOwnership,
  webDoctorVersion = WEB_DOCTOR_VERSION,
): CatalogValidationResult {
  const issues: CatalogValidationIssue[] = [];
  const entriesById = groupBy(catalog.entries, (entry) => entry.id);
  const portalsById = groupBy(catalog.portals, (portal) => portal.id);

  for (const [id, entries] of entriesById) {
    if (entries.length > 1) add(issues, "duplicate_contribution", `entries.${id}`, `Contribution ${id} is declared ${entries.length} times`);
  }
  for (const [id, portals] of portalsById) {
    if (portals.length > 1) add(issues, "duplicate_portal", `portals.${id}`, `Portal ${id} is declared ${portals.length} times`);
  }

  const entries = new Map(
    [...entriesById.entries()].filter(([, matches]) => matches.length === 1).map(([id, matches]) => [id, matches[0]!] as const),
  );
  const portals = new Map(
    [...portalsById.entries()].filter(([, matches]) => matches.length === 1).map(([id, matches]) => [id, matches[0]!] as const),
  );

  for (const message of ownershipCoverageIssues(catalog, ownership)) {
    add(issues, "ownership", "ownership", message);
  }

  for (const entry of catalog.entries) {
    validateCompatibility(entry, webDoctorVersion, entries, issues);
    for (const dependencyId of entry.dependencies) {
      if (!entries.has(dependencyId)) {
        add(issues, "missing_dependency", `entries.${entry.id}.dependencies`, `Contribution ${entry.id} depends on missing contribution ${dependencyId}`);
      }
    }
    for (const portalId of entry.portals) {
      const portal = portals.get(portalId);
      if (portal === undefined) {
        add(issues, "unknown_portal", `entries.${entry.id}.portals`, `Contribution ${entry.id} references unknown portal ${portalId}`);
      } else if (entry.lifecycle === "active" && portal.lifecycle !== "active") {
        add(issues, "inactive_portal", `entries.${entry.id}.portals`, `Active contribution ${entry.id} references ${portal.lifecycle} portal ${portalId}`);
      }
    }
    validateReplacement(entry, entries, issues);
  }

  for (const portal of catalog.portals) {
    if (portal.replacement === undefined) continue;
    const replacement = portals.get(portal.replacement);
    if (replacement === undefined || replacement.lifecycle !== "active") {
      add(issues, "invalid_portal_replacement", `portals.${portal.id}.replacement`, `Portal ${portal.id} replacement ${portal.replacement} must be active`);
    }
  }

  for (const cycle of findDependencyCycles(entries)) {
    add(issues, "dependency_cycle", "entries", `Contribution dependency cycle: ${cycle.join(" -> ")}`);
  }

  issues.sort((left, right) =>
    `${left.code}\0${left.path}\0${left.message}`.localeCompare(`${right.code}\0${right.path}\0${right.message}`),
  );
  return { valid: issues.length === 0, issues };
}

function validateCompatibility(
  entry: CatalogEntry,
  webDoctorVersion: string,
  entries: ReadonlyMap<string, CatalogEntry>,
  issues: CatalogValidationIssue[],
): void {
  const range = validRange(entry.compatibility.webDoctor);
  if (range === null) {
    add(issues, "invalid_compatibility", `entries.${entry.id}.compatibility.webDoctor`, `Contribution ${entry.id} has invalid Web Doctor range ${entry.compatibility.webDoctor}`);
    return;
  }
  if (!satisfies(webDoctorVersion, range)) {
    add(issues, "incompatible_web_doctor", `entries.${entry.id}.compatibility.webDoctor`, `Contribution ${entry.id} does not support Web Doctor ${webDoctorVersion}`);
  }

  for (const dependencyId of entry.dependencies) {
    const dependency = entries.get(dependencyId);
    if (dependency === undefined) continue;
    const dependencyRange = validRange(dependency.compatibility.webDoctor);
    if (dependencyRange !== null && !intersects(range, dependencyRange)) {
      add(issues, "incompatible_dependency", `entries.${entry.id}.dependencies`, `Contribution ${entry.id} and dependency ${dependencyId} have disjoint Web Doctor ranges`);
    }
  }
}

function validateReplacement(
  entry: CatalogEntry,
  entries: ReadonlyMap<string, CatalogEntry>,
  issues: CatalogValidationIssue[],
): void {
  if (entry.lifecycle !== "active" && entry.migration === undefined) {
    add(issues, "missing_migration", `entries.${entry.id}.migration`, `Contribution ${entry.id} requires migration guidance when ${entry.lifecycle}`);
  }
  if (entry.replacement === undefined) return;
  const replacement = entries.get(entry.replacement);
  if (replacement === undefined || replacement.lifecycle !== "active") {
    add(issues, "invalid_replacement", `entries.${entry.id}.replacement`, `Contribution ${entry.id} replacement ${entry.replacement} must be active`);
    return;
  }
  if (replacement.type !== entry.type) {
    add(issues, "replacement_type", `entries.${entry.id}.replacement`, `Replacement ${replacement.id} must have type ${entry.type}`);
  }
  const droppedLayers = entry.layers.filter((layer) => !replacement.layers.includes(layer));
  if (droppedLayers.length > 0) {
    add(issues, "cross_layer_weakening", `entries.${entry.id}.replacement`, `Replacement ${replacement.id} drops layers ${droppedLayers.join(", ")} from ${entry.id}`);
  }
}

function findDependencyCycles(entries: ReadonlyMap<string, CatalogEntry>): string[][] {
  const cycles = new Map<string, string[]>();

  function visit(id: string, trail: readonly string[]): void {
    const entry = entries.get(id);
    if (entry === undefined) return;
    for (const dependencyId of entry.dependencies) {
      const start = trail.indexOf(dependencyId);
      if (start >= 0) {
        const cycle = [...trail.slice(start), dependencyId];
        const key = [...new Set(cycle)].sort().join("\0");
        cycles.set(key, cycle);
      } else {
        visit(dependencyId, [...trail, dependencyId]);
      }
    }
  }

  for (const id of [...entries.keys()].sort()) visit(id, [id]);
  return [...cycles.values()].sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function groupBy<Value>(values: readonly Value[], keyOf: (value: Value) => string): Map<string, Value[]> {
  const groups = new Map<string, Value[]>();
  for (const value of values) groups.set(keyOf(value), [...(groups.get(keyOf(value)) ?? []), value]);
  return groups;
}

function add(issues: CatalogValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}