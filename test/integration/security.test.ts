import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDoctor } from "../../src/core/web-doctor.js";
import { runWorker } from "../../src/diagnostics/worker.js";
import { buildFinding } from "../../src/diagnostics/finding.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer, acceptSharedDocument } from "../../src/facts/shared-facts.js";
import { WorkingTreeListing } from "../../src/facts/working-tree-reader.js";
import { buildRegistryReleaseArtifacts, verifyRegistryReleaseArtifacts, type RegistryReleaseOptions } from "../../src/registry/release.js";
import { approvedRelease } from "../../src/runtime/approved-release.js";
import { loadEmbeddedRegistry } from "../../src/runtime/embedded-registry.js";
import { installManagedUpdate, readManagedPointer } from "../../src/runtime/managed-updater.js";
import { startInternalRegistry, type InternalPackageFixture, type InternalRegistryFixture } from "../support/internal-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";

/**
 * Attacks on every trust boundary, each of which must be refused without
 * changing what is already packaged: the committed lock and embedded
 * registry, the recorded repo-facts release, and the managed active pointer.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const COMMIT = "e".repeat(40);
const TASKS = path.join(ROOT, "test/fixtures/workers/tasks.mjs");

let workspace: string;
const registries: InternalRegistryFixture[] = [];

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-security-")));
});

afterAll(async () => {
  await Promise.all(registries.map((registry) => registry.close()));
  await fs.rm(workspace, { recursive: true, force: true });
});

function contributionFiles(options: { commit?: string; documentPath?: string; scripts?: Record<string, string> } = {}): InternalPackageFixture["files"] {
  const documentPath = options.documentPath ?? "policy.json";
  return {
    "web-doctor.json": JSON.stringify({ schema: "web-doctor.contribution", schemaVersion: 1, id: "firm/example", type: "policy", owner: "Fixture Team", compatibility: { webDoctor: ">=0.1.0" }, portals: [], layers: ["firmwide"], documents: [{ kind: "policy", path: documentPath }], runtimeArtifacts: [], dependencies: [], fixtures: ["fixtures/policy.json"], provenance: { repository: "ssh://git.internal/firm/example.git", commit: options.commit ?? COMMIT } }),
    "policy.json": JSON.stringify({ schema: "web-doctor.policy-pack", schemaVersion: 2, id: "firm/example", version: "1.0.0", owner: "Fixture Team", layer: "firmwide", compatibility: { webDoctor: ">=0.1.0" }, controls: [{ id: "firm/example/no-debugger", title: "No debugger", rationale: "Safety", strength: "required", applicability: {}, evidence: [{ provider: "eslint", rule: "no-debugger", kind: "static", required: true }], verification: [{ kind: "eslint", description: "Run no-debugger." }] }] }),
    "fixtures/policy.json": JSON.stringify({ schema: "web-doctor.fixture", schemaVersion: 1, id: "policy/accept", contract: "policyPack", input: "policy.json", expected: "accept" }),
  };
}

async function releaseFixture(name: string, packages: InternalPackageFixture[]): Promise<{ options: RegistryReleaseOptions; registry: InternalRegistryFixture; writeCatalog: (edit?: (entry: Record<string, unknown>) => Record<string, unknown>) => Promise<void> }> {
  const directory = path.join(workspace, name);
  await fs.mkdir(directory, { recursive: true });
  const registry = await startInternalRegistry(packages);
  registries.push(registry);
  const catalogPath = path.join(directory, "catalog.json");
  const ownershipPath = path.join(directory, "ownership.json");
  const writeCatalog = async (edit: (entry: Record<string, unknown>) => Record<string, unknown> = (entry) => entry) => {
    const entry = { id: "firm/example", type: "policy", owner: "fixture-team", source: registry.source("@firm/example", "1.0.0"), manifestPath: "web-doctor.json", portals: [], layers: ["firmwide"], compatibility: { webDoctor: ">=0.1.0" }, lifecycle: "active", dependencies: [] };
    await fs.writeFile(catalogPath, JSON.stringify({ schema: "web-doctor.catalog", schemaVersion: 1, portals: [], entries: [edit(entry)] }));
  };
  await writeCatalog();
  await fs.writeFile(ownershipPath, JSON.stringify({ schema: "web-doctor.registry-ownership", schemaVersion: 1, platformReviewTeam: "@platform/web-doctor", owners: [{ id: "fixture-team", name: "Fixture Team", codeownersTeam: "@fixture/team", namespaces: ["firm"], portals: [] }] }));
  return {
    registry,
    writeCatalog,
    options: { catalogPath, ownershipPath, lockPath: path.join(directory, "registry.lock.json"), generatedRoot: path.join(directory, "generated", "registry"), resolver: { registry: registry.registry, cache: registry.cache, allowInsecureRegistry: true }, webDoctorVersion: "0.1.0", webDoctorCommit: "c".repeat(40), catalogCommit: "d".repeat(40) },
  };
}

/** Digest of every byte of the committed lock and generated registry. */
async function packagedState(options: RegistryReleaseOptions): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(options.lockPath));
  const walk = async (directory: string) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const full = path.join(directory, entry.name);
      hash.update(path.relative(options.generatedRoot, full));
      if (entry.isDirectory()) await walk(full);
      else hash.update(await fs.readFile(full));
    }
  };
  await walk(options.generatedRoot);
  return hash.digest("hex");
}

describe("release pipeline attacks", () => {
  let fixture: Awaited<ReturnType<typeof releaseFixture>>;
  let baseline: string;

  beforeAll(async () => {
    fixture = await releaseFixture("release", [{ name: "@firm/example", version: "1.0.0", commit: COMMIT, files: contributionFiles() }]);
    await buildRegistryReleaseArtifacts(fixture.options);
    baseline = await packagedState(fixture.options);
  }, 60_000);

  const rejected = async (label: string, attack: () => Promise<unknown>, message: RegExp) => {
    await expect(attack(), label).rejects.toThrow(message);
    expect(await packagedState(fixture.options), `${label} changed packaged state`).toBe(baseline);
    await fixture.writeCatalog();
  };

  it("refuses a substituted package and a mismatched integrity", async () => {
    const substitute = await startInternalRegistry([{ name: "@firm/example", version: "1.0.0", commit: COMMIT, files: { ...contributionFiles(), "extra.txt": "substituted" } }]);
    registries.push(substitute);
    await rejected("substitution", () => buildRegistryReleaseArtifacts({ ...fixture.options, resolver: { registry: substitute.registry, cache: substitute.cache, allowInsecureRegistry: true } }), /integrity/i);
    await fixture.writeCatalog((entry) => ({ ...entry, source: { ...(entry.source as object), integrity: `sha512-${Buffer.alloc(64, 9).toString("base64")}` } }));
    await rejected("integrity mismatch", () => buildRegistryReleaseArtifacts(fixture.options), /integrity/i);
  });

  it("refuses dist-tags, ranges, alternate registries, and path escapes in the catalog", async () => {
    for (const version of ["latest", "^1.0.0", "1.x"]) {
      await fixture.writeCatalog((entry) => ({ ...entry, source: { ...(entry.source as object), version } }));
      await rejected(`version ${version}`, () => buildRegistryReleaseArtifacts(fixture.options), /version|Invalid/i);
    }
    await fixture.writeCatalog((entry) => ({ ...entry, source: { ...(entry.source as object), registry: "public" } }));
    await rejected("public registry source", () => buildRegistryReleaseArtifacts(fixture.options), /internal|Invalid/i);
    await rejected("plain-HTTP registry", () => buildRegistryReleaseArtifacts({ ...fixture.options, resolver: { registry: "http://npm.example.test/" } }), /must use HTTPS/);
    await fixture.writeCatalog((entry) => ({ ...entry, manifestPath: "../web-doctor.json" }));
    await rejected("manifest path escape", () => buildRegistryReleaseArtifacts(fixture.options), /path|Invalid/i);
  });

  it("refuses provenance drift between the catalog and the package manifest", async () => {
    await fixture.writeCatalog((entry) => ({ ...entry, source: { ...(entry.source as object), provenance: { repository: "ssh://git.internal/firm/example.git", commit: "f".repeat(40) } } }));
    await rejected("provenance drift", () => buildRegistryReleaseArtifacts(fixture.options), /provenance does not match/);
  });

  it("refuses a document path that escapes its package", async () => {
    const escaping = await releaseFixture("escape", [{ name: "@firm/example", version: "1.0.0", commit: COMMIT, files: contributionFiles({ documentPath: "../policy.json" }) }]);
    await expect(buildRegistryReleaseArtifacts(escaping.options)).rejects.toThrow();
    await expect(fs.access(escaping.options.lockPath)).rejects.toThrow();
    await expect(fs.access(escaping.options.generatedRoot)).rejects.toThrow();
  });

  it("detects lock drift and generated-tree tampering without rewriting either", async () => {
    await fs.appendFile(fixture.options.lockPath, " ");
    const drifted = await fs.readFile(fixture.options.lockPath);
    await expect(verifyRegistryReleaseArtifacts(fixture.options)).rejects.toThrow(/changed registry\/registry\.lock\.json/);
    expect(await fs.readFile(fixture.options.lockPath)).toEqual(drifted);
    await fs.writeFile(fixture.options.lockPath, drifted.subarray(0, drifted.length - 1));
    expect(await packagedState(fixture.options)).toBe(baseline);
  });

  it("never runs contribution lifecycle scripts while resolving, validating, or embedding", async () => {
    const marker = path.join(workspace, "lifecycle-ran");
    const script = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`;
    const scripted = await releaseFixture("scripts", [{ name: "@firm/example", version: "1.0.0", commit: COMMIT, files: contributionFiles(), scripts: { preinstall: script, install: script, postinstall: script, prepare: script } }]);
    await buildRegistryReleaseArtifacts(scripted.options);
    await expect(fs.access(marker)).rejects.toThrow();
  });
});

describe("embedded registry tampering", () => {
  it("refuses a changed document, changed provenance, or an extra file, and writes nothing", async () => {
    const fixture = await releaseFixture("embedded", [{ name: "@firm/example", version: "1.0.0", commit: COMMIT, files: contributionFiles() }]);
    await buildRegistryReleaseArtifacts(fixture.options);
    const generated = fixture.options.generatedRoot;
    const tamper = async (label: string, edit: (root: string) => Promise<void>, message: RegExp) => {
      const copy = path.join(workspace, `tampered-${crypto.randomUUID()}`);
      await fs.cp(generated, copy, { recursive: true });
      await edit(copy);
      const before = await packagedState({ ...fixture.options, generatedRoot: copy });
      await expect(loadEmbeddedRegistry({ root: copy }), label).rejects.toThrow(message);
      expect(await packagedState({ ...fixture.options, generatedRoot: copy }), label).toBe(before);
      await expect(WebDoctor.open({ cwd: workspace, caller: "cli", registryRoot: copy, watch: false }), label).rejects.toThrow(message);
    };
    const policy = path.join("contributions", "firm", "example", "policy.json");
    const manifest = path.join("contributions", "firm", "example", "web-doctor.json");
    await tamper("document", async (root) => {
      const document = JSON.parse(await fs.readFile(path.join(root, policy), "utf8"));
      document.controls[0].strength = "informational";
      await fs.writeFile(path.join(root, policy), JSON.stringify(document));
    }, /mismatch|do not match/i);
    await tamper("provenance", async (root) => {
      const document = JSON.parse(await fs.readFile(path.join(root, manifest), "utf8"));
      document.provenance.commit = "f".repeat(40);
      await fs.writeFile(path.join(root, manifest), JSON.stringify(document));
    }, /mismatch/i);
    await tamper("extra file", async (root) => fs.writeFile(path.join(root, "contributions", "firm", "example", "payload.js"), "globalThis.pwned = true;"), /unexpected|Unexpected/);
  }, 60_000);
});

describe("shared fact attacks", () => {
  it("treats substituted or mixed repo-facts packages as unavailable facts on every response", async () => {
    const release = await recordRepoFactsRelease({ root: ROOT });
    const recorded = await fs.readFile(path.join(ROOT, "generated", "repo-facts.json"));
    const substituted = { ...release, packages: release.packages.map((entry) => (entry.name === "@repo-facts/core" ? { ...entry, contentDigest: "0".repeat(64) } : entry)) };
    const mixed = { ...release, packages: release.packages.map((entry) => (entry.name === "@repo-facts/contract" ? { ...entry, version: "0.2.0" } : entry)) };
    const app = path.join(workspace, "facts-app");
    await materialize(app, { "package.json": '{"name":"orders","dependencies":{"react":"18.3.1"}}\n' });
    const registry = (await releaseFixture("facts-registry", [{ name: "@firm/example", version: "1.0.0", commit: COMMIT, files: contributionFiles() }]));
    await buildRegistryReleaseArtifacts(registry.options);
    for (const [label, candidate] of [["substituted", substituted], ["mixed", mixed]] as const) {
      const analyzer = await SharedFactsAnalyzer.create({ release: candidate });
      expect(analyzer.availability.status, label).toBe("unavailable");
      const core = await WebDoctor.open({ cwd: app, caller: "mcp", registryRoot: registry.options.generatedRoot, watch: false, analyzer });
      try {
        const response = await core.context({ query: "project_overview" });
        expect(response.provenance.repoFacts.status, label).toBe("unavailable");
        expect(response.complete, label).toBe(false);
        const policy = await core.effectivePolicy();
        expect((policy.data as { policy: { facts: { status: string } } }).policy.facts.status, label).toBe("incomplete");
      } finally {
        await core.close();
      }
    }
    expect(await fs.readFile(path.join(ROOT, "generated", "repo-facts.json"))).toEqual(recorded);
  }, 60_000);

  it("refuses a fact document with an unsupported schema version instead of reinterpreting it", async () => {
    const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
    const root = path.join(workspace, "schema-app");
    await materialize(root, { "package.json": '{"name":"orders"}\n' });
    const result = await analyzer.analyze((await WorkingTreeListing.scan({ root })).open());
    if (result.status !== "complete") throw new Error("expected a complete document");
    const future = acceptSharedDocument({ ...result.document, schema_version: 99 }, { provenance: result.provenance, usage: result.usage });
    expect(future).toMatchObject({ status: "incomplete", reason: "unsupported_schema" });
    expect(future).not.toHaveProperty("document");
  });

  it("refuses a nonconforming reader and never follows a link out of the application", async () => {
    const root = path.join(workspace, "reader");
    await materialize(root, { "b.json": "{}\n", "a.json": "{}\n" });
    const secret = path.join(workspace, "outside-secret.txt");
    await fs.writeFile(secret, "OUTSIDE-SECRET");
    await fs.symlink(secret, path.join(root, "leak.txt"));
    const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
    const reader = (await WorkingTreeListing.scan({ root })).open();
    const disordered = Object.create(reader, { entries: { value: [...reader.entries].reverse() } }) as typeof reader;
    expect(await analyzer.analyze(disordered)).toMatchObject({ status: "incomplete", reason: "nonconforming_reader" });
    const result = await analyzer.analyze(reader);
    expect(JSON.stringify(result)).not.toContain("OUTSIDE-SECRET");
  });
});

describe("provider attacks", () => {
  it("denies undeclared network access and stops a provider that runs too long", async () => {
    const denied = await runWorker({ module: TASKS, export: "connect", input: {} }, { read: [TASKS], network: false }, { timeoutMs: 20_000, memoryMb: 256, outputBytes: 1_000_000 });
    expect(denied.status).toBe("denied");
    const fetched = await runWorker({ module: TASKS, export: "fetchSwallowed", input: {} }, { read: [TASKS], network: false }, { timeoutMs: 20_000, memoryMb: 256, outputBytes: 1_000_000 });
    // A provider that swallows the refusal still has the attempt recorded, so the run reports it.
    expect(fetched).toMatchObject({ denied: ["network"] });
    const hung = await runWorker({ module: TASKS, export: "hang", input: {} }, { read: [TASKS], network: false }, { timeoutMs: 1_000, memoryMb: 256, outputBytes: 1_000_000 });
    expect(hung.status).toBe("timeout");
  }, 60_000);

  it("redacts credentials a provider quotes before they reach a finding", () => {
    const finding = buildFinding({
      provider: { id: "eslint", version: "9.39.5", engine: "eslint", engineVersion: "9.39.5", contribution: null }, rule: "no-restricted-syntax", evidenceKind: "static",
      locations: [{ kind: "source", path: "src/a.ts", line: 1, column: 1, endLine: 1, endColumn: 2 }], severity: "error", certainty: "observed", classification: "defect",
      message: "Found NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789", completeness: "complete", original: {},
    }, { obligations: [], registryDigest: "a".repeat(64), policyDigest: "a".repeat(64) });
    expect(JSON.stringify(finding)).not.toContain("npm_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("managed package attacks", () => {
  let packages: InternalRegistryFixture;
  let managedRoot: string;
  let active: Buffer;

  beforeAll(async () => {
    packages = await startInternalRegistry([
      { name: "web-doctor", version: "9.0.0", files: { "version.txt": "9.0.0" } },
      { name: "web-doctor", version: "9.1.0", files: { "version.txt": "9.1.0" } },
    ]);
    registries.push(packages);
    managedRoot = path.join(workspace, "managed");
    await installManagedUpdate({ root: managedRoot, source: packages.source("web-doctor", "9.1.0"), registry: packages.registry, cache: packages.cache, allowInsecureRegistry: true, selfCheck: async () => {} });
    active = await fs.readFile(path.join(managedRoot, "active.json"));
  }, 60_000);

  it("refuses a downgrade offered as an update", async () => {
    const app = path.join(workspace, "managed-app");
    await materialize(app, { "package.json": "{}\n" });
    const registry = await releaseFixture("managed-registry", [{ name: "@firm/example", version: "1.0.0", commit: COMMIT, files: contributionFiles() }]);
    await buildRegistryReleaseArtifacts(registry.options);
    const core = await WebDoctor.open({ cwd: app, caller: "cli", registryRoot: registry.options.generatedRoot, watch: false, update: { distribution: { packageName: "web-doctor", registry: packages.registry }, installationMode: "managed", managedRoot, lookup: async () => "0.0.1", allowInsecureRegistry: true, selfCheck: async () => {} } });
    try {
      expect((await core.applyUpdate()).data).toMatchObject({ outcome: { status: "current" } });
    } finally {
      await core.close();
    }
    expect(await fs.readFile(path.join(managedRoot, "active.json"))).toEqual(active);
  }, 60_000);

  it("refuses substituted bytes, a wrong integrity, and a plain-HTTP registry without touching the active version", async () => {
    const substitute = await startInternalRegistry([{ name: "web-doctor", version: "9.2.0", files: { "version.txt": "substituted" } }]);
    registries.push(substitute);
    const approved = { ...substitute.source("web-doctor", "9.2.0"), integrity: packages.source("web-doctor", "9.0.0").integrity };
    await expect(installManagedUpdate({ root: managedRoot, source: approved, registry: substitute.registry, cache: substitute.cache, allowInsecureRegistry: true, selfCheck: async () => {} })).rejects.toThrow();
    await expect(installManagedUpdate({ root: managedRoot, source: packages.source("web-doctor", "9.0.0"), registry: "http://npm.example.test/", selfCheck: async () => {} })).rejects.toThrow();
    await expect(approvedRelease({ packageName: "web-doctor", registry: packages.registry }, "9.0.0")).rejects.toThrow(/must use HTTPS/);
    expect(await fs.readFile(path.join(managedRoot, "active.json"))).toEqual(active);
    expect(await readManagedPointer(managedRoot, "active")).toMatchObject({ version: "9.1.0" });
  }, 60_000);
});

describe("approval-gated providers", () => {
  const EXAMPLE = path.join(ROOT, "examples", "react-doctor-provider");

  async function reactDoctorRelease(name: string, edit: (manifest: Record<string, unknown>, rules: string) => { manifest: Record<string, unknown>; rules: string }) {
    const original = JSON.parse(await fs.readFile(path.join(EXAMPLE, "provider.json"), "utf8")) as Record<string, unknown>;
    const edited = edit(original, await fs.readFile(path.join(EXAMPLE, "rules.json"), "utf8"));
    const manifest = { ...edited.manifest, artifacts: [{ path: "rules.json", digest: crypto.createHash("sha256").update(edited.rules).digest("hex") }] };
    const files = {
      "web-doctor.json": JSON.stringify({ schema: "web-doctor.contribution", schemaVersion: 1, id: "react-doctor", type: "provider", owner: "Web Platform", compatibility: { webDoctor: ">=0.1.0" }, portals: [], layers: [], documents: [{ kind: "provider", path: "provider.json" }], runtimeArtifacts: [{ path: "rules.json", digest: manifest.artifacts[0]!.digest }], dependencies: [], fixtures: ["fixtures/provider.json"], provenance: { repository: "ssh://git.internal/react-doctor-provider.git", commit: COMMIT } }),
      "provider.json": JSON.stringify(manifest),
      "rules.json": edited.rules,
      "fixtures/provider.json": JSON.stringify({ schema: "web-doctor.fixture", schemaVersion: 1, id: "provider/accept", contract: "providerManifest", input: "provider.json", expected: "accept" }),
    };
    const directory = path.join(workspace, name);
    await fs.mkdir(directory, { recursive: true });
    const registry = await startInternalRegistry([{ name: "@platform/react-doctor-provider", version: "1.0.0", commit: COMMIT, files }]);
    registries.push(registry);
    const catalogPath = path.join(directory, "catalog.json");
    await fs.writeFile(catalogPath, JSON.stringify({ schema: "web-doctor.catalog", schemaVersion: 1, portals: [], entries: [{ id: "react-doctor", type: "provider", owner: "platform", source: { ...registry.source("@platform/react-doctor-provider", "1.0.0"), provenance: { repository: "ssh://git.internal/react-doctor-provider.git", commit: COMMIT } }, manifestPath: "web-doctor.json", portals: [], layers: [], compatibility: { webDoctor: ">=0.1.0" }, lifecycle: "active", dependencies: [] }] }));
    const ownershipPath = path.join(directory, "ownership.json");
    await fs.writeFile(ownershipPath, JSON.stringify({ schema: "web-doctor.registry-ownership", schemaVersion: 1, platformReviewTeam: "@platform/web-doctor", owners: [{ id: "platform", name: "Web Platform", codeownersTeam: "@platform/web", namespaces: ["react-doctor"], portals: [] }] }));
    return { catalogPath, ownershipPath, lockPath: path.join(directory, "registry.lock.json"), generatedRoot: path.join(directory, "generated", "registry"), resolver: { registry: registry.registry, cache: registry.cache, allowInsecureRegistry: true }, webDoctorVersion: "0.1.0", webDoctorCommit: "c".repeat(40), catalogCommit: "d".repeat(40) };
  }

  it("embeds React Doctor only as the exact approved release with the approved rule set", async () => {
    const approved = await reactDoctorRelease("react-doctor-approved", (manifest, rules) => ({ manifest, rules }));
    await buildRegistryReleaseArtifacts(approved);
    const unapprovedVersion = await reactDoctorRelease("react-doctor-version", (manifest, rules) => ({ manifest: { ...manifest, engineRange: "0.9.15-dev.6313667" }, rules }));
    await expect(buildRegistryReleaseArtifacts(unapprovedVersion)).rejects.toThrow(/requests react-doctor 0\.9\.15-dev\.6313667; approved releases are 0\.9\.14, each pinned exactly/);
    const ranged = await reactDoctorRelease("react-doctor-range", (manifest, rules) => ({ manifest: { ...manifest, engineRange: "^0.9.14" }, rules }));
    await expect(buildRegistryReleaseArtifacts(ranged)).rejects.toThrow(/approved releases are 0\.9\.14, each pinned exactly/);
    const widened = await reactDoctorRelease("react-doctor-rules", (manifest, rules) => {
      const catalog = JSON.parse(rules) as { rules: { key: string; defaultEnabled: boolean }[] };
      catalog.rules[0]!.defaultEnabled = !catalog.rules[0]!.defaultEnabled;
      return { manifest, rules: JSON.stringify(catalog) };
    });
    await expect(buildRegistryReleaseArtifacts(widened)).rejects.toThrow(/rule catalog does not match the approved react-doctor 0\.9\.14 rule set/);
    for (const options of [unapprovedVersion, ranged, widened]) {
      await expect(fs.access(options.lockPath)).rejects.toThrow();
      await expect(fs.access(options.generatedRoot)).rejects.toThrow();
    }
  }, 120_000);
});
