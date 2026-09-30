import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, digestDocument, type RegistrySnapshot } from "../../src/contracts/index.js";
import { WebDoctorRuntime } from "../../src/runtime/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("process registry pinning", () => {
  it("keeps long-running and subsequent calls on one digest until runtime restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-runtime-"));
    temporaryDirectories.push(root);
    const firstSnapshot = snapshot("a".repeat(64));
    await writeSnapshot(root, firstSnapshot);
    const runtime = await WebDoctorRuntime.create({ root });
    const firstDigest = digestDocument(firstSnapshot).digest;

    const longRunningRequest = Promise.resolve().then(() => runtime.resolvePolicy({ portalSelection: {} }));
    const secondSnapshot = snapshot("b".repeat(64));
    await writeSnapshot(root, secondSnapshot);
    const updateState = await runtime.resolveUpdateState({
      installedVersion: "0.1.0",
      installationMode: "project-exact",
      distribution: { packageName: "web-doctor", registry: "https://npm.internal.example/" },
      lookup: async () => "9.0.0",
    });
    const subsequentRequest = runtime.resolvePolicy({ portalSelection: {} });

    expect((await longRunningRequest).registryDigest).toBe(firstDigest);
    expect(subsequentRequest.registryDigest).toBe(firstDigest);
    expect(runtime.registryDigest).toBe(firstDigest);
    expect(updateState.status).toBe("outdated");
    expect(Object.isFrozen(runtime.registry.snapshot)).toBe(true);

    const restarted = await WebDoctorRuntime.create({ root });
    expect(restarted.registryDigest).toBe(digestDocument(secondSnapshot).digest);
    expect(restarted.registryDigest).not.toBe(firstDigest);
  });
});

function snapshot(catalogDigest: string): RegistrySnapshot {
  return {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 1,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: "c".repeat(40),
    catalogCommit: "d".repeat(40),
    catalogDigest,
    portals: [],
    contributions: [],
    policies: [],
    providers: [],
    guidance: [],
  };
}

async function writeSnapshot(root: string, snapshot: RegistrySnapshot): Promise<void> {
  await fs.writeFile(path.join(root, "snapshot.json"), `${canonicalJson(snapshot)}\n`, "utf8");
}