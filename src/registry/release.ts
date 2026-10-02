import crypto from "node:crypto";
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

/**
 * Builds the lock and embedded registry from the catalog. Everything is
 * staged and validated first; the committed lock and generated tree change
 * only after the whole build succeeds, each by an atomic rename, so a
 * rejected contribution never leaves a partial or unvalidated release behind.
 */
export async function buildRegistryReleaseArtifacts(
  options: RegistryReleaseOptions,
): Promise<RegistryReleaseArtifacts> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-release-build-"));
  const contributionsRoot = path.join(workspace, "contributions");
  const stagedLock = path.join(workspace, "registry.lock.json");
  try {
    const catalog = parseContract(
      "catalog",
      JSON.parse(await fs.readFile(options.catalogPath, "utf8")) as unknown,
    ) as Catalog;
    const metadata = await materializeCatalogContributions(catalog, contributionsRoot, options.resolver);
    const lock = generateContributionLock(catalog, metadata);
    await writeContributionLock(stagedLock, lock);
    const report = await validateRegistryFiles({
      catalogPath: options.catalogPath,
      ownershipPath: options.ownershipPath,
      lockPath: stagedLock,
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
    // Stage beside the targets so each commit is a same-filesystem rename.
    const suffix = `.staging-${crypto.randomUUID()}`;
    const stagedRoot = `${options.generatedRoot}${suffix}`;
    try {
      const assembly = await assembleEmbeddedRegistry(compiled.snapshot, contributionsRoot, stagedRoot);
      await fs.mkdir(path.dirname(options.lockPath), { recursive: true });
      await fs.copyFile(stagedLock, `${options.lockPath}${suffix}`);
      await replaceDirectory(stagedRoot, options.generatedRoot);
      await fs.rename(`${options.lockPath}${suffix}`, options.lockPath);
      return { registryDigest: compiled.digest, files: assembly.files };
    } finally {
      await fs.rm(stagedRoot, { recursive: true, force: true });
      await fs.rm(`${options.lockPath}${suffix}`, { force: true });
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

/** Swaps a staged directory into place, keeping the previous one until the swap succeeds. */
async function replaceDirectory(staged: string, target: string): Promise<void> {
  const previous = `${target}.previous-${crypto.randomUUID()}`;
  let moved = false;
  try {
    await fs.rename(target, previous);
    moved = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(staged, target);
  } catch (error) {
    if (moved) await fs.rename(previous, target);
    throw error;
  }
  if (moved) await fs.rm(previous, { recursive: true, force: true });
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