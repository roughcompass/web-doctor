import type { Catalog, RegistryOwnership } from "../contracts/index.js";

export function ownershipCoverageIssues(
  catalog: Catalog,
  ownership: RegistryOwnership,
): string[] {
  const issues: string[] = [];

  for (const entry of catalog.entries) {
    const matches = ownership.owners.filter(
      (owner) =>
        owner.id === entry.owner &&
        owner.namespaces.some(
          (namespace) => entry.id === namespace || entry.id.startsWith(`${namespace}/`),
        ),
    );
    if (matches.length !== 1) {
      issues.push(`Contribution ${entry.id} must resolve to exactly one owning team`);
    }
  }

  for (const portal of catalog.portals) {
    const matches = ownership.owners.filter((owner) => owner.portals.includes(portal.id));
    if (matches.length !== 1) {
      issues.push(`Portal ${portal.id} must resolve to exactly one owning team`);
    }
  }

  return issues;
}