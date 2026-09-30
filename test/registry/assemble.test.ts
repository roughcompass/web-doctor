import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestDocument,
  type Contribution,
  type PolicyPack,
  type RegistrySnapshot,
} from "../../src/contracts/index.js";
import { assembleEmbeddedRegistry } from "../../src/registry/assemble.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("embedded registry assembly", () => {
  it("packs the complete declared snapshot without unregistered contribution content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-package-"));
    temporaryDirectories.push(root);
    const contributionsRoot = path.join(root, "staged");
    const registeredRoot = path.join(contributionsRoot, "firm", "registered");
    const unregisteredRoot = path.join(contributionsRoot, "firm", "unregistered");
    await fs.mkdir(path.join(registeredRoot, "fixtures"), { recursive: true });
    await fs.mkdir(unregisteredRoot, { recursive: true });
    const manifest = contributionManifest();
    await fs.writeFile(path.join(registeredRoot, "web-doctor.json"), JSON.stringify(manifest), "utf8");
    await fs.writeFile(path.join(registeredRoot, "policy.json"), JSON.stringify(policy()), "utf8");
    await fs.writeFile(path.join(registeredRoot, "fixtures", "policy.json"), JSON.stringify({
      schema: "web-doctor.fixture",
      schemaVersion: 1,
      id: "policy/accept",
      contract: "policyPack",
      input: "policy.json",
      expected: "accept",
    }), "utf8");
    await fs.writeFile(path.join(unregisteredRoot, "secret.txt"), "not registered", "utf8");

    const packageRoot = path.join(root, "package");
    const generatedRoot = path.join(packageRoot, "generated", "registry");
    const snapshot = registrySnapshot(manifest);
    const result = await assembleEmbeddedRegistry(snapshot, contributionsRoot, generatedRoot);
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "web-doctor-assembly-fixture",
      version: "1.0.0",
      files: ["generated/"],
    }), "utf8");

    expect(result.files).toEqual([
      "contributions/firm/registered/fixtures/policy.json",
      "contributions/firm/registered/policy.json",
      "contributions/firm/registered/web-doctor.json",
      "snapshot.json",
    ]);
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot, encoding: "utf8" });
    expect(packed.status).toBe(0);
    const files = JSON.parse(packed.stdout)[0].files.map((file: { path: string }) => file.path);
    expect(files).toEqual(expect.arrayContaining(result.files.map((file) => `generated/registry/${file}`)));
    expect(files.some((file: string) => file.includes("unregistered"))).toBe(false);
  });
});

function contributionManifest(): Contribution {
  return {
    schema: "web-doctor.contribution",
    schemaVersion: 1,
    id: "firm/registered",
    type: "policy",
    owner: "Enterprise Accessibility",
    compatibility: { webDoctor: ">=0.1.0" },
    portals: [],
    layers: ["firmwide"],
    documents: [{ kind: "policy", path: "policy.json" }],
    runtimeArtifacts: [],
    dependencies: [],
    fixtures: ["fixtures/policy.json"],
    provenance: { repository: "ssh://git.internal/firm/registered.git", commit: "c".repeat(40) },
  };
}

function policy(): PolicyPack {
  return {
    schema: "web-doctor.policy-pack",
    schemaVersion: 1,
    id: "firm/registered",
    version: "1.0.0",
    owner: "Enterprise Accessibility",
    layer: "firmwide",
    compatibility: { webDoctor: ">=0.1.0" },
    controls: [{
      id: "firm/registered/control",
      title: "Registered control",
      rationale: "Verify package assembly.",
      strength: "required",
      applicability: {},
      evidence: [{ provider: "eslint", rule: "fixture/rule", kind: "static", required: true }],
      verification: [{ kind: "test", description: "Run fixture." }],
    }],
  };
}

function registrySnapshot(manifest: ReturnType<typeof contributionManifest>): RegistrySnapshot {
  return {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 1,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: "c".repeat(40),
    catalogCommit: "d".repeat(40),
    catalogDigest: "a".repeat(64),
    portals: [],
    contributions: [{
      id: manifest.id,
      type: manifest.type,
      owner: "enterprise-accessibility",
      source: {
        schema: "web-doctor.npm-source",
        schemaVersion: 1,
        registry: "internal",
        packageName: "@firm/registered",
        version: "1.0.0",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        provenance: manifest.provenance,
      },
      manifestPath: "web-doctor.json",
      manifestDigest: digestDocument(manifest).digest,
      lifecycle: "active",
      compatibility: manifest.compatibility,
      portals: [],
      layers: ["firmwide"],
    }],
    policies: [policy()],
    providers: [],
    guidance: [],
  };
}