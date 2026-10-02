import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PolicyPack, RegistrySnapshot } from "../../src/contracts/index.js";
import { installManagedUpdate, readManagedPointer } from "../../src/runtime/managed-updater.js";
import { writeEmbeddedRegistry } from "./embedded-registry.js";
import { startCacheMirror, type CacheMirror } from "./cache-mirror.js";
import { startInternalRegistry } from "./internal-registry.js";
import { materialize } from "./repo-facts-fixtures.js";

/**
 * Clean installations of a Web Doctor release. The release tarball is the
 * packed package with a registry embedded the way release CI embeds one, and
 * with its npm-shrinkwrap.json. A project installs it as a dependency; a
 * managed installation stages it with its pinned dependencies and activates
 * it. A mirror of the developer's npm cache stands in for the enterprise
 * registry, so neither needs network, and each install uses its own cache.
 */

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const REPO_FACTS_REGISTRY = process.env.REPO_FACTS_NPM_REGISTRY ?? "http://127.0.0.1:4873/";

export interface CleanInstallation {
  kind: "project" | "managed";
  workspace: string;
  app: string;
  /** The command that runs this installation's CLI, followed by its arguments. */
  command: string[];
  env: NodeJS.ProcessEnv;
  run: (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Commits the application's current files, so changed-file checks have a base. */
  commit: () => Promise<void>;
  close: () => Promise<void>;
}

export interface CleanInstallationOptions {
  files: Record<string, string>;
  policies: readonly PolicyPack[];
  portals?: RegistrySnapshot["portals"];
}

/** Packs Web Doctor as a release: the package, its shrinkwrap, and an embedded registry. */
export async function buildReleaseTarball(workspace: string, options: Pick<CleanInstallationOptions, "policies" | "portals">): Promise<string> {
  const packDirectory = path.join(workspace, "pack");
  await fs.mkdir(packDirectory, { recursive: true });
  const { stdout } = await execFileAsync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  const packed = path.join(packDirectory, (JSON.parse(stdout) as { filename: string }[])[0]!.filename);
  const unpacked = path.join(workspace, "release");
  await fs.mkdir(unpacked, { recursive: true });
  await execFileAsync("tar", ["-xzf", packed, "-C", unpacked]);
  const packageRoot = path.join(unpacked, "package");
  await writeEmbeddedRegistry(packageRoot, { policies: options.policies, ...(options.portals === undefined ? {} : { portals: options.portals }) });
  await fs.rm(path.join(packageRoot, "staged"), { recursive: true, force: true });
  const release = path.join(workspace, "dist");
  await fs.mkdir(release, { recursive: true });
  const repacked = await execFileAsync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", release], { cwd: packageRoot, maxBuffer: 64 * 1024 * 1024 });
  return path.join(release, (JSON.parse(repacked.stdout) as { filename: string }[])[0]!.filename);
}

export async function installCleanApplication(options: CleanInstallationOptions): Promise<CleanInstallation> {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-clean-install-")));
  const tarball = await buildReleaseTarball(workspace, options);
  const app = await application(workspace, options.files);
  const mirror = await mirrorOfCache();
  try {
    await execFileAsync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", `--registry=${mirror.url}`, `--@repo-facts:registry=${mirror.url}`, `--cache=${path.join(workspace, "npm-cache")}`, "--save-dev", "--save-exact", tarball], { cwd: app, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`The clean install failed; the mirror had no cached ${mirror.misses.join(", ") || "entries"}: ${String(error)}`);
  } finally {
    await mirror.close();
  }
  return installation("project", workspace, app, [path.join(app, "node_modules", ".bin", "web-doctor")], environment());
}

/** The mirror serves what the development install cached from its own registries. */
async function mirrorOfCache(): Promise<CacheMirror> {
  const registry = (await execFileAsync("npm", ["config", "get", "registry"], { cwd: os.tmpdir() })).stdout.trim();
  return startCacheMirror([registry, REPO_FACTS_REGISTRY]);
}

/** A managed tool-cache installation, staged and activated by the managed updater itself. */
export async function installManagedApplication(options: CleanInstallationOptions): Promise<CleanInstallation & { managedRoot: string }> {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-managed-install-")));
  const tarball = await buildReleaseTarball(workspace, options);
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  const registry = await startInternalRegistry([{ name: "web-doctor", version: manifest.version, files: {}, tarball: await fs.readFile(tarball) }]);
  const managedRoot = path.join(workspace, "tool-cache");
  const mirror = await mirrorOfCache();
  try {
    await installManagedUpdate({
      root: managedRoot,
      source: registry.source("web-doctor", manifest.version),
      registry: registry.registry,
      cache: registry.cache,
      allowInsecureRegistry: true,
      dependencies: { registry: mirror.url, scopes: { "@repo-facts": mirror.url }, cache: path.join(managedRoot, "npm-cache") },
    });
  } catch (error) {
    throw new Error(`The managed install failed; the mirror had no cached ${mirror.misses.join(", ") || "entries"}: ${String(error)}`);
  } finally {
    await registry.close();
    await mirror.close();
  }
  const active = (await readManagedPointer(managedRoot, "active"))!;
  const app = await application(workspace, options.files);
  const env = { ...environment(), WEB_DOCTOR_INSTALLATION_MODE: "managed", WEB_DOCTOR_MANAGED_ROOT: managedRoot };
  return { ...installation("managed", workspace, app, [process.execPath, path.join(managedRoot, active.directory, "dist", "cli.js")], env), managedRoot };
}

async function application(workspace: string, files: Record<string, string>): Promise<string> {
  const app = path.join(workspace, "app");
  await materialize(app, { ".npmrc": `@repo-facts:registry=${REPO_FACTS_REGISTRY}\nignore-scripts=true\n`, ".gitignore": "node_modules\nweb-doctor-report.json\n", ...files });
  return app;
}

function environment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("WEB_DOCTOR_")));
}

function installation(kind: CleanInstallation["kind"], workspace: string, app: string, command: string[], env: NodeJS.ProcessEnv): CleanInstallation {
  return {
    kind,
    workspace,
    app,
    command,
    env,
    run: async (args) => {
      try {
        const result = await execFileAsync(command[0]!, [...command.slice(1), ...args], { cwd: app, env, maxBuffer: 64 * 1024 * 1024 });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
      }
    },
    commit: async () => {
      const git = (...args: string[]) => execFileAsync("git", ["-c", "user.email=ci@example.com", "-c", "user.name=CI", ...args], { cwd: app });
      await git("init", "-q");
      await git("add", ".");
      await git("commit", "-q", "-m", "base");
    },
    close: () => fs.rm(workspace, { recursive: true, force: true }),
  };
}

/** Every command line in the fenced `sh` blocks of a document, in order. */
export async function documentedCommands(file: string): Promise<string[]> {
  const text = await fs.readFile(file, "utf8");
  return [...text.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((match) => match[1]!.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
}
