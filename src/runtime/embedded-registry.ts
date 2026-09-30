import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  digestDocument,
  parseContract,
  type Contribution,
  type ContributionFixture,
  type ContractKind,
  type GuidanceEntry,
  type PolicyPack,
  type ProviderManifest,
  type RegistrySnapshot,
} from "../contracts/index.js";

const DOCUMENT_KINDS = {
  policy: "policyPack",
  provider: "providerManifest",
  guidance: "guidanceEntry",
} as const satisfies Record<Contribution["documents"][number]["kind"], ContractKind>;

export interface EmbeddedRegistryOptions {
  root?: string;
}

export interface LoadedEmbeddedRegistry {
  root: string;
  snapshot: RegistrySnapshot;
  digest: string;
  files: string[];
}

export async function loadEmbeddedRegistry(options: EmbeddedRegistryOptions = {}): Promise<LoadedEmbeddedRegistry> {
  const defaultRoot = new URL("../../generated/registry/", import.meta.url);
  const root = await fs.realpath(options.root ?? defaultRoot);
  const expectedFiles = new Set(["snapshot.json"]);
  const snapshot = parseContract(
    "registrySnapshot",
    JSON.parse((await readFile(root, "snapshot.json")).toString("utf8")) as unknown,
  ) as RegistrySnapshot;
  const policies: PolicyPack[] = [];
  const providers: ProviderManifest[] = [];
  const guidance: GuidanceEntry[] = [];

  for (const reference of snapshot.contributions) {
    const prefix = path.posix.join("contributions", reference.id);
    const manifestPath = path.posix.join(prefix, reference.manifestPath);
    expectedFiles.add(manifestPath);
    const manifest = parseContract(
      "contribution",
      JSON.parse((await readFile(root, manifestPath)).toString("utf8")) as unknown,
    ) as Contribution;
    if (manifest.id !== reference.id) throw new Error(`Embedded manifest id mismatch for ${reference.id}`);
    if (digestDocument(manifest).digest !== reference.manifestDigest) throw new Error(`Embedded manifest digest mismatch for ${reference.id}`);
    if (manifest.type !== reference.type) throw new Error(`Embedded contribution type mismatch for ${reference.id}`);
    if (canonicalJson(manifest.compatibility) !== canonicalJson(reference.compatibility)) throw new Error(`Embedded compatibility mismatch for ${reference.id}`);
    if (canonicalJson([...manifest.portals].sort()) !== canonicalJson([...reference.portals].sort())) throw new Error(`Embedded portals mismatch for ${reference.id}`);
    if (canonicalJson([...manifest.layers].sort()) !== canonicalJson([...reference.layers].sort())) throw new Error(`Embedded layers mismatch for ${reference.id}`);
    if (canonicalJson(manifest.provenance) !== canonicalJson(reference.source.provenance)) throw new Error(`Embedded provenance mismatch for ${reference.id}`);

    for (const document of manifest.documents) {
      const documentPath = path.posix.join(prefix, document.path);
      expectedFiles.add(documentPath);
      const parsed = parseContract(
        DOCUMENT_KINDS[document.kind],
        JSON.parse((await readFile(root, documentPath)).toString("utf8")) as unknown,
      );
      if (document.kind === "policy") policies.push(parsed as PolicyPack);
      else if (document.kind === "provider") providers.push(parsed as ProviderManifest);
      else guidance.push(parsed as GuidanceEntry);
    }
    for (const fixturePath of manifest.fixtures) {
      const embeddedFixturePath = path.posix.join(prefix, fixturePath);
      expectedFiles.add(embeddedFixturePath);
      const fixture = parseContract(
        "contributionFixture",
        JSON.parse((await readFile(root, embeddedFixturePath)).toString("utf8")) as unknown,
      ) as ContributionFixture;
      const inputPath = path.posix.join(prefix, fixture.input);
      expectedFiles.add(inputPath);
      let accepted = true;
      try {
        parseContract(fixture.contract, JSON.parse((await readFile(root, inputPath)).toString("utf8")) as unknown);
      } catch {
        accepted = false;
      }
      if ((fixture.expected === "accept") !== accepted) throw new Error(`Embedded fixture ${fixture.id} expectation mismatch`);
    }
    for (const artifact of manifest.runtimeArtifacts) {
      const artifactPath = path.posix.join(prefix, artifact.path);
      expectedFiles.add(artifactPath);
      const digest = crypto.createHash("sha256").update(await readFile(root, artifactPath)).digest("hex");
      if (digest !== artifact.digest) throw new Error(`Embedded runtime artifact digest mismatch for ${reference.id}:${artifact.path}`);
    }
  }

  assertDocuments("policies", policies, snapshot.policies);
  assertDocuments("providers", providers, snapshot.providers);
  assertDocuments("guidance", guidance, snapshot.guidance);
  const files = await listFiles(root);
  const unexpected = files.filter((file) => !expectedFiles.has(file));
  const missing = [...expectedFiles].filter((file) => !files.includes(file));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`Embedded registry file set mismatch: ${[
      ...missing.map((file) => `missing ${file}`),
      ...unexpected.map((file) => `unexpected ${file}`),
    ].sort().join(", ")}`);
  }
  return { root, snapshot, digest: digestDocument(snapshot).digest, files };
}

function assertDocuments<Document extends { id: string; version: string }>(
  name: string,
  actual: readonly Document[],
  expected: readonly Document[],
): void {
  const sort = (documents: readonly Document[]) => [...documents].sort((left, right) => `${left.id}\0${left.version}`.localeCompare(`${right.id}\0${right.version}`));
  if (canonicalJson(sort(actual)) !== canonicalJson(sort(expected))) throw new Error(`Embedded snapshot ${name} do not match contribution documents`);
}

async function readFile(root: string, relativePath: string): Promise<Buffer> {
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const realCandidate = await fs.realpath(candidate);
  const relative = path.relative(root, realCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Embedded path ${relativePath} escapes registry root`);
  }
  const stat = await fs.stat(realCandidate);
  if (!stat.isFile()) throw new Error(`Embedded path ${relativePath} is not a regular file`);
  return fs.readFile(realCandidate);
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await visit(root, "");
  return files.sort();

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory === "" ? entry.name : path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`Embedded path ${relativePath} is not a regular file`);
    }
  }
}