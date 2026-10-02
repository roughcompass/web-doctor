import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContributionLock, DiagnosticsReport } from "../../src/contracts/index.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import { buildRegistryReleaseArtifacts, type RegistryReleaseOptions } from "../../src/registry/release.js";
import { installManagedUpdate, readManagedPointer, rollbackManagedUpdate } from "../../src/runtime/managed-updater.js";
import { loadBuildProvenance } from "../../src/runtime/provenance.js";
import { startInternalRegistry, type InternalRegistryFixture } from "../support/internal-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";

/**
 * Rollback drills. A catalog revert selects a retained exact package again
 * and must reproduce the earlier contribution provenance and findings. A
 * managed installation must survive a failed self-upgrade on its current
 * version and roll back to the retained one. Archived findings never change.
 */

let workspace: string;
const registries: InternalRegistryFixture[] = [];

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-rollback-")));
});

afterAll(async () => {
  await Promise.all(registries.map((registry) => registry.close()));
  await fs.rm(workspace, { recursive: true, force: true });
});

function contribution(version: string, commit: string, controls: object[]): Record<string, string> {
  return {
    "web-doctor.json": JSON.stringify({ schema: "web-doctor.contribution", schemaVersion: 1, id: "firm/code", type: "policy", owner: "Enterprise Engineering", compatibility: { webDoctor: ">=0.1.0" }, portals: [], layers: ["firmwide"], documents: [{ kind: "policy", path: "policy.json" }], runtimeArtifacts: [], dependencies: [], fixtures: ["fixtures/policy.json"], provenance: { repository: "ssh://git.internal/firm/code-policy.git", commit } }),
    "policy.json": JSON.stringify({ schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version, owner: "Enterprise Engineering", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" }, controls }),
    "fixtures/policy.json": JSON.stringify({ schema: "web-doctor.fixture", schemaVersion: 1, id: "policy/accept", contract: "policyPack", input: "policy.json", expected: "accept" }),
  };
}

const verification = [{ kind: "eslint", description: "Run the rule." }];
const noDebugger = { id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], remediation: "Remove the debugger statement.", verification };
const noConsole = { id: "firm/code/no-console", title: "No console statements", rationale: "Console output leaks data", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-console", kind: "static", required: true }], verification };

describe("catalog revert drill", () => {
  it("reproduces the earlier contribution provenance and findings, and leaves archived findings unchanged", async () => {
    const registry = await startInternalRegistry([
      { name: "@firm/code-policy", version: "1.0.0", commit: "1".repeat(40), files: contribution("1.0.0", "1".repeat(40), [noDebugger]) },
      { name: "@firm/code-policy", version: "1.1.0", commit: "2".repeat(40), files: contribution("1.1.0", "2".repeat(40), [noDebugger, noConsole]) },
    ]);
    registries.push(registry);
    const directory = path.join(workspace, "catalog-revert");
    const catalogPath = path.join(directory, "catalog.json");
    const ownershipPath = path.join(directory, "ownership.json");
    await materialize(directory, { "ownership.json": JSON.stringify({ schema: "web-doctor.registry-ownership", schemaVersion: 1, platformReviewTeam: "@platform/web-doctor", owners: [{ id: "firm", name: "Enterprise Engineering", codeownersTeam: "@firm/engineering", namespaces: ["firm"], portals: [] }] }) });
    const options = (catalogCommit: string): RegistryReleaseOptions => ({ catalogPath, ownershipPath, lockPath: path.join(directory, "registry.lock.json"), generatedRoot: path.join(directory, "generated", "registry"), resolver: { registry: registry.registry, cache: registry.cache, allowInsecureRegistry: true }, webDoctorVersion: "0.1.0", webDoctorCommit: "a".repeat(40), catalogCommit });
    const release = async (version: "1.0.0" | "1.1.0", catalogCommit: string) => {
      await fs.writeFile(catalogPath, JSON.stringify({ schema: "web-doctor.catalog", schemaVersion: 1, portals: [], entries: [{ id: "firm/code", type: "policy", owner: "firm", source: registry.source("@firm/code-policy", version), manifestPath: "web-doctor.json", portals: [], layers: ["firmwide"], compatibility: { webDoctor: ">=0.1.0" }, lifecycle: "active", dependencies: [] }] }));
      await buildRegistryReleaseArtifacts(options(catalogCommit));
      const lock = JSON.parse(await fs.readFile(options(catalogCommit).lockPath, "utf8")) as ContributionLock;
      const provenance = await loadBuildProvenance({ snapshotPath: path.join(options(catalogCommit).generatedRoot, "snapshot.json") });
      return { lock, provenance };
    };

    const app = path.join(workspace, "catalog-app");
    await materialize(app, { "package.json": '{"name":"orders"}\n', "src/pay.js": "export function pay() {\n  debugger;\n  console.log(\"paid\");\n}\n" });
    const diagnose = async () => {
      const core = await WebDoctor.open({ cwd: app, caller: "cli", registryRoot: options("x").generatedRoot, watch: false });
      try {
        return (await core.diagnose()).report;
      } finally {
        await core.close();
      }
    };

    const first = await release("1.0.0", "b".repeat(40));
    const original = await diagnose();
    const archive = path.join(workspace, "archived-report.json");
    await fs.writeFile(archive, `${JSON.stringify(original, null, 2)}\n`);
    const archived = await fs.readFile(archive);

    const upgraded = await release("1.1.0", "c".repeat(40));
    expect(upgraded.provenance.contributions.map((entry) => entry.version)).toEqual(["1.1.0"]);
    expect((await diagnose()).findings.map((finding) => finding.rule).sort()).toEqual(["no-console", "no-debugger"]);

    const reverted = await release("1.0.0", "d".repeat(40));
    expect(reverted.lock.contributions).toEqual(first.lock.contributions);
    expect(reverted.provenance.contributions).toEqual(first.provenance.contributions);
    expect(reverted.provenance.catalogCommit).toBe("d".repeat(40));
    const after = await diagnose();
    expect(after.findings.map((finding) => [finding.id, finding.fingerprint, finding.controls])).toEqual(original.findings.map((finding) => [finding.id, finding.fingerprint, finding.controls]));

    // The archived report still explains its finding exactly as recorded.
    const core = await WebDoctor.open({ cwd: app, caller: "cli", registryRoot: options("x").generatedRoot, watch: false });
    try {
      const historical = JSON.parse(archived.toString("utf8")) as DiagnosticsReport;
      const explained = await core.explainFinding({ finding: historical.findings[0]!.id, report: historical });
      expect((explained.data as { finding: unknown }).finding).toEqual(historical.findings[0]);
    } finally {
      await core.close();
    }
    expect(await fs.readFile(archive)).toEqual(archived);
  }, 180_000);
});

describe("managed package rollback drill", () => {
  it("keeps serving the current version after a failed self-upgrade, then rolls back to the retained version", async () => {
    // Each fixture release is a self-contained stand-in whose startup self-check really imports it.
    const runtimeModule = (version: string, broken: boolean) => broken
      ? "throw new Error('the release does not start');\n"
      : `export class WebDoctorRuntime { static async create() { return { version: ${JSON.stringify(version)} }; } }\n`;
    const packages = await startInternalRegistry(["1.0.0", "2.0.0", "2.0.1"].map((version) => ({ name: "web-doctor", version, files: { "dist/index.js": runtimeModule(version, version === "2.0.0"), "generated/registry/snapshot.json": "{}" } })));
    registries.push(packages);
    const root = path.join(workspace, "managed");
    const install = (version: string) => installManagedUpdate({ root, source: packages.source("web-doctor", version), registry: packages.registry, cache: packages.cache, allowInsecureRegistry: true });
    const serve = async () => {
      const pointer = (await readManagedPointer(root, "active"))!;
      const module = await import(`${path.join(root, pointer.directory, "dist", "index.js")}?${Date.now()}`) as { WebDoctorRuntime: { create: () => Promise<{ version: string }> } };
      return (await module.WebDoctorRuntime.create()).version;
    };

    await install("1.0.0");
    expect(await serve()).toBe("1.0.0");
    const archive = path.join(workspace, "managed-findings.json");
    await fs.writeFile(archive, JSON.stringify({ findings: ["finding recorded under 1.0.0"] }));
    const archived = await fs.readFile(archive);

    await expect(install("2.0.0")).rejects.toThrow(/does not start/);
    expect(await readManagedPointer(root, "active")).toMatchObject({ version: "1.0.0" });
    expect(await serve()).toBe("1.0.0");

    await install("2.0.1");
    expect(await serve()).toBe("2.0.1");
    expect(await readManagedPointer(root, "previous")).toMatchObject({ version: "1.0.0", integrity: packages.source("web-doctor", "1.0.0").integrity });

    await rollbackManagedUpdate(root);
    expect(await serve()).toBe("1.0.0");
    expect(await readManagedPointer(root, "previous")).toMatchObject({ version: "2.0.1" });
    expect(await fs.readFile(archive)).toEqual(archived);
  }, 120_000);
});
