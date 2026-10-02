import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDoctor, type UpdateConfiguration, type UpdateOutcome } from "../../src/core/web-doctor.js";
import { readManagedPointer } from "../../src/runtime/managed-updater.js";
import { WEB_DOCTOR_VERSION } from "../../src/version.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { startInternalRegistry, type InternalRegistryFixture } from "../support/internal-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";

let workspace: string;
let app: string;
let registryRoot: string;
let packages: InternalRegistryFixture;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-update-")));
  app = path.join(workspace, "app");
  await materialize(app, { "package.json": '{"name":"orders","packageManager":"npm@10.9.0","devDependencies":{"web-doctor":"0.1.0"}}\n' });
  registryRoot = (await writeEmbeddedRegistry(path.join(workspace, "registry"), {})).root;
  packages = await startInternalRegistry([
    { name: "web-doctor", version: "9.0.0", files: { "version.txt": "9.0.0" } },
    { name: "web-doctor", version: "9.1.0", files: { "version.txt": "9.1.0" } },
  ]);
}, 60_000);

afterAll(async () => {
  await packages?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function applyWith(update: UpdateConfiguration): Promise<{ outcome: UpdateOutcome; warnings: string[] }> {
  const core = await WebDoctor.open({ cwd: app, caller: "cli", registryRoot, watch: false, update });
  try {
    const response = await core.applyUpdate();
    return { outcome: (response.data as { outcome: UpdateOutcome }).outcome, warnings: response.warnings };
  } finally {
    await core.close();
  }
}

const distribution = () => ({ packageName: "web-doctor", registry: packages.registry });

describe("web-doctor update", () => {
  it("activates a verified release in a managed installation and keeps the previous one for rollback", async () => {
    const managedRoot = path.join(workspace, "managed");
    const common = { distribution: distribution(), installationMode: "managed" as const, managedRoot, allowInsecureRegistry: true, selfCheck: async () => {} };
    const first = await applyWith({ ...common, lookup: async () => "9.0.0" });
    expect(first.outcome).toMatchObject({ status: "activated", active: { version: "9.0.0", integrity: packages.source("web-doctor", "9.0.0").integrity }, previous: null });
    expect(first.outcome.reason).toBe(`Web Doctor 9.0.0 is active for new processes; this process keeps ${WEB_DOCTOR_VERSION} and its registry snapshot`);
    const second = await applyWith({ ...common, lookup: async () => "9.1.0" });
    expect(second.outcome).toMatchObject({ status: "activated", active: { version: "9.1.0" }, previous: { version: "9.0.0" } });
    expect(await readManagedPointer(managedRoot, "previous")).toMatchObject({ version: "9.0.0" });
  });

  it("rolls a managed installation back to the retained version, and refuses one without a previous version", async () => {
    const managedRoot = path.join(workspace, "managed-rollback");
    const common = { distribution: distribution(), installationMode: "managed" as const, managedRoot, allowInsecureRegistry: true, selfCheck: async () => {} };
    await applyWith({ ...common, lookup: async () => "9.0.0" });
    const core = await WebDoctor.open({ cwd: app, caller: "cli", registryRoot, watch: false, update: common });
    try {
      expect((await core.applyRollback()).data).toMatchObject({ outcome: { status: "failed" } });
      await core.close();
    } catch (error) {
      await core.close();
      throw error;
    }
    await applyWith({ ...common, lookup: async () => "9.1.0" });
    const again = await WebDoctor.open({ cwd: app, caller: "cli", registryRoot, watch: false, update: common });
    try {
      expect((await again.applyRollback()).data).toMatchObject({ outcome: { status: "activated", active: { version: "9.0.0" }, previous: { version: "9.1.0" } } });
    } finally {
      await again.close();
    }
    expect(await readManagedPointer(managedRoot, "active")).toMatchObject({ version: "9.0.0" });
  });

  it("retains the active version when the self-check fails", async () => {
    const managedRoot = path.join(workspace, "managed-failing");
    const base = { distribution: distribution(), installationMode: "managed" as const, managedRoot, allowInsecureRegistry: true };
    await applyWith({ ...base, lookup: async () => "9.0.0", selfCheck: async () => {} });
    const active = await fs.readFile(path.join(managedRoot, "active.json"), "utf8");
    const failed = await applyWith({ ...base, lookup: async () => "9.1.0", selfCheck: async () => { throw new Error("startup failed"); } });
    expect(failed.outcome.status).toBe("failed");
    expect(failed.outcome.reason).toMatch(/^The update was not activated and the previous version remains active: .*startup failed/);
    expect(failed.warnings).toContain(failed.outcome.reason);
    expect(await fs.readFile(path.join(managedRoot, "active.json"), "utf8")).toBe(active);
  });

  it("names the exact dependency command for a project installation without changing it", async () => {
    const before = await fs.readFile(path.join(app, "package.json"), "utf8");
    const { outcome } = await applyWith({ distribution: distribution(), installationMode: "project-exact", lookup: async () => "9.1.0" });
    expect(outcome).toEqual({ status: "action_required", reason: "Web Doctor never changes this installation; run the upgrade command", command: "npm install --save-dev --save-exact web-doctor@9.1.0" });
    expect(await fs.readFile(path.join(app, "package.json"), "utf8")).toBe(before);
  });

  it("refuses a managed update without a managed root, and reports current installations", async () => {
    expect((await applyWith({ distribution: distribution(), installationMode: "managed", lookup: async () => "9.1.0" })).outcome.status).toBe("failed");
    expect((await applyWith({ distribution: distribution(), installationMode: "managed", lookup: async () => WEB_DOCTOR_VERSION })).outcome.status).toBe("current");
  });
});
