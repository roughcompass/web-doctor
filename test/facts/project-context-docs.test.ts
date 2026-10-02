import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BUDGETS, type MemoryFile } from "@repo-facts/contract";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WEB_DOCTOR_EXTENSIONS } from "../../src/facts/extensions.js";
import { DEFAULT_INDEX_LIMITS } from "../../src/facts/project-index.js";
import { analyzeProject } from "../../src/facts/project-snapshot.js";
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "../../src/facts/queries.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { DEPENDENCY_DIRECTORIES } from "../../src/facts/working-tree-reader.js";
import { loadGoldenFixture, materialize } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const EXAMPLES = ["spa-root", "spa-orders", "mf-shell", "legacy-portal"];
const temporaryDirectories: string[] = [];
let analyzer: SharedFactsAnalyzer;

interface Expectation {
  category: string;
  key: string;
  state: string;
  value?: unknown;
  reasoning?: string;
}

interface Example {
  example: string;
  fixture: string | null;
  files?: Record<string, string>;
  shared: Expectation[];
  extensions: Expectation[];
  categories: Record<string, string>;
}

beforeAll(async () => {
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("project context documentation", () => {
  it("is linked from the README and covers ownership, provenance, certainty, skips, exclusions, budgets, and examples", async () => {
    const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
    const documentation = await fs.readFile(path.join(ROOT, "docs", "project-context.md"), "utf8");
    expect(readme).toContain("docs/project-context.md");
    for (const heading of ["## Fact Ownership", "## Pinned Detector Provenance", "## Convention-Tolerant Discovery", "## Certainty and Unresolved Values", "## Skipped Inputs", "## Reader Exclusions", "## Budgets", "## Live Updates", "## Examples"]) {
      expect(documentation).toContain(heading);
    }
    for (const extension of WEB_DOCTOR_EXTENSIONS) expect(documentation).toContain(`\`${extension.id}\``);
    for (const example of EXAMPLES) expect(documentation).toContain(`examples/project-context/${example}.json`);
  });

  it("states the budgets and exclusions the code enforces", async () => {
    const documentation = await fs.readFile(path.join(ROOT, "docs", "project-context.md"), "utf8");
    const number = (value: number) => value.toLocaleString("en-US");
    for (const [label, value] of [
      ["Per-file bytes", DEFAULT_BUDGETS.maxBlobBytes],
      ["Files read", DEFAULT_BUDGETS.maxFiles],
      ["Total bytes read", DEFAULT_BUDGETS.maxTotalBytes],
      ["Indexed source files", DEFAULT_INDEX_LIMITS.maxFiles],
      ["Indexed symbols", DEFAULT_INDEX_LIMITS.maxSymbols],
      ["Indexed references", DEFAULT_INDEX_LIMITS.maxReferences],
    ] as const) {
      expect(documentation).toContain(`| ${label} | ${number(value)} |`);
    }
    expect(documentation).toContain(`| Query page | ${DEFAULT_QUERY_LIMIT} (at most ${MAX_QUERY_LIMIT}) |`);
    expect(documentation).toContain(`dependency directories (${DEPENDENCY_DIRECTORIES.map((name) => `\`${name}\``).join(", ")})`);
  });

  for (const name of EXAMPLES) {
    it(`matches the ${name} example against its fixture`, async () => {
      const example = JSON.parse(await fs.readFile(path.join(ROOT, "examples", "project-context", `${name}.json`), "utf8")) as Example;
      expect(example.example).toBe(name);
      const files: Record<string, MemoryFile> = example.fixture === null ? { ...example.files } : (await loadGoldenFixture(example.fixture)).files;
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-docs-")));
      temporaryDirectories.push(root);
      await materialize(root, files);
      const snapshot = await analyzeProject({ root, repositoryRoot: root, analyzer });
      if (snapshot.shared.status !== "complete") throw new Error(`Shared facts are incomplete for ${name}`);
      const document = snapshot.shared.document;
      for (const expected of example.shared) {
        const fact = document.categories[expected.category]?.facts.find((candidate) => candidate.key === expected.key);
        expect(fact, `${name} ${expected.category}/${expected.key}`).toMatchObject(stripKey(expected));
      }
      for (const expected of example.extensions) {
        const fact = snapshot.extensions.categories[expected.category]?.facts.find((candidate) => candidate.key === expected.key);
        expect(fact, `${name} ${expected.category}/${expected.key}`).toMatchObject(stripKey(expected));
      }
      for (const [category, state] of Object.entries(example.categories)) {
        expect(snapshot.extensions.categories[category]?.state, `${name} ${category}`).toBe(state);
      }
    });
  }
});

function stripKey(expected: Expectation): Record<string, unknown> {
  return Object.fromEntries(Object.entries(expected).filter(([name]) => name !== "category"));
}
