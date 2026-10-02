import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, digestDocument, type Contribution, type PolicyPack, type RegistrySnapshot } from "../../src/contracts/index.js";
import { assembleEmbeddedRegistry } from "../../src/registry/assemble.js";
import { loadEmbeddedRegistry } from "../../src/runtime/embedded-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("embedded registry loading", () => {
  it("verifies the complete embedded boundary and rejects altered or inconsistent contents", async () => {
    const fixture = await buildFixture();
    const loaded = await loadEmbeddedRegistry({ root: fixture.generatedRoot });
    expect(loaded).toMatchObject({ digest: digestDocument(fixture.snapshot).digest });

    const policyPath = path.join(fixture.generatedRoot, "contributions", "firm", "example", "policy.json");
    const originalPolicy = await fs.readFile(policyPath);
    await fs.writeFile(policyPath, JSON.stringify({ ...fixture.policy, owner: "Altered" }), "utf8");
    await expect(loadEmbeddedRegistry({ root: fixture.generatedRoot })).rejects.toThrow(/snapshot policies/);
    await fs.writeFile(policyPath, originalPolicy);

    const artifactPath = path.join(fixture.generatedRoot, "contributions", "firm", "example", "runtime.js");
    await fs.writeFile(artifactPath, "altered", "utf8");
    await expect(loadEmbeddedRegistry({ root: fixture.generatedRoot })).rejects.toThrow(/runtime artifact digest mismatch/);
    await fs.writeFile(artifactPath, fixture.artifactContents, "utf8");

    await fs.writeFile(path.join(fixture.generatedRoot, "unexpected.txt"), "not declared", "utf8");
    await expect(loadEmbeddedRegistry({ root: fixture.generatedRoot })).rejects.toThrow(/unexpected unexpected\.txt/);
  });

  it("returns identical results when network access is denied", async () => {
    const fixture = await buildFixture();
    const online = await loadEmbeddedRegistry({ root: fixture.generatedRoot });
    const denied = vi.fn(() => { throw new Error("network denied"); });
    vi.stubGlobal("fetch", denied);
    try {
      const offline = await loadEmbeddedRegistry({ root: fixture.generatedRoot });
      expect(offline.snapshot).toEqual(online.snapshot);
      expect(offline.digest).toBe(online.digest);
      expect(offline.files).toEqual(online.files);
      expect(denied).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

async function buildFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-embedded-"));
  temporaryDirectories.push(root);
  const contributionRoot = path.join(root, "staged", "firm", "example");
  await fs.mkdir(path.join(contributionRoot, "fixtures"), { recursive: true });
  const artifactContents = "export const fixture = true;\n";
  const artifactDigest = crypto.createHash("sha256").update(artifactContents).digest("hex");
  const policy: PolicyPack = {
    schema: "web-doctor.policy-pack",
    schemaVersion: 2,
    id: "firm/example",
    version: "1.0.0",
    owner: "Fixture Team",
    layer: "firmwide",
    compatibility: { webDoctor: ">=0.1.0" },
    controls: [{
      id: "firm/example/control",
      title: "Example",
      rationale: "Verify embedded contents.",
      strength: "required",
      applicability: {},
      evidence: [{ provider: "eslint", rule: "example", kind: "static", required: true }],
      verification: [{ kind: "test", description: "Run fixture." }],
    }],
  };
  const manifest: Contribution = {
    schema: "web-doctor.contribution",
    schemaVersion: 1,
    id: "firm/example",
    type: "policy",
    owner: "Fixture Team",
    compatibility: { webDoctor: ">=0.1.0" },
    portals: [],
    layers: ["firmwide"],
    documents: [{ kind: "policy", path: "policy.json" }],
    runtimeArtifacts: [{ path: "runtime.js", digest: artifactDigest }],
    dependencies: [],
    fixtures: ["fixtures/policy.json"],
    provenance: { repository: "ssh://git.internal/firm/example.git", commit: "c".repeat(40) },
  };
  await fs.writeFile(path.join(contributionRoot, "web-doctor.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(contributionRoot, "policy.json"), JSON.stringify(policy), "utf8");
  await fs.writeFile(path.join(contributionRoot, "runtime.js"), artifactContents, "utf8");
  await fs.writeFile(path.join(contributionRoot, "fixtures", "policy.json"), JSON.stringify({
    schema: "web-doctor.fixture",
    schemaVersion: 1,
    id: "policy/accept",
    contract: "policyPack",
    input: "policy.json",
    expected: "accept",
  }), "utf8");
  const snapshot: RegistrySnapshot = {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 2,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: "a".repeat(40),
    catalogCommit: "b".repeat(40),
    catalogDigest: "d".repeat(64),
    portals: [],
    contributions: [{
      id: manifest.id,
      type: manifest.type,
      owner: "fixture-team",
      source: {
        schema: "web-doctor.npm-source",
        schemaVersion: 1,
        registry: "internal",
        packageName: "@firm/example",
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
    policies: [policy],
    providers: [],
    guidance: [],
  };
  const generatedRoot = path.join(root, "generated", "registry");
  await assembleEmbeddedRegistry(snapshot, path.join(root, "staged"), generatedRoot);
  expect(JSON.parse(await fs.readFile(path.join(generatedRoot, "snapshot.json"), "utf8"))).toEqual(JSON.parse(canonicalJson(snapshot)));
  return { generatedRoot, snapshot, policy, artifactContents };
}