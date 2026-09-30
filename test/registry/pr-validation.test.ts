import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestDocument,
  parseContract,
  type Catalog,
} from "../../src/contracts/index.js";
import { generateContributionLock, writeContributionLock } from "../../src/registry/lock.js";
import { validateRegistryPullRequest } from "../../src/registry/pr.js";
import { compareRegistryProvenance } from "../../src/registry/provenance.js";
import { startInternalRegistry, type InternalRegistryFixture } from "../support/internal-registry.js";

const temporaryDirectories: string[] = [];
const registries: InternalRegistryFixture[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("registry pull-request validation", () => {
  it("passes only when package contents and checked-in generated lock match", async () => {
    const fixture = await buildFixture();

    const current = await validateRegistryPullRequest(fixture.options);
    expect(current).toMatchObject({
      valid: true,
      issues: [],
      provenance: {
        contributions: [{
          id: "firm/accessibility",
          owner: {
            id: "enterprise-accessibility",
            name: "Enterprise Accessibility",
            codeownersTeam: "@firm/accessibility",
          },
          package: {
            name: "@firm/accessibility-policy",
            version: "1.0.0",
          },
          source: {
            repository: "ssh://git.internal/firm/accessibility-policy.git",
            commit: "c".repeat(40),
          },
          capabilities: [],
          compatibility: { webDoctor: ">=0.1.0" },
          portals: [],
        }],
      },
    });

    const updatedContribution = {
      ...current.provenance!.contributions[0]!,
      package: { ...current.provenance!.contributions[0]!.package, version: "2.0.0" },
      capabilities: ["browser"],
      portals: ["wealth"],
    };
    const changes = compareRegistryProvenance(current.provenance!, {
      digest: "d".repeat(64),
      contributions: [updatedContribution, { ...updatedContribution, id: "wealth/brand" }],
    });
    expect(changes.map((change) => [change.id, change.kind])).toEqual([
      ["firm/accessibility", "updated"],
      ["wealth/brand", "added"],
    ]);

    const staleLock = JSON.parse(await fs.readFile(fixture.options.lockPath, "utf8"));
    staleLock.catalogDigest = "f".repeat(64);
    await fs.writeFile(fixture.options.lockPath, JSON.stringify(staleLock), "utf8");
    const stale = await validateRegistryPullRequest(fixture.options);

    expect(stale.valid).toBe(false);
    expect(stale.issues.map((issue) => issue.code)).toContain("lock_diff");
  });
});

async function buildFixture() {
  const manifest = {
    schema: "web-doctor.contribution",
    schemaVersion: 1,
    id: "firm/accessibility",
    type: "policy",
    owner: "Enterprise Accessibility",
    compatibility: { webDoctor: ">=0.1.0" },
    portals: [],
    layers: ["firmwide"],
    documents: [{ kind: "policy", path: "policy.json" }],
    runtimeArtifacts: [],
    dependencies: [],
    fixtures: ["fixtures/policy.json"],
    provenance: { repository: "ssh://git.internal/firm/accessibility-policy.git", commit: "c".repeat(40) },
  };
  const registry = await startInternalRegistry([{
    name: "@firm/accessibility-policy",
    version: "1.0.0",
    files: {
      "web-doctor.json": JSON.stringify(manifest),
      "policy.json": JSON.stringify({
        schema: "web-doctor.policy-pack",
        schemaVersion: 1,
        id: "firm/accessibility",
        version: "1.0.0",
        owner: "Enterprise Accessibility",
        layer: "firmwide",
        compatibility: { webDoctor: ">=0.1.0" },
        controls: [{
          id: "firm/accessibility/button-name",
          title: "Button names",
          rationale: "Buttons need names.",
          strength: "required",
          applicability: {},
          evidence: [{ provider: "axe", rule: "button-name", kind: "rendered", required: true }],
          verification: [{ kind: "test", description: "Run axe." }],
        }],
      }),
      "fixtures/policy.json": JSON.stringify({
        schema: "web-doctor.fixture",
        schemaVersion: 1,
        id: "policy/accept",
        contract: "policyPack",
        input: "policy.json",
        expected: "accept",
      }),
    },
  }]);
  registries.push(registry);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-pr-test-"));
  temporaryDirectories.push(directory);
  const source = registry.source("@firm/accessibility-policy", "1.0.0");
  const catalog = parseContract("catalog", {
    schema: "web-doctor.catalog",
    schemaVersion: 1,
    portals: [],
    entries: [{
      id: "firm/accessibility",
      type: "policy",
      owner: "enterprise-accessibility",
      source,
      manifestPath: "web-doctor.json",
      portals: [],
      layers: ["firmwide"],
      compatibility: { webDoctor: ">=0.1.0" },
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
      id: "enterprise-accessibility",
      name: "Enterprise Accessibility",
      codeownersTeam: "@firm/accessibility",
      namespaces: ["firm/accessibility"],
      portals: [],
    }],
  }), "utf8");
  await writeContributionLock(
    lockPath,
    generateContributionLock(catalog, new Map([[
      "firm/accessibility",
      { digest: digestDocument(manifest).digest, contractVersion: 1 },
    ]])),
  );

  return {
    options: {
      catalogPath,
      ownershipPath,
      lockPath,
      resolver: { registry: registry.registry, cache: registry.cache, allowInsecureRegistry: true },
    },
  };
}