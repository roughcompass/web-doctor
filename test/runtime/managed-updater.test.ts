import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installManagedUpdate,
  planUpgradeCommand,
  readManagedPointer,
  rollbackManagedUpdate,
} from "../../src/runtime/managed-updater.js";
import { startInternalRegistry, type InternalRegistryFixture } from "../support/internal-registry.js";

const temporaryDirectories: string[] = [];
const registries: InternalRegistryFixture[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("managed standalone updater", () => {
  it("stages, self-checks, atomically activates, and rolls back exact packages", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-managed-"));
    temporaryDirectories.push(root);
    const registry = await startInternalRegistry([packageFixture("1.0.0"), packageFixture("2.0.0")]);
    registries.push(registry);
    const checked: string[] = [];
    const selfCheck = async (packageRoot: string) => {
      checked.push(await fs.readFile(path.join(packageRoot, "version.txt"), "utf8"));
    };

    await installManagedUpdate({
      root,
      source: registry.source("web-doctor", "1.0.0"),
      registry: registry.registry,
      cache: registry.cache,
      allowInsecureRegistry: true,
      selfCheck,
    });
    await installManagedUpdate({
      root,
      source: registry.source("web-doctor", "2.0.0"),
      registry: registry.registry,
      cache: registry.cache,
      allowInsecureRegistry: true,
      selfCheck,
    });
    expect(await readManagedPointer(root, "active")).toMatchObject({ version: "2.0.0" });
    expect(await readManagedPointer(root, "previous")).toMatchObject({ version: "1.0.0" });
    expect(checked).toEqual(["1.0.0", "1.0.0", "2.0.0", "2.0.0"]);

    await rollbackManagedUpdate(root);
    expect(await readManagedPointer(root, "active")).toMatchObject({ version: "1.0.0" });
    expect(await readManagedPointer(root, "previous")).toMatchObject({ version: "2.0.0" });
  });

  it("preserves the active pointer when integrity or startup checks fail", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-managed-failure-"));
    temporaryDirectories.push(root);
    const registry = await startInternalRegistry([packageFixture("1.0.0"), packageFixture("2.0.0")]);
    registries.push(registry);
    const base = {
      root,
      registry: registry.registry,
      cache: registry.cache,
      allowInsecureRegistry: true,
    };
    await installManagedUpdate({ ...base, source: registry.source("web-doctor", "1.0.0"), selfCheck: async () => {} });
    const active = await fs.readFile(path.join(root, "active.json"));

    const wrongIntegrity = { ...registry.source("web-doctor", "2.0.0"), integrity: registry.source("web-doctor", "1.0.0").integrity };
    await expect(installManagedUpdate({ ...base, source: wrongIntegrity, selfCheck: async () => {} })).rejects.toThrow();
    await expect(installManagedUpdate({
      ...base,
      source: registry.source("web-doctor", "2.0.0"),
      selfCheck: async () => { throw new Error("startup failed"); },
    })).rejects.toThrow(/startup failed/);
    expect(await fs.readFile(path.join(root, "active.json"))).toEqual(active);
  });

  it("returns exact commands for package-managed and immutable installations without writes", async () => {
    const applicationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-project-update-"));
    temporaryDirectories.push(applicationRoot);
    await fs.writeFile(path.join(applicationRoot, "package.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(applicationRoot, "package-lock.json"), "{}\n", "utf8");
    const before = await tree(applicationRoot);

    expect(planUpgradeCommand({ mode: "project-exact", packageManager: "npm", packageName: "web-doctor", version: "2.0.0" }))
      .toBe("npm install --save-dev --save-exact web-doctor@2.0.0");
    expect(planUpgradeCommand({ mode: "workspace", packageManager: "pnpm", packageName: "web-doctor", version: "2.0.0" }))
      .toBe("pnpm --workspace-root add --save-dev --save-exact web-doctor@2.0.0");
    expect(planUpgradeCommand({ mode: "immutable-ci", packageName: "web-doctor", version: "2.0.0", approvedCommand: "docker pull registry/web-doctor:2.0.0" }))
      .toBe("docker pull registry/web-doctor:2.0.0");
    expect(await tree(applicationRoot)).toEqual(before);
  });
});

function packageFixture(version: string) {
  return { name: "web-doctor", version, files: { "version.txt": version } };
}

async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await fs.readdir(root)).sort()) result[name] = await fs.readFile(path.join(root, name), "utf8");
  return result;
}