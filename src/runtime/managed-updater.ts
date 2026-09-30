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
      await pacote.extract(`${source.packageName}@${source.version}`, stagingRoot, {
        registry,
        integrity: source.integrity,
        ...(options.cache === undefined ? {} : { cache: options.cache }),
      });
      staged = true;
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