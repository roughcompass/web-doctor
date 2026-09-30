import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestDocument,
  parseContract,
  type Catalog,
} from "../../src/contracts/index.js";
import { validateRegistryFiles } from "../../src/registry/command.js";
import { generateContributionLock, writeContributionLock } from "../../src/registry/lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("release contribution artifacts", () => {
  it("runs declared fixtures and records verified runtime artifacts", async () => {
    const fixture = await buildFixture(true);
    const report = await validateRegistryFiles(fixture);

    expect(report).toMatchObject({
      valid: true,
      runtimeArtifacts: [{
        contributionId: "platform/example-provider",
        path: "dist/provider.js",
        digest: fixture.artifactDigest,
      }],
    });
  });

  it("blocks mismatched and undeclared runtime artifacts", async () => {
    const mismatched = await buildFixture(true);
    await fs.writeFile(mismatched.artifactPath, "changed runtime bytes", "utf8");
    const digestReport = await validateRegistryFiles(mismatched);
    expect(digestReport.valid).toBe(false);
    expect(digestReport.issues.map((issue) => issue.code)).toContain("artifact_digest");
    expect(digestReport.runtimeArtifacts).toEqual([]);

    const undeclared = await buildFixture(false);
    const declarationReport = await validateRegistryFiles(undeclared);
    expect(declarationReport.valid).toBe(false);
    expect(declarationReport.issues.map((issue) => issue.code)).toContain("runtime_artifact_declaration");
  });
});

async function buildFixture(declareRuntimeArtifact: boolean) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-release-artifact-"));
  temporaryDirectories.push(directory);
  const contributionRoot = path.join(directory, "contributions", "platform", "example-provider");
  await fs.mkdir(path.join(contributionRoot, "dist"), { recursive: true });
  await fs.mkdir(path.join(contributionRoot, "fixtures"), { recursive: true });
  const artifactPath = path.join(contributionRoot, "dist", "provider.js");
  const undeclaredArtifactPath = path.join(contributionRoot, "dist", "undeclared.js");
  const artifactContents = "export const provider = true;";
  const artifactDigest = crypto.createHash("sha256").update(artifactContents).digest("hex");
  await fs.writeFile(artifactPath, artifactContents, "utf8");
  await fs.writeFile(undeclaredArtifactPath, artifactContents, "utf8");

  const provider = {
    schema: "web-doctor.provider-manifest",
    schemaVersion: 1,
    id: "example-provider",
    version: "1.0.0",
    owner: "Web Platform",
    adapterVersion: "1",
    engine: "eslint",
    engineRange: "^9.0.0",
    compatibility: { webDoctor: ">=0.1.0" },
    evidenceKinds: ["static"],
    completeness: ["complete"],
    capabilities: ["filesystem-read"],
    invocationModes: ["static"],
    rules: [{ id: "example", title: "Example rule", evidenceKind: "static" }],
    artifacts: [{ path: "dist/provider.js", digest: artifactDigest }],
  };
  const provenance = {
    repository: "ssh://git.internal/platform/example-provider.git",
    commit: "c".repeat(40),
  };
  const manifest = {
    schema: "web-doctor.contribution",
    schemaVersion: 1,
    id: "platform/example-provider",
    type: "provider",
    owner: "Web Platform",
    compatibility: { webDoctor: ">=0.1.0" },
    portals: [],
    layers: ["platform"],
    documents: [{ kind: "provider", path: "provider.json" }],
    runtimeArtifacts: [
      { path: "dist/provider.js", digest: artifactDigest },
      ...(declareRuntimeArtifact ? [] : [{ path: "dist/undeclared.js", digest: artifactDigest }]),
    ],
    dependencies: [],
    fixtures: ["fixtures/provider.json"],
    provenance,
  };
  await fs.writeFile(path.join(contributionRoot, "web-doctor.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(contributionRoot, "provider.json"), JSON.stringify(provider), "utf8");
  await fs.writeFile(path.join(contributionRoot, "fixtures", "provider.json"), JSON.stringify({
    schema: "web-doctor.fixture",
    schemaVersion: 1,
    id: "provider/accept",
    contract: "providerManifest",
    input: "provider.json",
    expected: "accept",
  }), "utf8");

  const source = {
    schema: "web-doctor.npm-source",
    schemaVersion: 1,
    registry: "internal",
    packageName: "@platform/example-provider",
    version: "1.0.0",
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    provenance,
  };
  const catalog = parseContract("catalog", {
    schema: "web-doctor.catalog",
    schemaVersion: 1,
    portals: [],
    entries: [{
      id: manifest.id,
      type: manifest.type,
      owner: "web-platform",
      source,
      manifestPath: "web-doctor.json",
      portals: [],
      layers: ["platform"],
      compatibility: manifest.compatibility,
      lifecycle: "active",
      dependencies: [],
    }],
  }) as Catalog;
  const catalogPath = path.join(directory, "catalog.json");
  const ownershipPath = path.join(directory, "ownership.json");
  const lockPath = path.join(directory, "registry.lock.json");
  await fs.writeFile(catalogPath, JSON.stringify(catalog), "utf8");
  await fs.writeFile(ownershipPath, JSON.stringify({
    schema: "web-doctor.registry-ownership",
    schemaVersion: 1,
    platformReviewTeam: "@platform/web-doctor",
    owners: [{
      id: "web-platform",
      name: "Web Platform",
      codeownersTeam: "@platform/web",
      namespaces: ["platform"],
      portals: [],
    }],
  }), "utf8");
  await writeContributionLock(
    lockPath,
    generateContributionLock(catalog, new Map([[
      manifest.id,
      { digest: digestDocument(manifest).digest, contractVersion: 1 },
    ]])),
  );

  return {
    catalogPath,
    ownershipPath,
    lockPath,
    contributionsRoot: path.join(directory, "contributions"),
    artifactPath,
    artifactDigest,
  };
}