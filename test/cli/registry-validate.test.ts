import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestDocument, parseContract, type Catalog } from "../../src/contracts/index.js";
import { runCli } from "../../src/cli-app.js";
import { generateContributionLock, writeContributionLock } from "../../src/registry/lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("web-doctor registry validate", () => {
  it("emits human and JSON success with exit code 0", async () => {
    const fixture = await buildFixture();
    const human = await invoke(fixture.args);
    const json = await invoke([...fixture.args, "--json"]);

    expect(human).toMatchObject({ exitCode: 0, stderr: "" });
    expect(human.stdout).toBe("Registry valid: 1 contributions\n");
    expect(JSON.parse(json.stdout)).toMatchObject({ valid: true, contributions: 1, issues: [] });
  });

  it("aggregates validation failures with exit code 2", async () => {
    const fixture = await buildFixture();
    const manifestPath = path.join(fixture.contributionsRoot, "firm", "accessibility", "web-doctor.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.fixtures = ["fixtures/missing.json"];
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const result = await invoke([...fixture.args, "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining(["manifest_digest", "missing_package_file"]),
    );
  });

  it("returns exit code 1 for invalid invocation", async () => {
    expect(await invoke(["registry", "validate", "--unknown", "value"])).toMatchObject({
      exitCode: 1,
      stdout: "",
    });
  });
});

async function buildFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-cli-"));
  temporaryDirectories.push(directory);
  const contributionsRoot = path.join(directory, "contributions");
  const contributionRoot = path.join(contributionsRoot, "firm", "accessibility");
  await fs.mkdir(path.join(contributionRoot, "fixtures"), { recursive: true });

  const source = {
    schema: "web-doctor.npm-source",
    schemaVersion: 1,
    registry: "internal",
    packageName: "@firm/accessibility-policy",
    version: "1.0.0",
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    provenance: { repository: "ssh://git.internal/firm/accessibility.git", commit: "c".repeat(40) },
  } as const;
  const entry = {
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
  } as const;
  const catalog = parseContract("catalog", {
    schema: "web-doctor.catalog",
    schemaVersion: 1,
    portals: [],
    entries: [entry],
  }) as Catalog;
  const ownership = {
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
  };
  const policy = {
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
  };
  const manifest = {
    schema: "web-doctor.contribution",
    schemaVersion: 1,
    id: entry.id,
    type: entry.type,
    owner: "Enterprise Accessibility",
    compatibility: entry.compatibility,
    portals: [],
    layers: ["firmwide"],
    documents: [{ kind: "policy", path: "policy.json" }],
    runtimeArtifacts: [],
    dependencies: [],
    fixtures: ["fixtures/policy.json"],
    provenance: source.provenance,
  };
  await fs.writeFile(path.join(contributionRoot, "web-doctor.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(contributionRoot, "policy.json"), JSON.stringify(policy), "utf8");
  await fs.writeFile(path.join(contributionRoot, "fixtures", "policy.json"), JSON.stringify({
    schema: "web-doctor.fixture",
    schemaVersion: 1,
    id: "policy/accept",
    contract: "policyPack",
    input: "policy.json",
    expected: "accept",
  }), "utf8");

  const catalogPath = path.join(directory, "catalog.json");
  const ownershipPath = path.join(directory, "ownership.json");
  const lockPath = path.join(directory, "registry.lock.json");
  await fs.writeFile(catalogPath, JSON.stringify(catalog), "utf8");
  await fs.writeFile(ownershipPath, JSON.stringify(ownership), "utf8");
  await writeContributionLock(
    lockPath,
    generateContributionLock(catalog, new Map([[entry.id, { digest: digestDocument(manifest).digest, contractVersion: 1 }]])),
  );

  return {
    contributionsRoot,
    args: [
      "registry", "validate",
      "--catalog", catalogPath,
      "--ownership", ownershipPath,
      "--lock", lockPath,
      "--contributions", contributionsRoot,
    ],
  };
}

async function invoke(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { exitCode, stdout, stderr };
}