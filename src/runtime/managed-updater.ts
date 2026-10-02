import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pacote from "pacote";
import { canonicalJson, internalNpmSourceSchema, type InternalNpmSource } from "../contracts/index.js";

const execFileAsync = promisify(execFile);

export interface ManagedVersionPointer {
  schema: "web-doctor.managed-version";
  schemaVersion: 1;
  version: string;
  integrity: string;
  directory: string;
}

export interface ManagedUpdateOptions {
  root: string;
  source: InternalNpmSource;
  registry: string;
  cache?: string;
  allowInsecureRegistry?: boolean;
  selfCheck?: (packageRoot: string) => Promise<void>;
  dependencies?: DependencyInstallOptions;
}

/** How a staged release's pinned dependencies are installed from its npm-shrinkwrap.json. */
export interface DependencyInstallOptions {
  /** The registry for unscoped dependencies; defaults to the registry that served the release. */
  registry?: string;
  /** Registries for npm scopes, such as `@repo-facts`; the release registry serves every other package. */
  scopes?: Readonly<Record<string, string>>;
  /** Install only from the local npm cache, for staging without network access. */
  offline?: boolean;
  /** A dedicated npm cache, such as one inside the managed tool cache. */
  cache?: string;
  /** The npm executable; defaults to `npm` on the path. */
  npm?: string;
}

export interface ManagedUpdateResult {
  status: "activated";
  active: ManagedVersionPointer;
  previous?: ManagedVersionPointer;
}

export interface UpgradeCommandOptions {
  mode: "project-exact" | "project-range" | "workspace" | "global" | "immutable-ci" | "unknown";
  packageManager?: "npm" | "pnpm" | "yarn";
  packageName: string;
  version: string;
  approvedCommand?: string;
}

export async function installManagedUpdate(options: ManagedUpdateOptions): Promise<ManagedUpdateResult> {
  const source = internalNpmSourceSchema.parse(options.source);
  const registry = validateRegistry(options.registry, options.allowInsecureRegistry === true);
  const root = path.resolve(options.root);
  const versionsRoot = path.join(root, "versions");
  await fs.mkdir(versionsRoot, { recursive: true });
  const key = crypto.createHash("sha256").update(`${source.packageName}@${source.version}\0${source.integrity}`).digest("hex").slice(0, 16);
  const directory = path.posix.join("versions", `${source.version}-${key}`);
  const finalRoot = path.join(root, ...directory.split("/"));
  const stagingRoot = path.join(versionsRoot, `.staging-${crypto.randomUUID()}`);
  const selfCheck = options.selfCheck ?? defaultSelfCheck;
  let staged = false;

  try {
    try {
      await fs.access(finalRoot);
    } catch {
      staged = true;
      await pacote.extract(`${source.packageName}@${source.version}`, stagingRoot, {
        registry,
        integrity: source.integrity,
        ...(options.cache === undefined ? {} : { cache: options.cache }),
      });
      await installPinnedDependencies(stagingRoot, registry, options.dependencies ?? {});
      await selfCheck(stagingRoot);
      await fs.rename(stagingRoot, finalRoot);
      staged = false;
    }
    await selfCheck(finalRoot);
    const active: ManagedVersionPointer = {
      schema: "web-doctor.managed-version",
      schemaVersion: 1,
      version: source.version,
      integrity: source.integrity,
      directory,
    };
    const previous = await readManagedPointer(root, "active");
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(active)) {
      await writeManagedPointer(root, "previous", previous);
    }
    await writeManagedPointer(root, "active", active);
    return { status: "activated", active, ...(previous === undefined ? {} : { previous }) };
  } finally {
    if (staged) await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function rollbackManagedUpdate(rootInput: string): Promise<ManagedUpdateResult> {
  const root = path.resolve(rootInput);
  const [active, previous] = await Promise.all([
    readManagedPointer(root, "active"),
    readManagedPointer(root, "previous"),
  ]);
  if (active === undefined || previous === undefined) throw new Error("Managed rollback requires active and previous versions");
  await fs.access(path.join(root, ...previous.directory.split("/")));
  await writeManagedPointer(root, "active", previous);
  await writeManagedPointer(root, "previous", active);
  return { status: "activated", active: previous, previous: active };
}

export async function readManagedPointer(
  rootInput: string,
  name: "active" | "previous",
): Promise<ManagedVersionPointer | undefined> {
  try {
    const input = JSON.parse(await fs.readFile(path.join(rootInput, `${name}.json`), "utf8")) as Partial<ManagedVersionPointer>;
    if (
      input.schema !== "web-doctor.managed-version"
      || input.schemaVersion !== 1
      || typeof input.version !== "string"
      || typeof input.integrity !== "string"
      || typeof input.directory !== "string"
      || !input.directory.startsWith("versions/")
      || input.directory.includes("..")
    ) throw new Error(`Invalid managed ${name} pointer`);
    return input as ManagedVersionPointer;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function planUpgradeCommand(options: UpgradeCommandOptions): string {
  if (options.approvedCommand !== undefined) return options.approvedCommand;
  const target = `${options.packageName}@${options.version}`;
  if (options.mode === "global") return `npm install --global ${target}`;
  if (options.mode === "immutable-ci") throw new Error("Immutable CI requires an approved image or dependency upgrade command");
  if (options.mode === "unknown") throw new Error("Installation mode is unknown");
  if (options.packageManager === "pnpm") {
    return options.mode === "workspace" ? `pnpm --workspace-root add --save-dev --save-exact ${target}` : `pnpm add --save-dev --save-exact ${target}`;
  }
  if (options.packageManager === "yarn") {
    return options.mode === "workspace" ? `yarn workspace-root add --dev --exact ${target}` : `yarn add --dev --exact ${target}`;
  }
  if (options.packageManager === "npm") {
    return options.mode === "workspace" ? `npm install --workspace . --save-dev --save-exact ${target}` : `npm install --save-dev --save-exact ${target}`;
  }
  throw new Error("Project update requires a detected package manager");
}

async function writeManagedPointer(root: string, name: "active" | "previous", pointer: ManagedVersionPointer): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const temporaryPath = path.join(root, `.${name}-${crypto.randomUUID()}.json`);
  const pointerPath = path.join(root, `${name}.json`);
  await fs.writeFile(temporaryPath, `${canonicalJson(pointer)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, pointerPath);
}

interface ShrinkwrapEntry {
  version?: unknown;
  integrity?: unknown;
  resolved?: unknown;
  link?: unknown;
  dev?: unknown;
}

interface Shrinkwrap {
  lockfileVersion?: unknown;
  packages?: Record<string, ShrinkwrapEntry>;
}

/** Why a shrinkwrap does not pin these production dependencies well enough to install; empty when it does. */
export function shrinkwrapProblems(required: readonly string[], shrinkwrap: Shrinkwrap): string[] {
  const packages = shrinkwrap.packages ?? {};
  const problems: string[] = [];
  if (typeof shrinkwrap.lockfileVersion !== "number" || shrinkwrap.lockfileVersion < 2) problems.push("npm-shrinkwrap.json must use lockfile version 2 or later");
  for (const name of required) if (packages[`node_modules/${name}`] === undefined) problems.push(`npm-shrinkwrap.json does not pin ${name}`);
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "" || entry.dev === true) continue;
    if (entry.link === true) problems.push(`${key} is a link, not a registry package`);
    else if (typeof entry.version !== "string" || !/^\d+\.\d+\.\d+/.test(entry.version)) problems.push(`${key} has no exact version`);
    else if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) problems.push(`${key} has no SHA-512 integrity`);
    else if (entry.resolved !== undefined) problems.push(`${key} records ${String(entry.resolved)}; pinned packages resolve only through the configured registry`);
  }
  return problems;
}

/**
 * Installs a staged release's production dependencies exactly as its
 * published npm-shrinkwrap.json pins them. Every package must carry an exact
 * version and SHA-512 integrity and resolve through the configured registry;
 * npm verifies each tarball against that integrity and runs no scripts.
 */
export async function installPinnedDependencies(packageRoot: string, registry: string, options: DependencyInstallOptions = {}): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  const required = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort();
  if (required.length === 0) return;
  let shrinkwrap: Shrinkwrap;
  try {
    shrinkwrap = JSON.parse(await fs.readFile(path.join(packageRoot, "npm-shrinkwrap.json"), "utf8")) as Shrinkwrap;
  } catch {
    throw new Error("The release has dependencies but no npm-shrinkwrap.json; managed installs use only pinned dependencies");
  }
  const problems = shrinkwrapProblems(required, shrinkwrap);
  if (problems.length > 0) throw new Error(`The release's pinned dependencies cannot be installed:\n${problems.join("\n")}`);
  const insecure = new URL(registry).protocol === "http:";
  const args = [
    "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", "--workspaces=false",
    `--registry=${options.registry === undefined ? registry : validateRegistry(options.registry, insecure)}`,
    ...Object.entries(options.scopes ?? {}).map(([scope, url]) => `--${scope}:registry=${validateRegistry(url, insecure)}`),
    ...(options.offline === true ? ["--offline"] : []),
    ...(options.cache === undefined ? [] : [`--cache=${options.cache}`]),
  ];
  try {
    await execFileAsync(options.npm ?? "npm", args, { cwd: packageRoot, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const detail = (failure.stderr ?? failure.message ?? "").trim().split("\n").filter((line) => line.trim() !== "").slice(-3).join(" ");
    throw new Error(`Installing the release's pinned dependencies failed: ${detail}`);
  }
}

function validateRegistry(registryInput: string, allowInsecure: boolean): string {
  const registry = new URL(registryInput);
  if (registry.protocol !== "https:" && !(allowInsecure && registry.protocol === "http:")) {
    throw new Error("Enterprise npm registry must use HTTPS");
  }
  return registry.href;
}

async function defaultSelfCheck(packageRoot: string): Promise<void> {
  const moduleUrl = pathToFileURL(path.join(packageRoot, "dist", "index.js")).href;
  const registryRoot = path.join(packageRoot, "generated", "registry");
  const script = `const { WebDoctorRuntime } = await import(${JSON.stringify(moduleUrl)}); await WebDoctorRuntime.create({ root: ${JSON.stringify(registryRoot)} });`;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
}