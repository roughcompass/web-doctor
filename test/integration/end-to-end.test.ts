import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContributionLock, DiagnosticsReport, EffectivePolicySnapshot, PolicyPack } from "../../src/contracts/index.js";
import { prepareCatalogProposal } from "../../src/authoring/catalog-proposal.js";
import { packContribution } from "../../src/authoring/contribution-package.js";
import { validatePolicyAuthoring } from "../../src/authoring/policy.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import { buildRegistryReleaseArtifacts } from "../../src/registry/release.js";
import { connectClient } from "../support/mcp-client.js";
import { startInternalRegistry, type InternalRegistryFixture } from "../support/internal-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";

/**
 * One contribution's whole path: author and validate three policy packages,
 * pack and publish them to the internal registry, register each exact version
 * and integrity through a catalog proposal, regenerate the lock and embedded
 * snapshot, then resolve two portals, run ESLint, and read the finding over
 * MCP. Every answer must cite the package, registry, contribution, integrity,
 * source commit, and policy digests it came from.
 */

const COMMITS = { "firm/code": "1".repeat(40), "wealth/brand": "2".repeat(40), "advisor/content": "3".repeat(40) } as const;
type Id = keyof typeof COMMITS;

const verification = [{ kind: "eslint", description: "Run the rule on the changed files." }];
const POLICIES: Record<Id, PolicyPack> = {
  "firm/code": { schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/code", version: "1.1.0", owner: "Enterprise Engineering", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" }, controls: [{ id: "firm/code/no-debugger", title: "No debugger statements", rationale: "Debugger statements halt production pages", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], remediation: "Remove the debugger statement.", verification }] },
  "wealth/brand": { schema: "web-doctor.policy-pack", schemaVersion: 2, id: "wealth/brand", version: "1.1.0", owner: "Wealth Design", layer: "portal", compatibility: { webDoctor: ">=0.1.0" }, controls: [{ id: "wealth/brand/no-debugger-in-wealth", title: "Wealth pages ship without debugger statements", rationale: "Wealth release review", strength: "recommended", applicability: { portals: { anyOf: ["wealth"] } }, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], verification }] },
  "advisor/content": { schema: "web-doctor.policy-pack", schemaVersion: 2, id: "advisor/content", version: "1.1.0", owner: "Advisor Experience", layer: "portal", compatibility: { webDoctor: ">=0.1.0" }, controls: [{ id: "advisor/content/no-console", title: "Advisor pages do not log to the console", rationale: "Console output leaks client data", strength: "required", applicability: { portals: { anyOf: ["advisor"] } }, evidence: [{ provider: "eslint", rule: "no-console", kind: "static", required: true }], verification }] },
};
const PACKAGES: Record<Id, string> = { "firm/code": "@firm/code-policy", "wealth/brand": "@wealth/brand-policy", "advisor/content": "@advisor/content-policy" };
const PORTALS: Record<Id, string[]> = { "firm/code": [], "wealth/brand": ["wealth"], "advisor/content": ["advisor"] };

let workspace: string;
let registry: InternalRegistryFixture;
let generatedRoot: string;
let lock: ContributionLock;
let app: string;
const packed: Record<string, { integrity: string; version: string }> = {};

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-end-to-end-")));
  const tarballs: { name: string; version: string; tarball: Buffer; files: Record<string, string>; commit: string }[] = [];
  for (const id of Object.keys(POLICIES) as Id[]) {
    const source = path.join(workspace, "sources", ...id.split("/"));
    const policy = POLICIES[id];
    await materialize(source, {
      "package.json": `${JSON.stringify({ name: PACKAGES[id], version: policy.version })}\n`,
      "web-doctor.json": `${JSON.stringify({ schema: "web-doctor.contribution", schemaVersion: 1, id, type: "policy", owner: policy.owner, compatibility: { webDoctor: ">=0.1.0" }, portals: PORTALS[id], layers: [policy.layer], documents: [{ kind: "policy", path: "policy.json" }], runtimeArtifacts: [], dependencies: [], fixtures: ["fixtures/accept.json"], provenance: { repository: `ssh://git.internal/${id}.git`, commit: COMMITS[id] } })}\n`,
      "policy.json": `${JSON.stringify(policy)}\n`,
      "fixtures/accept.json": `${JSON.stringify({ schema: "web-doctor.fixture", schemaVersion: 1, id: "accept", contract: "policyPack", input: "policy.json", expected: "accept" })}\n`,
    });
    const validation = await validatePolicyAuthoring({ policyPath: path.join(source, "policy.json"), fixturePaths: [path.join(source, "fixtures/accept.json")] });
    expect(validation, id).toMatchObject({ valid: true, issues: [] });
    const result = await packContribution({ root: source, outputDirectory: path.join(workspace, "packed") });
    packed[id] = { integrity: result.integrity, version: result.version };
    tarballs.push({ name: result.packageName, version: result.version, tarball: await fs.readFile(path.join(workspace, "packed", result.filename)), files: {}, commit: COMMITS[id] });
  }
  registry = await startInternalRegistry(tarballs);

  const catalogPath = path.join(workspace, "registry", "catalog.json");
  const ownershipPath = path.join(workspace, "registry", "ownership.json");
  await materialize(path.join(workspace, "registry"), {
    "catalog.json": `${JSON.stringify({
      schema: "web-doctor.catalog",
      schemaVersion: 1,
      portals: [{ id: "advisor", lifecycle: "active" }, { id: "wealth", lifecycle: "active" }],
      entries: (Object.keys(POLICIES) as Id[]).map((id) => ({
        id, type: "policy", owner: id.split("/")[0], manifestPath: "web-doctor.json", portals: PORTALS[id], layers: [POLICIES[id].layer], compatibility: { webDoctor: ">=0.1.0" }, lifecycle: "active", dependencies: [],
        // The version before this release; the proposal below replaces it with the published one.
        source: { schema: "web-doctor.npm-source", schemaVersion: 1, registry: "internal", packageName: PACKAGES[id], version: "1.0.0", integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`, provenance: { repository: `ssh://git.internal/${id}.git`, commit: "0".repeat(40) } },
      })),
    })}\n`,
    "ownership.json": `${JSON.stringify({
      schema: "web-doctor.registry-ownership", schemaVersion: 1, platformReviewTeam: "@platform/web-doctor",
      owners: [
        { id: "firm", name: "Enterprise Engineering", codeownersTeam: "@firm/engineering", namespaces: ["firm"], portals: [] },
        { id: "wealth", name: "Wealth Design", codeownersTeam: "@wealth/design", namespaces: ["wealth"], portals: ["wealth"] },
        { id: "advisor", name: "Advisor Experience", codeownersTeam: "@advisor/experience", namespaces: ["advisor"], portals: ["advisor"] },
      ],
    })}\n`,
  });
  for (const id of Object.keys(POLICIES) as Id[]) {
    const proposal = await prepareCatalogProposal({ catalogPath, outputPath: catalogPath.replace(".json", ".proposed.json"), contributionId: id, packageName: PACKAGES[id], version: POLICIES[id].version, repository: `ssh://git.internal/${id}.git`, commit: COMMITS[id], registry: registry.registry, cache: registry.cache, allowInsecureRegistry: true });
    expect(proposal).toMatchObject({ integrity: packed[id]!.integrity, requiresPlatformReview: true, changed: true });
    // Platform review accepts the proposal into the catalog.
    await fs.rename(catalogPath.replace(".json", ".proposed.json"), catalogPath);
  }

  const lockPath = path.join(workspace, "registry", "registry.lock.json");
  generatedRoot = path.join(workspace, "generated", "registry");
  await buildRegistryReleaseArtifacts({ catalogPath, ownershipPath, lockPath, generatedRoot, resolver: { registry: registry.registry, cache: registry.cache, allowInsecureRegistry: true }, webDoctorVersion: "0.1.0", webDoctorCommit: "a".repeat(40), catalogCommit: "b".repeat(40) });
  lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as ContributionLock;

  app = path.join(workspace, "app");
  await materialize(app, {
    "package.json": `${JSON.stringify({ name: "advisor-wealth", private: true, dependencies: { react: "18.3.1" } }, null, 2)}\n`,
    "web-doctor.config.json": `${JSON.stringify({ schema: "web-doctor.repository-config", schemaVersion: 1, portals: ["advisor", "wealth"] })}\n`,
    "src/Summary.jsx": "export function Summary() {\n  debugger;\n  console.log(\"summary\");\n  return <section />;\n}\n",
  });
}, 180_000);

afterAll(async () => {
  await registry?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("contribution to finding", () => {
  it("locks each exact published version and integrity", () => {
    expect(lock.contributions.map((entry) => [entry.id, entry.source.packageName, entry.source.version, entry.source.integrity, entry.source.provenance.commit]).sort()).toEqual(
      (Object.keys(POLICIES) as Id[]).map((id) => [id, PACKAGES[id], "1.1.0", packed[id]!.integrity, COMMITS[id]]).sort(),
    );
  });

  it("resolves two portals, runs ESLint, and explains the finding over MCP with complete provenance", async () => {
    const core = await WebDoctor.open({ cwd: app, caller: "mcp", registryRoot: generatedRoot, watch: false });
    const mcp = await connectClient(core);
    try {
      const guidance = await mcp.call("effective_guidance");
      const policy = (guidance.data as { policy: EffectivePolicySnapshot }).policy;
      expect(policy.portals).toEqual(["advisor", "wealth"]);
      expect(policy.controls.map((entry) => entry.control.id)).toEqual(["advisor/content/no-console", "firm/code/no-debugger", "wealth/brand/no-debugger-in-wealth"]);
      for (const entry of policy.contributions) {
        const id = entry.id as Id;
        expect(entry.source).toEqual({ schema: "web-doctor.npm-source", schemaVersion: 1, registry: "internal", packageName: PACKAGES[id], version: "1.1.0", integrity: packed[id]!.integrity, provenance: { repository: `ssh://git.internal/${id}.git`, commit: COMMITS[id] } });
      }

      const diagnostics = await mcp.call("run_diagnostics");
      const report = diagnostics.data as DiagnosticsReport;
      expect(report.findings.map((finding) => [finding.rule, finding.controls])).toEqual(expect.arrayContaining([
        ["no-debugger", ["firm/code/no-debugger", "wealth/brand/no-debugger-in-wealth"]],
        ["no-console", ["advisor/content/no-console"]],
      ]));
      const finding = report.findings.find((candidate) => candidate.rule === "no-debugger")!;
      const explained = await mcp.call("explain_finding", { finding: finding.id });

      for (const response of [guidance, diagnostics, explained]) {
        expect(response.provenance.webDoctor).toMatchObject({ version: "0.1.0", commit: "a".repeat(40), catalogCommit: "b".repeat(40), registryDigest: core.build.registryDigest });
        expect(response.provenance.policy!.digest).toBe(policy.digest);
        expect(response.provenance.repoFacts).toMatchObject({ status: "complete", factDocumentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      }
      expect(report).toMatchObject({ policyDigest: policy.digest, registryDigest: core.build.registryDigest });
      const data = explained.data as { finding: DiagnosticsReport["findings"][number] };
      expect(data.finding).toMatchObject({ id: finding.id, policyDigest: policy.digest, registryDigest: core.build.registryDigest });
      expect(data.finding.obligations.map((obligation) => [obligation.control, obligation.layer, obligation.contribution])).toEqual([
        ["firm/code/no-debugger", "firmwide", "firm/code"],
        ["wealth/brand/no-debugger-in-wealth", "portal", "wealth/brand"],
      ]);
      const build = await mcp.call("build_provenance");
      expect((build.data as { contributions: { id: string; packageName: string; version: string; integrity: string; commit?: string; repository?: string }[] }).contributions.map((entry) => [entry.id, entry.packageName, entry.version, entry.integrity]).sort()).toEqual(
        (Object.keys(POLICIES) as Id[]).map((id) => [id, PACKAGES[id], "1.1.0", packed[id]!.integrity]).sort(),
      );
    } finally {
      await mcp.close();
      await core.close();
    }
  }, 120_000);
});
