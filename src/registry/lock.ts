import fs from "node:fs/promises";
import {
  canonicalJson,
  contributionLockSchema,
  digestDocument,
  type Catalog,
  type CatalogEntry,
  type ContributionLock,
} from "../contracts/index.js";

export interface ContributionManifestMetadata {
  digest: string;
  contractVersion: number;
}

export function generateContributionLock(
  catalog: Catalog,
  manifests: ReadonlyMap<string, ContributionManifestMetadata>,
): ContributionLock {
  const normalizedCatalog = normalizeCatalog(catalog);
  const entries = new Map(normalizedCatalog.entries.map((entry) => [entry.id, entry]));
  const contributions = normalizedCatalog.entries.map((entry) => {
    const manifest = manifests.get(entry.id);
    if (manifest === undefined) throw new Error(`Missing manifest metadata for ${entry.id}`);
    return {
      ...entry,
      manifestDigest: manifest.digest,
      contractVersion: manifest.contractVersion,
      resolvedDependencies: resolveDependencies(entry.id, entries),
    };
  });

  return contributionLockSchema.parse({
    schema: "web-doctor.contribution-lock",
    schemaVersion: 1,
    catalogDigest: digestDocument(normalizedCatalog).digest,
    contributions,
  });
}

export async function writeContributionLock(
  outputPath: string,
  lock: ContributionLock,
): Promise<void> {
  await fs.writeFile(outputPath, `${canonicalJson(contributionLockSchema.parse(lock))}\n`, "utf8");
}

function normalizeCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    portals: [...catalog.portals].sort((left, right) => left.id.localeCompare(right.id)),
    entries: catalog.entries
      .map((entry) => ({
        ...entry,
        portals: [...entry.portals].sort(),
        layers: [...entry.layers].sort(),
        dependencies: [...entry.dependencies].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function resolveDependencies(
  contributionId: string,
  entries: ReadonlyMap<string, CatalogEntry>,
): string[] {
  const resolved = new Set<string>();

  function visit(currentId: string, trail: readonly string[]): void {
    const entry = entries.get(currentId);
    if (entry === undefined) throw new Error(`Missing contribution ${currentId}`);
    for (const dependencyId of entry.dependencies) {
      if (trail.includes(dependencyId)) {
        throw new Error(`Contribution dependency cycle: ${[...trail, dependencyId].join(" -> ")}`);
      }
      resolved.add(dependencyId);
      visit(dependencyId, [...trail, dependencyId]);
    }
  }

  visit(contributionId, [contributionId]);
  return [...resolved].sort();
}