import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PolicyControl, RegistrySnapshot } from "../../src/contracts/index.js";
import { policyFactsFor } from "../../src/core/policy-facts.js";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { loadGoldenFixture, materialize } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];
let analyzer: SharedFactsAnalyzer;

beforeAll(async () => {
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function registry(applicability: PolicyControl["applicability"][]): RegistrySnapshot {
  return {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 2,
    webDoctorVersion: "0.1.0",
    webDoctorCommit: "a".repeat(40),
    catalogCommit: "b".repeat(40),
    catalogDigest: "d".repeat(64),
    portals: [],
    contributions: [],
    policies: [{
      schema: "web-doctor.policy-pack",
      schemaVersion: 2,
      id: "firm/facts",
      version: "1.0.0",
      owner: "Fixture",
      layer: "firmwide",
      compatibility: { webDoctor: ">=0.1.0" },
      controls: applicability.map((entry, index) => ({
        id: `firm/facts/${index}`,
        title: "Fixture",
        rationale: "Fixture",
        strength: "required",
        applicability: entry,
        evidence: [{ provider: "eslint", rule: "fixture", kind: "static", required: true }],
        verification: [{ kind: "test", description: "Fixture" }],
      })),
    }],
    providers: [],
    guidance: [],
  };
}

async function snapshotOf(name: string): Promise<ProjectSnapshot> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-policy-facts-")));
  temporaryDirectories.push(root);
  await materialize(root, (await loadGoldenFixture(name)).files);
  return analyzeProject({ root, repositoryRoot: root, analyzer });
}

describe("applicability facts from shared repository facts", () => {
  it("derives present, established-absent, and unknown capabilities and dependencies", async () => {
    const snapshot = await snapshotOf("npm-workspace");
    const facts = policyFactsFor(snapshot, registry([
      { capabilities: [{ name: "react" }, { name: "jest" }, { name: "vitest" }, { name: "module-federation" }, { name: "web-runtime" }] },
      { dependencies: [{ name: "react", range: "^18.0.0" }, { name: "left-pad", range: "*" }], runtimes: [{ name: "node", range: ">=18" }] },
    ]), { schema: "web-doctor.repository-config", schemaVersion: 1, applicationMetadata: { managed: true } });
    expect(facts.facts.capabilities).toEqual({ react: "18.3.1", jest: true, vitest: false });
    expect(facts.capabilityCertainty).toEqual({ jest: "observed", "module-federation": "unknown", react: "observed", vitest: "observed", "web-runtime": "unknown" });
    expect(facts.facts.dependencies).toEqual({ react: "18.3.1", "left-pad": false });
    expect(facts.facts.runtimes).toEqual({ node: ">=20.0.0 <21.0.0-0" });
    expect(facts.facts.applicationMetadata).toEqual({ managed: true });
    expect(facts.provenance).toMatchObject({ status: "complete", factDocumentDigest: snapshot.shared.status === "complete" ? snapshot.shared.documentDigest : null, extensionStateDigest: snapshot.extensions.digest });
  });

  it("leaves conflicting runtime declarations and incomplete shared facts unresolved", async () => {
    const snapshot = await snapshotOf("yarn-classic");
    const facts = policyFactsFor(snapshot, registry([{ runtimes: [{ name: "node", range: ">=18" }, { name: "yarn", range: "1.x" }] }]), null);
    expect(facts.facts.runtimes).toEqual({ yarn: "1.22.22" });
    const incomplete = policyFactsFor({ ...snapshot, shared: { status: "incomplete", reason: "release_unavailable", problems: ["missing"] } }, registry([{ capabilities: [{ name: "react" }] }]), null);
    expect(incomplete.facts).toEqual({});
    expect(incomplete.capabilityCertainty).toEqual({ react: "unknown" });
    expect(incomplete.provenance.status).toBe("incomplete");
  });
});
