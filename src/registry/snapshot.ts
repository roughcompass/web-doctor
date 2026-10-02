import fs from "node:fs/promises";
import path from "node:path";
import {
  digestDocument,
  parseContract,
  parsePolicyPack,
  registrySnapshotSchema,
  type Catalog,
  type Contribution,
  type ContributionLock,
  type GuidanceEntry,
  type PolicyPack,
  type ProviderManifest,
  type RegistrySnapshot,
} from "../contracts/index.js";
import { assertValidGuidance } from "../guidance/validation.js";

export interface RegistrySnapshotCompilerOptions {
  catalog: Catalog;
  lock: ContributionLock;
  contributionsRoot: string;
  webDoctorVersion: string;
  webDoctorCommit: string;
  catalogCommit: string;
}

export interface CompiledRegistrySnapshot {
  snapshot: RegistrySnapshot;
  canonical: string;
  digest: string;
}

export async function compileRegistrySnapshot(
  options: RegistrySnapshotCompilerOptions,
): Promise<CompiledRegistrySnapshot> {
  const catalogById = new Map(options.catalog.entries.map((entry) => [entry.id, entry]));
  const contributions = [...options.lock.contributions].sort((left, right) => left.id.localeCompare(right.id));
  const policies: PolicyPack[] = [];
  const providers: ProviderManifest[] = [];
  const guidance: GuidanceEntry[] = [];

  for (const locked of contributions) {
    const catalogEntry = catalogById.get(locked.id);
    if (catalogEntry === undefined) throw new Error(`Lock contribution ${locked.id} is absent from the catalog`);
    const root = path.resolve(options.contributionsRoot, ...locked.id.split("/"));
    const manifest = parseContract(
      "contribution",
      JSON.parse(await fs.readFile(path.join(root, ...locked.manifestPath.split("/")), "utf8")) as unknown,
    ) as Contribution;
    if (digestDocument(manifest).digest !== locked.manifestDigest) {
      throw new Error(`Manifest digest does not match lock for ${locked.id}`);
    }

    for (const document of manifest.documents) {
      const input = JSON.parse(await fs.readFile(path.join(root, ...document.path.split("/")), "utf8")) as unknown;
      if (document.kind === "policy") policies.push(parsePolicyPack(input));
      else if (document.kind === "provider") providers.push(parseContract("providerManifest", input) as ProviderManifest);
      else guidance.push(parseContract("guidanceEntry", input) as GuidanceEntry);
    }
  }

  assertValidGuidance({ guidance, policies });
  const snapshot = registrySnapshotSchema.parse({
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 2,
    webDoctorVersion: options.webDoctorVersion,
    webDoctorCommit: options.webDoctorCommit,
    catalogCommit: options.catalogCommit,
    catalogDigest: options.lock.catalogDigest,
    portals: [...options.catalog.portals].sort((left, right) => left.id.localeCompare(right.id)),
    contributions: contributions.map((entry) => ({
      id: entry.id,
      type: entry.type,
      owner: entry.owner,
      source: entry.source,
      manifestPath: entry.manifestPath,
      manifestDigest: entry.manifestDigest,
      lifecycle: entry.lifecycle,
      compatibility: entry.compatibility,
      portals: [...entry.portals].sort(),
      layers: [...entry.layers].sort(),
    })),
    policies: sortDocuments(policies),
    providers: sortDocuments(providers),
    guidance: sortDocuments(guidance),
  });
  return { snapshot, ...digestDocument(snapshot) };
}

function sortDocuments<Document extends { id: string; version: string }>(documents: readonly Document[]): Document[] {
  return [...documents].sort((left, right) =>
    `${left.id}\0${left.version}`.localeCompare(`${right.id}\0${right.version}`),
  );
}