import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseContract, type Catalog } from "../contracts/index.js";
import { assembleEmbeddedRegistry } from "./assemble.js";
import { validateRegistryFiles } from "./command.js";
import { generateContributionLock, writeContributionLock } from "./lock.js";
import { materializeCatalogContributions } from "./materialize.js";
import type { NpmArtifactResolverOptions } from "./npm-artifact.js";
import { compileRegistrySnapshot } from "./snapshot.js";

export interface RegistryReleaseOptions {
  catalogPath: string;
  ownershipPath: string;
  lockPath: string;
  generatedRoot: string;
  resolver: NpmArtifactResolverOptions;
  webDoctorVersion: string;
  webDoctorCommit: string;
  catalogCommit: string;
}

export interface RegistryReleaseArtifacts {
  registryDigest: string;
  files: string[];
}

export async function buildRegistryReleaseArtifacts(
  options: RegistryReleaseOptions,
): Promise<RegistryReleaseArtifacts> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-release-build-"));
  const contributionsRoot = path.join(workspace, "contributions");
  try {
    const catalog = parseContract(
      "catalog",
      JSON.parse(await fs.readFile(options.catalogPath, "utf8")) as unknown,
    ) as Catalog;
    const metadata = await materializeCatalogContributions(catalog, contributionsRoot, options.resolver);
    const lock = generateContributionLock(catalog, metadata);
    await writeContributionLock(options.lockPath, lock);
    const report = await validateRegistryFiles({
      catalogPath: options.catalogPath,
      ownershipPath: options.ownershipPath,
      lockPath: options.lockPath,
      contributionsRoot,
    });
    if (!report.valid) {
      throw new Error(`Registry release validation failed:\n${report.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`);
    }
    const compiled = await compileRegistrySnapshot({
      catalog,
      lock,
      contributionsRoot,
      webDoctorVersion: options.webDoctorVersion,
      webDoctorCommit: options.webDoctorCommit,
      catalogCommit: options.catalogCommit,
    });
    const assembly = await assembleEmbeddedRegistry(compiled.snapshot, contributionsRoot, options.generatedRoot);
    return { registryDigest: compiled.digest, files: assembly.files };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

export async function verifyRegistryReleaseArtifacts(
  options: RegistryReleaseOptions,
): Promise<RegistryReleaseArtifacts> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-release-verify-"));
  const generatedLockPath = path.join(workspace, "registry.lock.json");
  const generatedRoot = path.join(workspace, "registry");
  try {
    const result = await buildRegistryReleaseArtifacts({
      ...options,
      lockPath: generatedLockPath,
      generatedRoot,
    });
    const differences = [
      ...await compareFiles(generatedLockPath, options.lockPath, "registry/registry.lock.json"),
      ...await compareTrees(generatedRoot, options.generatedRoot, "generated/registry"),
    ].sort();
    if (differences.length > 0) {
      throw new Error(`Release artifacts are stale or dirty:\n${differences.join("\n")}`);
    }
    return result;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function compareTrees(expectedRoot: string, actualRoot: string, displayRoot: string): Promise<string[]> {
  const expected = await readTree(expectedRoot);
  const actual = await readTree(actualRoot);
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  return paths.flatMap((relativePath) => {
    const expectedContents = expected.get(relativePath);
    const actualContents = actual.get(relativePath);
    const displayPath = `${displayRoot}/${relativePath}`;
    if (expectedContents === undefined) return [`unexpected ${displayPath}`];
    if (actualContents === undefined) return [`missing ${displayPath}`];
    return expectedContents.equals(actualContents) ? [] : [`changed ${displayPath}`];
  });
}

async function compareFiles(expectedPath: string, actualPath: string, displayPath: string): Promise<string[]> {
  try {
    const [expected, actual] = await Promise.all([fs.readFile(expectedPath), fs.readFile(actualPath)]);
    return expected.equals(actual) ? [] : [`changed ${displayPath}`];
  } catch (error) {
    if (isMissing(error)) return [`missing ${displayPath}`];
    throw error;
  }
}

async function readTree(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  try {
    await visit(root, "");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return files;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory === "" ? entry.name : path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) files.set(relativePath, await fs.readFile(absolutePath));
      else throw new Error(`Release artifact ${relativePath} is not a regular file`);
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}