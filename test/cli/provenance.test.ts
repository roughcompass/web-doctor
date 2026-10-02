import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, digestDocument, type RegistrySnapshot } from "../../src/contracts/index.js";
import { runCli } from "../../src/cli-app.js";
import { loadBuildProvenance } from "../../src/runtime/provenance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("build provenance", () => {
  it("returns exact build inputs through the CLI", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-provenance-"));
    temporaryDirectories.push(directory);
    const snapshotPath = path.join(directory, "snapshot.json");
    const snapshot = buildSnapshot();
    await fs.writeFile(snapshotPath, `${canonicalJson(snapshot)}\n`, "utf8");

    const provenance = await loadBuildProvenance({ snapshotPath });
    const result = await invoke(["provenance", "--snapshot", snapshotPath, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(provenance);
    expect(provenance).toMatchObject({
      webDoctorVersion: "0.1.0",
      webDoctorCommit: "c".repeat(40),
      catalogCommit: "d".repeat(40),
      registryDigest: digestDocument(snapshot).digest,
      contributions: [{
        id: "firm/accessibility",
        packageName: "@firm/accessibility-policy",
        version: "1.0.0",
        repository: "ssh://git.internal/firm/accessibility.git",
        commit: "e".repeat(40),
      }],
    });
  });
});

function buildSnapshot(): RegistrySnapshot {
  return {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 2,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: "c".repeat(40),
    catalogCommit: "d".repeat(40),
    catalogDigest: "a".repeat(64),
    portals: [],
    contributions: [{
      id: "firm/accessibility",
      type: "policy",
      owner: "enterprise-accessibility",
      source: {
        schema: "web-doctor.npm-source",
        schemaVersion: 1,
        registry: "internal",
        packageName: "@firm/accessibility-policy",
        version: "1.0.0",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        provenance: {
          repository: "ssh://git.internal/firm/accessibility.git",
          commit: "e".repeat(40),
        },
      },
      manifestPath: "web-doctor.json",
      manifestDigest: "b".repeat(64),
      lifecycle: "active",
      compatibility: { webDoctor: ">=0.1.0" },
      portals: [],
      layers: ["firmwide"],
    }],
    policies: [],
    providers: [],
    guidance: [],
  };
}

async function invoke(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { exitCode, stdout, stderr };
}