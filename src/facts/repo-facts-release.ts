import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import ssri from "ssri";
import {
  canonicalJson,
  parseContract,
  repoFactsReleaseSchema,
  type RepoFactsRelease,
} from "../contracts/index.js";

export const REPO_FACTS_SCOPE = "@repo-facts";
export const REPO_FACTS_BUNDLE = "@repo-facts/bundle";
export const REPO_FACTS_CONTRACT = "@repo-facts/contract";

export interface RecordRepoFactsOptions {
  /** The Web Doctor package root holding package.json, its lockfile, and node_modules. */
  root: string;
}

export interface InstalledRepoFactsOptions {
  /** A module location that resolves @repo-facts/bundle the way Web Doctor does. Defaults to this module. */
  resolveFrom?: string;
}

export type InstalledRepoFactsState =
  | { status: "verified"; release: string; commit: string }
  | { status: "invalid"; problems: string[] };

interface LockEntry {
  version?: unknown;
  integrity?: unknown;
  resolved?: unknown;
  link?: unknown;
  name?: unknown;
}

/**
 * The lockfile npm uses for a root: the published `npm-shrinkwrap.json` when
 * present, which npm prefers, otherwise `package-lock.json`.
 */
export async function lockfileOf(root: string): Promise<"npm-shrinkwrap.json" | "package-lock.json"> {
  try {
    await fs.access(path.join(root, "npm-shrinkwrap.json"));
    return "npm-shrinkwrap.json";
  } catch {
    return "package-lock.json";
  }
}

/**
 * Records the pinned repo-facts release as build metadata: every lockstep
 * package's exact version, registry integrity from the lockfile, source
 * commit, and a digest of its installed files. Refuses ranges, mixed
 * versions, aliases, links, recorded registry URLs, and missing integrity.
 */
export async function recordRepoFactsRelease(options: RecordRepoFactsOptions): Promise<RepoFactsRelease> {
  const root = path.resolve(options.root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const lockfile = await lockfileOf(root);
  const lock = JSON.parse(await fs.readFile(path.join(root, lockfile), "utf8")) as { packages?: Record<string, LockEntry> };
  const problems: string[] = [];

  const pinned = [REPO_FACTS_BUNDLE, REPO_FACTS_CONTRACT].map((name) => {
    const specifier = manifest.dependencies?.[name];
    if (specifier === undefined) problems.push(`${name} is not a dependency`);
    else if (semver.valid(specifier) !== specifier) problems.push(`${name} must be pinned to an exact version, not ${specifier}`);
    return specifier;
  });
  if (pinned[0] !== undefined && pinned[1] !== undefined && pinned[0] !== pinned[1]) {
    problems.push(`${REPO_FACTS_BUNDLE}@${pinned[0]} and ${REPO_FACTS_CONTRACT}@${pinned[1]} are different releases`);
  }
  const release = pinned[0] ?? "";

  const entries = Object.entries(lock.packages ?? {})
    .filter(([key]) => /(^|\/)node_modules\/@repo-facts\/[^/]+$/.test(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const integrities = new Map<string, string>();
  for (const [key, entry] of entries) {
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (entry.link === true) problems.push(`${key} is a link, not an installed package`);
    if (entry.name !== undefined && entry.name !== name) problems.push(`${key} is an alias for ${String(entry.name)}`);
    if (entry.version !== release) problems.push(`${key} is ${String(entry.version)}, not the pinned release ${release}`);
    if (entry.resolved !== undefined) problems.push(`${key} records a registry URL; installs must resolve through the scope mapping`);
    const integrity = typeof entry.integrity === "string" ? ssri.parse(entry.integrity, { strict: true }) : null;
    if (integrity === null || !Object.hasOwn(integrity, "sha512")) problems.push(`${key} has no SHA-512 integrity`);
    else if (key !== `node_modules/${name}`) problems.push(`${key} is a nested copy of ${name}`);
    else integrities.set(name, String(entry.integrity));
  }
  for (const name of [REPO_FACTS_BUNDLE, REPO_FACTS_CONTRACT]) {
    if (!entries.some(([key]) => key === `node_modules/${name}`)) problems.push(`${name} is missing from ${lockfile}`);
  }
  if (problems.length > 0) throw new Error(`The pinned repo-facts release cannot be recorded:\n${problems.join("\n")}`);

  const packages = [];
  for (const [name, integrity] of [...integrities.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const installed = await describeInstalledPackage(path.join(root, "node_modules", ...name.split("/")), name);
    if (installed.version !== release) problems.push(`Installed ${name} is ${installed.version}, not ${release}`);
    packages.push({ name, version: installed.version, integrity, commit: installed.commit, contentDigest: installed.contentDigest });
  }
  const commits = [...new Set(packages.map((entry) => entry.commit))];
  if (commits.length !== 1) problems.push(`repo-facts packages were built from different commits: ${commits.join(", ")}`);
  if (problems.length > 0) throw new Error(`The pinned repo-facts release cannot be recorded:\n${problems.join("\n")}`);

  return repoFactsReleaseSchema.parse({
    schema: "web-doctor.repo-facts-release",
    schemaVersion: 1,
    release,
    commit: commits[0],
    packages,
  });
}

export async function writeRepoFactsRelease(outputPath: string, release: RepoFactsRelease): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${canonicalJson(release)}\n`, "utf8");
}

/** Loads the build metadata recorded for this package. */
export async function loadRepoFactsRelease(metadataPath?: string): Promise<RepoFactsRelease> {
  const location = metadataPath ?? fileURLToPath(new URL("../../generated/repo-facts.json", import.meta.url));
  return parseContract("repoFactsRelease", JSON.parse(await fs.readFile(location, "utf8")) as unknown) as RepoFactsRelease;
}

/**
 * Verifies that the repo-facts packages Web Doctor actually resolves are the
 * ones recorded at build: same versions, source commit, and installed bytes.
 */
export async function verifyInstalledRepoFacts(
  release: RepoFactsRelease,
  options: InstalledRepoFactsOptions = {},
): Promise<InstalledRepoFactsState> {
  const problems: string[] = [];
  let bundleEntry: string;
  try {
    bundleEntry = createRequire(options.resolveFrom ?? import.meta.url).resolve(REPO_FACTS_BUNDLE);
  } catch (error) {
    return { status: "invalid", problems: [`${REPO_FACTS_BUNDLE} is not installed: ${messageOf(error)}`] };
  }
  for (const expected of release.packages) {
    try {
      const entry = expected.name === REPO_FACTS_BUNDLE ? bundleEntry : createRequire(bundleEntry).resolve(expected.name);
      const installed = await describeInstalledPackage(await packageRootOf(entry, expected.name), expected.name);
      if (installed.version !== expected.version) problems.push(`${expected.name} is installed at ${installed.version}, not ${expected.version}`);
      if (installed.commit !== expected.commit) problems.push(`${expected.name} was built from ${installed.commit}, not ${expected.commit}`);
      if (installed.contentDigest !== expected.contentDigest) problems.push(`${expected.name} installed files differ from the recorded release`);
    } catch (error) {
      problems.push(`${expected.name} cannot be verified: ${messageOf(error)}`);
    }
  }
  return problems.length === 0 ? { status: "verified", release: release.release, commit: release.commit } : { status: "invalid", problems };
}

async function describeInstalledPackage(packageRoot: string, name: string): Promise<{ version: string; commit: string; contentDigest: string }> {
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    repoFacts?: { commit?: unknown; release?: unknown };
  };
  const provenance = JSON.parse(await fs.readFile(path.join(packageRoot, "provenance.json"), "utf8")) as { package?: unknown; version?: unknown; commit?: unknown };
  if (manifest.name !== name || provenance.package !== name) throw new Error(`${packageRoot} does not hold ${name}`);
  if (typeof manifest.version !== "string" || provenance.version !== manifest.version || manifest.repoFacts?.release !== manifest.version) {
    throw new Error(`${name} records inconsistent release versions`);
  }
  if (typeof provenance.commit !== "string" || manifest.repoFacts?.commit !== provenance.commit) {
    throw new Error(`${name} records inconsistent source commits`);
  }
  return { version: manifest.version, commit: provenance.commit, contentDigest: await contentDigest(packageRoot) };
}

/** SHA-256 over every installed file's relative path and SHA-256, excluding nested dependencies. */
export async function contentDigest(packageRoot: string): Promise<string> {
  const files: [string, string][] = [];
  await visit(packageRoot, "");
  files.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return crypto.createHash("sha256").update(canonicalJson(files)).digest("hex");

  async function visit(directory: string, relative: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relativePath = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push([relativePath, crypto.createHash("sha256").update(await fs.readFile(path.join(directory, entry.name))).digest("hex")]);
      } else {
        throw new Error(`${relativePath} is not a regular file`);
      }
    }
  }
}

async function packageRootOf(entry: string, name: string): Promise<string> {
  let directory = path.dirname(entry);
  for (;;) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === name) return directory;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`No package root for ${name} above ${entry}`);
    directory = parent;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
