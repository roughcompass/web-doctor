import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestDocument,
  parseContract,
  type Catalog,
} from "../../src/contracts/index.js";
import { generateContributionLock } from "../../src/registry/lock.js";
import { compileRegistrySnapshot } from "../../src/registry/snapshot.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("registry snapshot compiler", () => {
  it("emits complete provenance and byte-identical output for identical semantic inputs", async () => {
    const fixture = await buildFixture();
    const first = await compileRegistrySnapshot(fixture);
    const reorderedCatalog: Catalog = {
      ...fixture.catalog,
      entries: [...fixture.catalog.entries].reverse(),
    };
    const reorderedLock = generateContributionLock(reorderedCatalog, fixture.manifests);
    const second = await compileRegistrySnapshot({ ...fixture, catalog: reorderedCatalog, lock: reorderedLock });

    expect(first.canonical).toBe(second.canonical);
    expect(first.digest).toBe(second.digest);
    expect(first.snapshot.policies.map((policy) => policy.id)).toEqual(["firm/a", "wealth/b"]);
    expect(first.snapshot.contributions[0]).toMatchObject({
      id: "firm/a",
      owner: "enterprise-accessibility",
      source: { packageName: "@firm/a", version: "1.0.0" },
      lifecycle: "active",
      compatibility: { webDoctor: ">=0.1.0" },
      portals: [],
      layers: ["firmwide"],
    });
  });
});

async function buildFixture() {
  const contributionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-snapshot-"));
  temporaryDirectories.push(contributionsRoot);
  const entries = [
    entry("firm/a", "enterprise-accessibility", "@firm/a", [], ["firmwide"]),
    entry("wealth/b", "wealth-design-platform", "@wealth/b", ["wealth"], ["portal"]),
  ];
  const catalog = parseContract("catalog", {
    schema: "web-doctor.catalog",
    schemaVersion: 1,
    portals: [{ id: "wealth", lifecycle: "active" }],
    entries,
  }) as Catalog;
  const manifests = new Map<string, { digest: string; contractVersion: number }>();

  for (const catalogEntry of entries) {
    const root = path.join(contributionsRoot, ...catalogEntry.id.split("/"));
    await fs.mkdir(root, { recursive: true });
    const manifest = {
      schema: "web-doctor.contribution",
      schemaVersion: 1,
      id: catalogEntry.id,
      type: "policy",
      owner: catalogEntry.id.startsWith("firm/") ? "Enterprise Accessibility" : "Wealth Design Platform",
      compatibility: catalogEntry.compatibility,
      portals: catalogEntry.portals,
      layers: catalogEntry.layers,
      documents: [{ kind: "policy", path: "policy.json" }],
      runtimeArtifacts: [],
      dependencies: [],
      fixtures: ["fixture.json"],
      provenance: catalogEntry.source.provenance,
    };
    await fs.writeFile(path.join(root, "web-doctor.json"), JSON.stringify(manifest), "utf8");
    await fs.writeFile(path.join(root, "fixture.json"), "{}", "utf8");
    await fs.writeFile(path.join(root, "policy.json"), JSON.stringify({
      schema: "web-doctor.policy-pack",
      schemaVersion: 2,
      id: catalogEntry.id,
      version: "1.0.0",
      owner: manifest.owner,
      layer: catalogEntry.layers[0],
      compatibility: catalogEntry.compatibility,
      controls: [{
        id: `${catalogEntry.id}/control`,
        title: "Fixture control",
        rationale: "Compile deterministic policy content.",
        strength: "required",
        applicability: {},
        evidence: [{ provider: "eslint", rule: "fixture/rule", kind: "static", required: true }],
        verification: [{ kind: "test", description: "Run fixture test." }],
      }],
    }), "utf8");
    manifests.set(catalogEntry.id, { digest: digestDocument(manifest).digest, contractVersion: 1 });
  }

  return {
    catalog,
    lock: generateContributionLock(catalog, manifests),
    manifests,
    contributionsRoot,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: "c".repeat(40),
    catalogCommit: "d".repeat(40),
  };
}

function entry(id: string, owner: string, packageName: string, portals: string[], layers: ("firmwide" | "portal")[]) {
  return {
    id,
    type: "policy" as const,
    owner,
    source: {
      schema: "web-doctor.npm-source" as const,
      schemaVersion: 1 as const,
      registry: "internal" as const,
      packageName,
      version: "1.0.0",
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      provenance: { repository: `ssh://git.internal/${id}.git`, commit: "c".repeat(40) },
    },
    manifestPath: "web-doctor.json",
    portals,
    layers,
    compatibility: { webDoctor: ">=0.1.0" },
    lifecycle: "active" as const,
    dependencies: [],
  };
}