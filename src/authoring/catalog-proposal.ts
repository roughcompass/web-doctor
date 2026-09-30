import fs from "node:fs/promises";
import path from "node:path";
import pacote from "pacote";
import {
  canonicalJson,
  digestDocument,
  internalNpmSourceSchema,
  parseContract,
  sourceProvenanceSchema,
  type Catalog,
} from "../contracts/index.js";

export interface CatalogProposalOptions {
  catalogPath: string;
  outputPath: string;
  contributionId: string;
  packageName: string;
  version: string;
  repository: string;
  commit: string;
  registry: string;
  cache?: string;
  allowInsecureRegistry?: boolean;
}

export interface CatalogProposalResult {
  contributionId: string;
  packageName: string;
  version: string;
  integrity: string;
  outputPath: string;
  changed: boolean;
  catalogDigest: string;
  requiresPlatformReview: true;
}

export async function prepareCatalogProposal(options: CatalogProposalOptions): Promise<CatalogProposalResult> {
  if (path.resolve(options.catalogPath) === path.resolve(options.outputPath)) {
    throw new Error("Catalog proposals must use a separate output path for pull-request review");
  }
  const registry = new URL(options.registry);
  if (registry.protocol !== "https:" && !(options.allowInsecureRegistry === true && registry.protocol === "http:")) {
    throw new Error("Internal npm registry must use HTTPS");
  }
  const catalog = parseContract(
    "catalog",
    JSON.parse(await fs.readFile(options.catalogPath, "utf8")) as unknown,
  ) as Catalog;
  const index = catalog.entries.findIndex((entry) => entry.id === options.contributionId);
  if (index < 0) throw new Error(`Catalog contribution ${options.contributionId} does not exist`);
  const provenance = sourceProvenanceSchema.parse({ repository: options.repository, commit: options.commit });
  const metadata = await pacote.manifest(`${options.packageName}@${options.version}`, {
    registry: registry.href,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
  });
  const integrity = metadata._integrity;
  if (typeof integrity !== "string") throw new Error("Published package metadata does not include registry integrity");
  const source = internalNpmSourceSchema.parse({
    schema: "web-doctor.npm-source",
    schemaVersion: 1,
    registry: "internal",
    packageName: options.packageName,
    version: options.version,
    integrity,
    provenance,
  });
  const entries = catalog.entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, source } : entry);
  const candidate = parseContract("catalog", { ...catalog, entries }) as Catalog;
  const canonical = `${canonicalJson(candidate)}\n`;
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, canonical, "utf8");
  return {
    contributionId: options.contributionId,
    packageName: source.packageName,
    version: source.version,
    integrity: source.integrity,
    outputPath: options.outputPath,
    changed: canonicalJson(candidate) !== canonicalJson(catalog),
    catalogDigest: digestDocument(candidate).digest,
    requiresPlatformReview: true,
  };
}