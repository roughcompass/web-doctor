import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryFile } from "@repo-facts/contract";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GuidanceEntry, RegistrySnapshot } from "../../src/contracts/index.js";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { selectGuidance, type GuidanceSelection } from "../../src/guidance/selection.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { representativePolicyPacks } from "../fixtures/policies.js";
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

function guidance(id: string, overrides: Partial<GuidanceEntry> = {}): GuidanceEntry {
  return {
    schema: "web-doctor.guidance-entry", schemaVersion: 1, id, version: "1.0.0", owner: "Web Platform",
    applicability: {}, evidencePrerequisites: ["static"], classification: "risk", explanation: `Guidance ${id}.`,
    alternatives: [], tradeoffs: [], verification: [{ kind: "test", description: "Run the focused tests." }], controls: [],
    ...overrides,
  };
}

const policies = representativePolicyPacks.filter((policy) => policy.layer === "firmwide" || policy.layer === "application");
const registry: RegistrySnapshot = {
  schema: "web-doctor.registry-snapshot", schemaVersion: 2, webDoctorVersion: "0.1.0", webDoctorCommit: "a".repeat(40), catalogCommit: "b".repeat(40), catalogDigest: "c".repeat(64),
  portals: [],
  contributions: policies.map((policy) => ({
    id: policy.id,
    type: "policy" as const,
    owner: "fixture",
    source: { schema: "web-doctor.npm-source" as const, schemaVersion: 1 as const, registry: "internal" as const, packageName: `@fixture/${policy.id.replace("/", "-")}`, version: "1.0.0", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, provenance: { repository: "ssh://git.internal/fixture.git", commit: "d".repeat(40) } },
    manifestPath: "web-doctor.json",
    manifestDigest: "e".repeat(64),
    lifecycle: "active" as const,
    compatibility: { webDoctor: ">=0.1.0" },
    portals: [],
    layers: [policy.layer],
  })),
  policies,
  providers: [],
  guidance: [
    guidance("react/current", { applicability: { capabilities: [{ name: "react", range: ">=18 <19" }] } }),
    guidance("react/legacy", { applicability: { capabilities: [{ name: "react", range: "<18" }] } }),
    guidance("runtime/web", { applicability: { capabilities: [{ name: "web-runtime" }] } }),
    guidance("runtime/node", { applicability: { runtimes: [{ name: "node", range: ">=18" }] } }),
    guidance("hosting/managed", { applicability: { applicationMetadata: { managed: true } } }),
    guidance("accessibility/button-name", { controls: ["firm/accessibility/button-name"] }),
    guidance("content/account-term", { controls: ["application/engineering/account-term"] }),
  ],
};

async function snapshotOf(files: Record<string, MemoryFile>, budgets?: { maxBlobBytes: number; maxFiles: number; maxTotalBytes: number }): Promise<ProjectSnapshot> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-selection-")));
  temporaryDirectories.push(root);
  await materialize(root, files);
  return analyzeProject({ root, repositoryRoot: root, analyzer, ...(budgets === undefined ? {} : { budgets }) });
}

function select(snapshot: ProjectSnapshot, expectedTreeDigest?: string): Record<string, GuidanceSelection> {
  const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry }) });
  return Object.fromEntries(selectGuidance({ registry, snapshot, policy, config: null, ...(expectedTreeDigest === undefined ? {} : { expectedTreeDigest }) }).map((entry) => [entry.guidance, entry]));
}

describe("guidance selection", () => {
  it("applies guidance by installed versions and names the facts it depends on", async () => {
    const selected = select(await snapshotOf((await loadGoldenFixture("npm-workspace")).files));
    expect(selected["react/current"]).toMatchObject({ status: "applicable", dependsOn: [{ kind: "capability", name: "react", value: "18.3.1", certainty: "observed" }] });
    expect(selected["react/legacy"]!.status).toBe("not_applicable");
    expect(selected["runtime/node"]).toMatchObject({ status: "applicable", dependsOn: [{ kind: "runtime", name: "node", value: ">=20.0.0 <21.0.0-0" }] });
  });

  it("leaves guidance unresolved for unknown, conflicting, and unconfigured facts", async () => {
    const npm = select(await snapshotOf((await loadGoldenFixture("npm-workspace")).files));
    expect(npm["runtime/web"]).toMatchObject({ status: "unresolved", unresolved: ["No fact establishes the capability web-runtime"] });
    expect(npm["hosting/managed"]).toMatchObject({ status: "unresolved", unresolved: ["Application metadata managed is not configured"] });
    const yarn = select(await snapshotOf((await loadGoldenFixture("yarn-classic")).files));
    expect(yarn["runtime/node"]).toMatchObject({ status: "unresolved", unresolved: ["The runtime node has conflicting facts"] });
  });

  it("leaves guidance unresolved when the inputs behind a fact were skipped", async () => {
    const manifest = JSON.stringify({ name: "large", dependencies: { react: "18.3.1" }, description: "x".repeat(400) });
    const selected = select(await snapshotOf({ "package.json": manifest }, { maxBlobBytes: 200, maxFiles: 100, maxTotalBytes: 100_000 }));
    expect(selected["react/current"]).toMatchObject({ status: "unresolved", unresolved: [expect.stringContaining("is unknown because inputs were skipped: package.json")] });
  });

  it("leaves fact-dependent guidance unresolved when facts are stale or unavailable", async () => {
    const snapshot = await snapshotOf((await loadGoldenFixture("npm-workspace")).files);
    const stale = select(snapshot, "0".repeat(64));
    expect(stale["react/current"]).toMatchObject({ status: "unresolved", unresolved: ["The project facts are stale: they describe a different working tree than the one asked about"] });
    expect(stale["accessibility/button-name"]!.status).toBe("applicable");
    const unavailable = select({ ...snapshot, shared: { status: "incomplete", reason: "release_unavailable", problems: ["@repo-facts/core installed files differ from the recorded release"] } });
    expect(unavailable["react/current"]).toMatchObject({ status: "unresolved", unresolved: ["Shared repository facts are unavailable: release_unavailable"] });
  });

  it("marks guidance mandatory only when an effective required Control requires it", async () => {
    const selected = select(await snapshotOf((await loadGoldenFixture("npm-workspace")).files));
    expect(selected["accessibility/button-name"]).toMatchObject({ mandatory: true, controls: ["firm/accessibility/button-name"] });
    expect(selected["content/account-term"]).toMatchObject({ mandatory: false, controls: ["application/engineering/account-term"] });
    expect(selected["react/current"]!.mandatory).toBe(false);
  });
});
