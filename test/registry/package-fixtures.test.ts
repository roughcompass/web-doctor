import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ssri from "ssri";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseContract,
  type Catalog,
  type RegistryOwnership,
} from "../../src/contracts/index.js";
import { readInternalNpmArtifact } from "../../src/registry/npm-artifact.js";
import { validateCatalog } from "../../src/registry/validate.js";
import {
  startInternalRegistry,
  type InternalRegistryFixture,
} from "../support/internal-registry.js";

const NAME = "@fixture/policy";
const MARKER = path.join(os.tmpdir(), `web-doctor-preinstall-${process.pid}`);
const validManifest = (id: string) => JSON.stringify({
  schema: "web-doctor.contribution",
  schemaVersion: 1,
  id,
  type: "policy",
  owner: "Fixture Team",
  compatibility: { webDoctor: ">=0.1.0" },
  portals: [],
  layers: ["firmwide"],
  documents: [{ kind: "policy", path: "policy.json" }],
  runtimeArtifacts: [],
  dependencies: [],
  fixtures: ["fixtures/policy.json"],
  provenance: { repository: "ssh://git.internal/fixture/policy.git", commit: "c".repeat(40) },
});

describe("internal registry package fixtures", () => {
  let registry: InternalRegistryFixture;

  beforeEach(async () => {
    await fs.rm(MARKER, { force: true });
    registry = await startInternalRegistry([
      packageFixture(NAME, "1.0.0", validManifest("fixture/new")),
      packageFixture(NAME, "2.0.0", validManifest("fixture/updated")),
      packageFixture("@fixture/deprecated", "1.0.0", validManifest("fixture/deprecated")),
      packageFixture("@fixture/retired", "1.0.0", validManifest("fixture/retired")),
      packageFixture("@fixture/scripted", "1.0.0", validManifest("fixture/scripted"), {
        preinstall: `node -e "require('fs').writeFileSync('${MARKER}', 'ran')"`,
      }),
      packageFixture("@fixture/malicious", "1.0.0", JSON.stringify({
        ...JSON.parse(validManifest("fixture/malicious")),
        documents: [{ kind: "policy", path: "../outside.json" }],
      })),
    ]);
  });

  afterEach(async () => {
    await registry.close();
    await fs.rm(MARKER, { force: true });
  });

  it("retrieves new and updated exact versions as distinct immutable artifacts", async () => {
    const first = await resolve(registry.source(NAME, "1.0.0"));
    const updated = await resolve(registry.source(NAME, "2.0.0"));

    expect(parseContract("contribution", JSON.parse(first))).toMatchObject({ id: "fixture/new" });
    expect(parseContract("contribution", JSON.parse(updated))).toMatchObject({ id: "fixture/updated" });
    expect(registry.source(NAME, "1.0.0").integrity).not.toBe(registry.source(NAME, "2.0.0").integrity);
  });

  it("accepts active, deprecated, and retired package entries", () => {
    const catalog = catalogWith([
      entry("fixture/new", registry.source(NAME, "1.0.0"), "active"),
      entry("fixture/deprecated", registry.source("@fixture/deprecated", "1.0.0"), "deprecated"),
      entry("fixture/retired", registry.source("@fixture/retired", "1.0.0"), "retired"),
    ]);

    expect(validateCatalog(catalog, ownership())).toEqual({ valid: true, issues: [] });
  });

  it("rejects missing, incompatible, and integrity-mismatched packages", async () => {
    const source = registry.source(NAME, "1.0.0");
    await expect(resolve({ ...source, version: "9.9.9" })).rejects.toThrow();
    await expect(resolve({ ...source, integrity: String(ssri.fromData("wrong", { algorithms: ["sha512"] })) })).rejects.toThrow();

    const incompatible = catalogWith([{ ...entry("fixture/new", source, "active"), compatibility: { webDoctor: ">=9" } }]);
    expect(validateCatalog(incompatible, ownership()).issues.map((issue) => issue.code)).toContain("incompatible_web_doctor");
  });

  it("never runs lifecycle scripts and rejects malicious contribution paths", async () => {
    await resolve(registry.source("@fixture/scripted", "1.0.0"));
    await expect(fs.access(MARKER)).rejects.toThrow();

    const malicious = await resolve(registry.source("@fixture/malicious", "1.0.0"));
    expect(() => parseContract("contribution", JSON.parse(malicious))).toThrow(/normalized relative POSIX paths/);
  });

  async function resolve(source: ReturnType<InternalRegistryFixture["source"]>): Promise<string> {
    const result = await readInternalNpmArtifact(source, ["web-doctor.json"], {
      registry: registry.registry,
      cache: registry.cache,
      allowInsecureRegistry: true,
    });
    return result.files.get("web-doctor.json")!.toString("utf8");
  }
});

function packageFixture(name: string, version: string, manifest: string, scripts?: Record<string, string>) {
  return {
    name,
    version,
    ...(scripts === undefined ? {} : { scripts }),
    files: {
      "web-doctor.json": manifest,
      "policy.json": JSON.stringify({
        schema: "web-doctor.policy-pack",
        schemaVersion: 2,
        id: "fixture/policy",
        version: "1.0.0",
        owner: "Fixture Team",
        layer: "firmwide",
        compatibility: { webDoctor: ">=0.1.0" },
        controls: [{
          id: "fixture/policy/control",
          title: "Fixture control",
          rationale: "Exercise package validation.",
          strength: "required",
          applicability: {},
          evidence: [{ provider: "eslint", rule: "fixture/rule", kind: "static", required: true }],
          verification: [{ kind: "test", description: "Run fixture test." }],
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
  };
}

function entry(id: string, source: ReturnType<InternalRegistryFixture["source"]>, lifecycle: "active" | "deprecated" | "retired") {
  return {
    id,
    type: "policy" as const,
    owner: "fixture-team",
    source,
    manifestPath: "web-doctor.json",
    portals: [],
    layers: ["firmwide" as const],
    compatibility: { webDoctor: ">=0.1.0" },
    lifecycle,
    ...(lifecycle === "active" ? {} : { migration: { guidance: `Migrate away from ${id}.` } }),
    dependencies: [],
  };
}

function catalogWith(entries: ReturnType<typeof entry>[]): Catalog {
  return parseContract("catalog", { schema: "web-doctor.catalog", schemaVersion: 1, portals: [], entries }) as Catalog;
}

function ownership(): RegistryOwnership {
  return parseContract("registryOwnership", {
    schema: "web-doctor.registry-ownership",
    schemaVersion: 1,
    platformReviewTeam: "@platform/web-doctor",
    owners: [{
      id: "fixture-team",
      name: "Fixture Team",
      codeownersTeam: "@fixture/team",
      namespaces: ["fixture"],
      portals: [],
    }],
  }) as RegistryOwnership;
}