import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  digestDocument,
  parseContract,
  type Catalog,
  type Contribution,
  type ContributionLock,
  type RegistryOwnership,
} from "../contracts/index.js";

export interface ContributionProvenance {
  id: string;
  type: Catalog["entries"][number]["type"];
  owner: { id: string; name: string; codeownersTeam: string };
  package: { name: string; version: string; integrity: string };
  source: { repository: string; commit: string };
  capabilities: string[];
  compatibility: Catalog["entries"][number]["compatibility"];
  lifecycle: Catalog["entries"][number]["lifecycle"];
  layers: string[];
  portals: string[];
  manifestDigest: string;
}

export interface RegistryProvenance {
  digest: string;
  contributions: ContributionProvenance[];
}

export interface RegistryProvenanceChange {
  id: string;
  kind: "added" | "removed" | "updated";
  before?: ContributionProvenance;
  after?: ContributionProvenance;
}

export async function buildRegistryProvenance(
  catalog: Catalog,
  ownership: RegistryOwnership,
  lock: ContributionLock,
  contributionsRoot: string,
): Promise<RegistryProvenance> {
  const owners = new Map(ownership.owners.map((owner) => [owner.id, owner]));
  const locked = new Map(lock.contributions.map((contribution) => [contribution.id, contribution]));
  const contributions: ContributionProvenance[] = [];

  for (const entry of catalog.entries) {
    const owner = owners.get(entry.owner);
    const lockEntry = locked.get(entry.id);
    if (owner === undefined || lockEntry === undefined) throw new Error(`Missing owner or lock provenance for ${entry.id}`);
    const root = path.resolve(contributionsRoot, ...entry.id.split("/"));
    const manifest = parseContract(
      "contribution",
      JSON.parse(await fs.readFile(path.join(root, ...entry.manifestPath.split("/")), "utf8")) as unknown,
    ) as Contribution;
    const capabilities = new Set<string>();
    for (const document of manifest.documents.filter((document) => document.kind === "provider")) {
      const provider = parseContract(
        "providerManifest",
        JSON.parse(await fs.readFile(path.join(root, ...document.path.split("/")), "utf8")) as unknown,
      ) as { capabilities: string[] };
      for (const capability of provider.capabilities) capabilities.add(capability);
    }
    contributions.push({
      id: entry.id,
      type: entry.type,
      owner: { id: owner.id, name: owner.name, codeownersTeam: owner.codeownersTeam },
      package: {
        name: entry.source.packageName,
        version: entry.source.version,
        integrity: entry.source.integrity,
      },
      source: entry.source.provenance,
      capabilities: [...capabilities].sort(),
      compatibility: entry.compatibility,
      lifecycle: entry.lifecycle,
      layers: [...entry.layers].sort(),
      portals: [...entry.portals].sort(),
      manifestDigest: lockEntry.manifestDigest,
    });
  }
  contributions.sort((left, right) => left.id.localeCompare(right.id));
  return { digest: digestDocument(contributions).digest, contributions };
}

export function compareRegistryProvenance(
  before: RegistryProvenance,
  after: RegistryProvenance,
): RegistryProvenanceChange[] {
  const beforeById = new Map(before.contributions.map((contribution) => [contribution.id, contribution]));
  const afterById = new Map(after.contributions.map((contribution) => [contribution.id, contribution]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();

  return ids.flatMap((id): RegistryProvenanceChange[] => {
    const previous = beforeById.get(id);
    const current = afterById.get(id);
    if (previous === undefined && current !== undefined) return [{ id, kind: "added", after: current }];
    if (previous !== undefined && current === undefined) return [{ id, kind: "removed", before: previous }];
    if (previous !== undefined && current !== undefined && canonicalJson(previous) !== canonicalJson(current)) {
      return [{ id, kind: "updated", before: previous, after: current }];
    }
    return [];
  });
}