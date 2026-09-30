import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCatalogProposal } from "../../src/authoring/catalog-proposal.js";
import { startInternalRegistry, type InternalRegistryFixture } from "../support/internal-registry.js";

const temporaryDirectories: string[] = [];
const registries: InternalRegistryFixture[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("post-publication catalog proposal", () => {
  it("resolves exact integrity idempotently without overwriting reviewed state", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-proposal-"));
    temporaryDirectories.push(directory);
    const registry = await startInternalRegistry([
      packageFixture("1.0.0", "a".repeat(40)),
      packageFixture("2.0.0", "b".repeat(40)),
    ]);
    registries.push(registry);
    const catalogPath = path.join(directory, "catalog.json");
    const outputPath = path.join(directory, "candidate", "catalog.json");
    await fs.writeFile(catalogPath, JSON.stringify({
      schema: "web-doctor.catalog",
      schemaVersion: 1,
      portals: [],
      entries: [{
        id: "firm/example",
        type: "policy",
        owner: "fixture-team",
        source: registry.source("@firm/example", "1.0.0"),
        manifestPath: "web-doctor.json",
        portals: [],
        layers: ["firmwide"],
        compatibility: { webDoctor: ">=0.1.0" },
        lifecycle: "active",
        dependencies: [],
      }],
    }), "utf8");
    const original = await fs.readFile(catalogPath);
    const options = {
      catalogPath,
      outputPath,
      contributionId: "firm/example",
      packageName: "@firm/example",
      version: "2.0.0",
      repository: "ssh://git.internal/firm/example.git",
      commit: "b".repeat(40),
      registry: registry.registry,
      cache: registry.cache,
      allowInsecureRegistry: true,
    };

    const first = await prepareCatalogProposal(options);
    const firstBytes = await fs.readFile(outputPath);
    const second = await prepareCatalogProposal(options);

    expect(await fs.readFile(outputPath)).toEqual(firstBytes);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ version: "2.0.0", requiresPlatformReview: true, changed: true });
    expect(first.integrity).toBe(registry.source("@firm/example", "2.0.0").integrity);
    expect(await fs.readFile(catalogPath)).toEqual(original);
    await expect(prepareCatalogProposal({ ...options, outputPath: catalogPath })).rejects.toThrow(/separate output path/);
  });
});

function packageFixture(version: string, commit: string) {
  return {
    name: "@firm/example",
    version,
    commit,
    files: {
      "web-doctor.json": JSON.stringify({
        schema: "web-doctor.contribution",
        schemaVersion: 1,
        id: "firm/example",
        type: "policy",
        owner: "Fixture Team",
        compatibility: { webDoctor: ">=0.1.0" },
        portals: [],
        layers: ["firmwide"],
        documents: [{ kind: "policy", path: "policy.json" }],
        runtimeArtifacts: [],
        dependencies: [],
        fixtures: ["fixture.json"],
        provenance: { repository: "ssh://git.internal/firm/example.git", commit },
      }),
    },
  };
}