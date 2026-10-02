import fs from "node:fs/promises";
import path from "node:path";
import { parseYaml } from "@repo-facts/contract";
import { minimatch } from "minimatch";

export type ApplicationRootMarker =
  | { kind: "explicit"; path: string }
  | { kind: "package-manifest"; path: string }
  | { kind: "npm-workspaces"; path: string }
  | { kind: "pnpm-workspace"; path: string }
  | { kind: "repository"; path: string };

export interface ApplicationRoot {
  status: "resolved" | "unresolved";
  /** Absolute real path of the application boundary. */
  root: string;
  /** Absolute real path the discovery started from. */
  invocation: string;
  /** The package the invocation belongs to, relative to the root; "" when it is the root. */
  focus: string;
  /** The nearest enclosing Git working tree, when one exists. */
  repositoryRoot: string | null;
  /** Markers that decided the boundary, as paths relative to the root. */
  markers: ApplicationRootMarker[];
  reason: string;
}

export interface ApplicationRootOptions {
  cwd: string;
  /** An explicit root overrides discovery. */
  root?: string;
}

/**
 * Finds the application boundary from the invocation directory by reading
 * manifests as data. The nearest package manifest wins unless an enclosing
 * workspace root inside the same Git working tree includes that package.
 * Discovery never looks above the repository boundary for workspaces.
 */
export async function discoverApplicationRoot(options: ApplicationRootOptions): Promise<ApplicationRoot> {
  const invocation = await realDirectory(options.cwd);
  if (options.root !== undefined) {
    const root = await realDirectory(options.root);
    return {
      status: "resolved",
      root,
      invocation,
      focus: within(root, invocation) ? posix(path.relative(root, await nearestPackage(invocation, root) ?? root)) : "",
      repositoryRoot: await repositoryRootOf(root),
      markers: [{ kind: "explicit", path: "" }],
      reason: "The application root was given explicitly",
    };
  }

  const repositoryRoot = await repositoryRootOf(invocation);
  const packageDirectory = await nearestPackage(invocation, repositoryRoot);
  if (packageDirectory === undefined) {
    const root = repositoryRoot ?? invocation;
    return {
      status: "unresolved",
      root,
      invocation,
      focus: "",
      repositoryRoot,
      markers: repositoryRoot === null ? [] : [{ kind: "repository", path: "" }],
      reason: "No package manifest was found between the invocation directory and the repository boundary",
    };
  }

  let workspace: { directory: string; marker: ApplicationRootMarker } | undefined;
  if (repositoryRoot !== null) {
    for (let directory = path.dirname(packageDirectory); within(repositoryRoot, directory); directory = path.dirname(directory)) {
      const marker = await workspaceMarker(directory, posix(path.relative(directory, packageDirectory)));
      if (marker !== undefined) workspace = { directory, marker };
      if (directory === repositoryRoot) break;
    }
  }
  const root = workspace?.directory ?? packageDirectory;
  const markers: ApplicationRootMarker[] = [{ kind: "package-manifest", path: posix(path.relative(root, path.join(packageDirectory, "package.json"))) }];
  if (workspace !== undefined) markers.push(workspace.marker);
  if (repositoryRoot === root) markers.push({ kind: "repository", path: "" });
  return {
    status: "resolved",
    root,
    invocation,
    focus: posix(path.relative(root, packageDirectory)),
    repositoryRoot,
    markers,
    reason: workspace === undefined
      ? "The nearest package manifest defines the application root"
      : "An enclosing workspace root includes the nearest package",
  };
}

/** The nearest ancestor (inclusive) holding a `.git` directory or file. */
export async function repositoryRootOf(start: string): Promise<string | null> {
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (await exists(path.join(directory, ".git"))) return directory;
    if (path.dirname(directory) === directory) return null;
  }
}

async function nearestPackage(start: string, boundary: string | null): Promise<string | undefined> {
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (await isFile(path.join(directory, "package.json"))) return directory;
    if (directory === boundary || path.dirname(directory) === directory) return undefined;
  }
}

async function workspaceMarker(directory: string, member: string): Promise<ApplicationRootMarker | undefined> {
  const manifest = await readJson(path.join(directory, "package.json"));
  const workspaces = manifest?.workspaces;
  const npmPatterns = Array.isArray(workspaces)
    ? workspaces
    : typeof workspaces === "object" && workspaces !== null && Array.isArray((workspaces as { packages?: unknown }).packages)
      ? (workspaces as { packages: unknown[] }).packages
      : [];
  if (includes(npmPatterns, member)) return { kind: "npm-workspaces", path: "package.json" };

  const pnpmPath = path.join(directory, "pnpm-workspace.yaml");
  if (await isFile(pnpmPath)) {
    try {
      const document = parseYaml(await fs.readFile(pnpmPath, "utf8"));
      const packages = typeof document === "object" && document !== null && !Array.isArray(document) ? (document as { packages?: unknown }).packages : undefined;
      if (Array.isArray(packages) && includes(packages, member)) return { kind: "pnpm-workspace", path: "pnpm-workspace.yaml" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function includes(patterns: readonly unknown[], member: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const negated = pattern.startsWith("!");
    const glob = (negated ? pattern.slice(1) : pattern).replace(/^\.\//, "").replace(/\/$/, "");
    if (minimatch(member, glob)) matched = !negated;
  }
  return matched;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function realDirectory(input: string): Promise<string> {
  const real = await fs.realpath(path.resolve(input));
  if (!(await fs.stat(real)).isDirectory()) throw new Error(`${input} is not a directory`);
  return real;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function posix(relative: string): string {
  return relative.split(path.sep).join("/");
}
