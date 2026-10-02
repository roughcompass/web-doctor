import child_process from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DETECTOR_RELEASE, detectorConfiguration } from "@repo-facts/bundle";
import { DEFAULT_BUDGETS, type FactDocument, type SourceReader } from "@repo-facts/contract";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer, acceptSharedDocument, provenanceFor, type SharedFactsComplete } from "../../src/facts/shared-facts.js";
import { WorkingTreeListing } from "../../src/facts/working-tree-reader.js";
import { goldenFixtureNames, loadGoldenFixture, materialize, storedDocument } from "../support/repo-facts-fixtures.js";
import { installTraps, withTraps } from "../support/traps.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];
let analyzer: SharedFactsAnalyzer;

beforeAll(async () => {
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("pinned shared detector release", () => {
  it("verifies the installed release before analysis", () => {
    expect(analyzer.availability.status).toBe("available");
  });

  it("traps every network, process, and code-loading channel it guards", () => {
    const traps = installTraps();
    try {
      expect(() => net.connect(80, "example.test")).toThrow("trap: net.connect");
      expect(() => child_process.spawn("true")).toThrow("trap: child_process.spawn");
      expect(() => globalThis.fetch("https://example.test")).toThrow("trap: fetch");
    } finally {
      traps.restore();
    }
    expect(traps.attempts).toEqual(["net.connect", "child_process.spawn", "fetch"]);
  });

  it("covers every vendored golden fixture", async () => {
    expect(await goldenFixtureNames()).toHaveLength(14);
  });

  for (const name of ["analytics-client", "analytics-consumer", "federation-shell", "hostile-repository", "javascript-app", "legacy-portal", "npm-workspace", "orders-testbed", "pnpm-typescript", "salt-application", "scss-stylesheets", "single-spa-root", "typescript-library", "yarn-classic"]) {
    it(`reproduces the ${name} golden document through the working tree with network and processes denied`, async () => {
      const fixture = await loadGoldenFixture(name);
      const root = await temporary();
      const sentinels = await temporary();
      await materialize(root, fixture.files);
      const previousSentinel = process.env.REPO_FACTS_SENTINEL_DIR;
      process.env.REPO_FACTS_SENTINEL_DIR = sentinels;
      try {
        const { result, attempts } = await withTraps(async () => {
          const listing = await WorkingTreeListing.scan({ root, repositoryRoot: root });
          return analyzer.analyze(listing.open(fixture.budgets));
        });
        expect(attempts).toEqual([]);
        expect(await fs.readdir(sentinels)).toEqual([]);
        expect(result.status).toBe("complete");
        const complete = result as SharedFactsComplete;
        expect(storedDocument(complete.document)).toBe(fixture.expected);
        expect(complete.document.commit).toBeNull();
        expect(Object.isFrozen(complete.document.categories)).toBe(true);
      } finally {
        if (previousSentinel === undefined) delete process.env.REPO_FACTS_SENTINEL_DIR;
        else process.env.REPO_FACTS_SENTINEL_DIR = previousSentinel;
      }
    });
  }

  it("reports release, configuration, parser, diagnostics, skipped inputs, usage, and document digest", async () => {
    const fixture = await loadGoldenFixture("hostile-repository");
    const root = await temporary();
    await materialize(root, fixture.files);
    const reader = (await WorkingTreeListing.scan({ root, repositoryRoot: root })).open();
    const result = await analyzer.analyze(reader) as SharedFactsComplete;
    expect(result.provenance).toMatchObject({
      detectorRelease: DETECTOR_RELEASE,
      configurationDigest: detectorConfiguration(DEFAULT_BUDGETS).digest,
      parser: { name: "typescript" },
      limits: DEFAULT_BUDGETS,
    });
    expect(result.provenance.packages.map((entry) => entry.name)).toContain("@repo-facts/bundle");
    expect(result.documentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.usage).toEqual(reader.usage());
    expect(result.usage).toEqual({ files: result.document.inventory.files_read, bytes: result.document.inventory.bytes_read });
    expect(result.diagnostics).toBe(result.document.diagnostics);
    expect(result.skippedInputs.map((input) => `${input.reason}:${input.path}`)).toEqual(expect.arrayContaining([
      "parse_failed:.github/workflows/bomb.yml",
      "syntax_depth_limit:src/deep.ts",
    ]));
    expect(result.incompleteCategories.length).toBeGreaterThan(0);
  });

  it("returns the design-system categories unchanged, with the pinned release's provenance", async () => {
    const fixture = await loadGoldenFixture("salt-application");
    const root = await temporary();
    await materialize(root, fixture.files);
    const result = await analyzer.analyze((await WorkingTreeListing.scan({ root, repositoryRoot: root })).open(fixture.budgets)) as SharedFactsComplete;
    expect(result.status).toBe("complete");
    const expected = JSON.parse(fixture.expected) as FactDocument;
    for (const category of ["design_systems", "ui_elements", "style_values"]) {
      expect(result.document.categories[category], category).toEqual(expected.categories[category]);
    }
    expect(result.document.categories.design_systems!.facts.map((fact) => fact.key)).toEqual(["salt"]);
    expect(result.provenance.detectorRelease).toBe(DETECTOR_RELEASE);
    expect(result.provenance.packages.map((entry) => entry.name)).toContain("@repo-facts/design-system");
  });

  it("rejects an unsupported fact-document schema, such as the earlier version 1, without reinterpreting it", async () => {
    const { document, provenance } = await sampleDocument();
    const result = acceptSharedDocument({ ...document, schema_version: 1 }, { provenance, usage: { files: 0, bytes: 0 } });
    expect(result).toEqual({
      status: "incomplete",
      reason: "unsupported_schema",
      problems: ["Unsupported fact document repo_facts.fact_document version 1; supported: repo_facts.fact_document version 2"],
      provenance,
    });
    expect(result).not.toHaveProperty("document");
  });

  it("rejects invalid documents, foreign releases, and digest mismatches", async () => {
    const { document, provenance, digest } = await sampleDocument();
    const usage = { files: 0, bytes: 0 };
    expect(acceptSharedDocument({ ...document, evidence: {} }, { provenance, usage })).toMatchObject({ status: "incomplete", reason: "invalid_document" });
    expect(acceptSharedDocument({ ...document, detector_release: "9.9.9" }, { provenance, usage })).toMatchObject({ status: "incomplete", reason: "invalid_document" });
    expect(acceptSharedDocument(document, { provenance, usage, expectedDigest: "0".repeat(64) })).toMatchObject({ status: "incomplete", reason: "invalid_digest" });
    expect(acceptSharedDocument(document, { provenance, usage, expectedDigest: digest })).toMatchObject({ status: "complete", documentDigest: digest });
  });

  it("makes shared context incomplete when the pinned release cannot be verified", async () => {
    const release = await recordRepoFactsRelease({ root: ROOT });
    const altered = { ...release, packages: release.packages.map((entry) => (entry.name === "@repo-facts/core" ? { ...entry, contentDigest: "0".repeat(64) } : entry)) };
    const unavailable = await SharedFactsAnalyzer.create({ release: altered });
    expect(unavailable.availability).toEqual({ status: "unavailable", problems: ["@repo-facts/core installed files differ from the recorded release"] });
    const root = await temporary();
    await materialize(root, { "package.json": "{}\n" });
    expect(await unavailable.analyze((await WorkingTreeListing.scan({ root })).open())).toEqual({
      status: "incomplete",
      reason: "release_unavailable",
      problems: ["@repo-facts/core installed files differ from the recorded release"],
    });
    const missing = await SharedFactsAnalyzer.create({ metadataPath: path.join(root, "absent.json") });
    expect(missing.availability.status).toBe("unavailable");
  });

  it("refuses a reader that violates the shared listing contract", async () => {
    const root = await temporary();
    await materialize(root, { "b.json": "{}\n", "a.json": "{}\n" });
    const reader = (await WorkingTreeListing.scan({ root })).open();
    const disordered: SourceReader = Object.create(reader, { entries: { value: [...reader.entries].reverse() } }) as SourceReader;
    expect(await analyzer.analyze(disordered)).toMatchObject({ status: "incomplete", reason: "nonconforming_reader", problems: ["The reader lists a.json out of code-unit order"] });
  });
});

async function sampleDocument(): Promise<{ document: FactDocument; provenance: ReturnType<typeof provenanceFor>; digest: string }> {
  const root = await temporary();
  await materialize(root, { "package.json": '{"name":"sample","dependencies":{"react":"18.3.1"}}\n' });
  const result = await analyzer.analyze((await WorkingTreeListing.scan({ root })).open()) as SharedFactsComplete;
  return { document: JSON.parse(JSON.stringify(result.document)) as FactDocument, provenance: result.provenance, digest: result.documentDigest };
}

async function temporary(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-shared-")));
  temporaryDirectories.push(directory);
  return directory;
}
