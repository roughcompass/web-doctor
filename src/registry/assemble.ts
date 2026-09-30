import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  digestDocument,
  parseContract,
  type Contribution,
  type ContributionFixture,
  type RegistrySnapshot,
} from "../contracts/index.js";

export interface EmbeddedRegistryAssembly {
  outputRoot: string;
  files: string[];
}

export async function assembleEmbeddedRegistry(
  snapshotInput: unknown,
  contributionsRoot: string,
  outputRoot: string,
): Promise<EmbeddedRegistryAssembly> {
  const snapshot = parseContract("registrySnapshot", snapshotInput) as RegistrySnapshot;
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });
  const files: string[] = [];

  await write("snapshot.json", Buffer.from(`${canonicalJson(snapshot)}\n`, "utf8"));
  for (const reference of snapshot.contributions) {
    const sourceRoot = await fs.realpath(path.resolve(contributionsRoot, ...reference.id.split("/")));
    const manifestContents = await readDeclaredFile(sourceRoot, reference.manifestPath);
    const manifest = parseContract("contribution", JSON.parse(manifestContents.toString("utf8")) as unknown) as Contribution;
    if (manifest.id !== reference.id || digestDocument(manifest).digest !== reference.manifestDigest) {
      throw new Error(`Contribution manifest changed after validation for ${reference.id}`);
    }
    const declaredPaths = [
      reference.manifestPath,
      ...manifest.documents.map((document) => document.path),
      ...manifest.fixtures,
      ...await fixtureInputs(sourceRoot, manifest),
      ...manifest.runtimeArtifacts.map((artifact) => artifact.path),
    ];

    for (const declaredPath of [...new Set(declaredPaths)].sort()) {
      const contents = declaredPath === reference.manifestPath
        ? manifestContents
        : await readDeclaredFile(sourceRoot, declaredPath);
      const runtime = manifest.runtimeArtifacts.find((artifact) => artifact.path === declaredPath);
      if (runtime !== undefined) {
        const digest = crypto.createHash("sha256").update(contents).digest("hex");
        if (digest !== runtime.digest) throw new Error(`Runtime artifact changed after validation for ${reference.id}`);
      }
      await write(path.posix.join("contributions", reference.id, declaredPath), contents);
    }
  }

  files.sort();
  return { outputRoot, files };

  async function write(relativePath: string, contents: Buffer): Promise<void> {
    const destination = path.resolve(outputRoot, ...relativePath.split("/"));
    const relative = path.relative(outputRoot, destination);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Embedded path ${relativePath} escapes output root`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
    files.push(relativePath);
  }
}

async function fixtureInputs(root: string, manifest: Contribution): Promise<string[]> {
  const inputs: string[] = [];
  for (const fixturePath of manifest.fixtures) {
    const fixture = parseContract(
      "contributionFixture",
      JSON.parse((await readDeclaredFile(root, fixturePath)).toString("utf8")) as unknown,
    ) as ContributionFixture;
    inputs.push(fixture.input);
  }
  return inputs;
}

async function readDeclaredFile(root: string, packagePath: string): Promise<Buffer> {
  const candidate = path.resolve(root, ...packagePath.split("/"));
  const realCandidate = await fs.realpath(candidate);
  const relative = path.relative(root, realCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Package path ${packagePath} escapes contribution root`);
  }
  const stat = await fs.stat(realCandidate);
  if (!stat.isFile()) throw new Error(`Package path ${packagePath} is not a regular file`);
  return fs.readFile(realCandidate);
}