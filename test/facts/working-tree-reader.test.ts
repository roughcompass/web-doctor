import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Budgets, MemoryFile, ReadResult, SourceReader } from "@repo-facts/contract";
import { type ReaderFactory, readerConformanceCases } from "@repo-facts/contract/testing";
import { afterEach, describe, expect, it } from "vitest";
import { WorkingTreeListing, WorkingTreeReader } from "../../src/facts/working-tree-reader.js";
import { loadGoldenFixture, materialize, memoryReaderFor } from "../support/repo-facts-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const factory: ReaderFactory = async (files, options) => {
  const root = await temporary();
  await materialize(root, files);
  const listing = await WorkingTreeListing.scan({ root, repositoryRoot: root, ...(options.protectedDirectories && { protectedDirectories: options.protectedDirectories }) });
  return listing.open(options.budgets);
};

describe("working-tree reader conformance", () => {
  for (const test of readerConformanceCases()) it(test.name, () => test.run(factory));
});

describe("working-tree reader", () => {
  for (const name of ["npm-workspace", "pnpm-typescript", "yarn-classic", "javascript-app", "typescript-library", "hostile-repository"]) {
    it(`reads the ${name} fixture exactly as the reference reader does`, async () => {
      const fixture = await loadGoldenFixture(name);
      await expectEquivalent(fixture.files);
    });
  }

  it("spends truncated budgets in path order with the reference reader's diagnostics", async () => {
    const files: Record<string, MemoryFile> = {
      "package.json": '{"name":"truncated"}\n',
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "x".repeat(300),
      "src/d.ts": "export const d = 4;\n",
    };
    for (const budgets of [
      { maxBlobBytes: 200, maxFiles: 100, maxTotalBytes: 10_000 },
      { maxBlobBytes: 10_000, maxFiles: 2, maxTotalBytes: 10_000 },
      { maxBlobBytes: 10_000, maxFiles: 100, maxTotalBytes: 45 },
    ]) {
      const { candidate, reference } = await expectEquivalent(files, budgets);
      expect(candidate.diagnostics().length, JSON.stringify(budgets)).toBeGreaterThan(0);
      expect(candidate.diagnostics()).toEqual(reference.diagnostics());
    }
  });

  it("lists credential files without ever reading them", async () => {
    const root = await temporary();
    await materialize(root, {
      "package.json": "{}\n",
      ".env": "TOKEN=do-not-leak\n",
      ".npmrc": "//registry.test/:_authToken=do-not-leak\n",
      "deploy/id_rsa": "do-not-leak\n",
      "certs/server.pem": "do-not-leak\n",
    });
    const reader = await WorkingTreeReader.open({ root });
    const results = await reader.readMany(reader.files().map((entry) => entry.path));
    for (const file of [".env", ".npmrc", "certs/server.pem", "deploy/id_rsa"]) {
      expect(reader.entry(file), file).toBeDefined();
      expect(skipReason(results.get(file)), file).toBe("sensitive");
    }
    expect(JSON.stringify([...results.values()].map(comparable))).not.toContain("do-not-leak");
    expect(reader.usage()).toEqual({ files: 1, bytes: 3 });
  });

  it("records links as data and never descends into or reads through them", async () => {
    const outside = await temporary();
    await fs.writeFile(path.join(outside, "secret.txt"), "do-not-leak\n");
    const root = await temporary();
    await materialize(root, { "package.json": "{}\n", "src/app.js": "export default 1;\n" });
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "src", "secret-link"));
    await fs.symlink(outside, path.join(root, "outside-directory"));
    await fs.symlink("loop", path.join(root, "loop"));

    const reader = await WorkingTreeReader.open({ root });
    expect(reader.entries.map((entry) => `${entry.type}:${entry.path}`)).toEqual([
      "symlink:loop",
      "symlink:outside-directory",
      "file:package.json",
      "tree:src",
      "file:src/app.js",
      "symlink:src/secret-link",
    ]);
    expect(await reader.linkTarget("src/secret-link")).toBe(path.join(outside, "secret.txt"));
    expect(skipReason(await reader.read("src/secret-link"))).toBe("symlink");
    expect(skipReason(await reader.read("outside-directory/secret.txt"))).toBe("missing");
  });

  it("refuses content changed or swapped for a link after listing", async () => {
    const outside = await temporary();
    await fs.writeFile(path.join(outside, "secret.txt"), "do-not-leak\n");
    await fs.mkdir(path.join(outside, "lib"));
    await fs.writeFile(path.join(outside, "lib", "util.js"), "do-not-leak\n");
    const root = await temporary();
    await materialize(root, {
      "package.json": "{}\n",
      "src/changed.js": "export const before = 1;\n",
      "src/swapped.js": "export const swapped = 1;\n",
      "lib/util.js": "export const util = 1;\n",
    });
    const reader = await WorkingTreeReader.open({ root });

    await fs.writeFile(path.join(root, "src", "changed.js"), "export const after = 2;\n");
    await fs.rm(path.join(root, "src", "swapped.js"));
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "src", "swapped.js"));
    await fs.rm(path.join(root, "lib"), { recursive: true });
    await fs.symlink(path.join(outside, "lib"), path.join(root, "lib"));

    const results = await reader.readMany(["lib/util.js", "src/changed.js", "src/swapped.js"]);
    for (const [file, result] of results) expect(skipReason(result), file).toBe("missing");
    expect(JSON.stringify([...results.values()].map(comparable))).not.toContain("do-not-leak");
  });

  it("leaves out .git, dependency directories, gitignored output, and special files", async () => {
    const repository = await temporary();
    await materialize(repository, {
      ".gitignore": "dist/\n*.log\n",
      "apps/web/.gitignore": "coverage/\n!keep.log\n",
      "apps/web/package.json": "{}\n",
      "apps/web/src/index.js": "export default 1;\n",
      "apps/web/dist/bundle.js": "minified\n",
      "apps/web/coverage/lcov.info": "coverage\n",
      "apps/web/debug.log": "noise\n",
      "apps/web/keep.log": "kept\n",
      "apps/web/node_modules/react/index.js": "module.exports = {};\n",
      "apps/web/packages/ui/node_modules/lodash/index.js": "module.exports = {};\n",
      "apps/web/packages/ui/index.js": "export const Button = 1;\n",
    });
    const root = path.join(repository, "apps", "web");
    const socket = path.join(root, "server.sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const listing = await WorkingTreeListing.scan({ root, repositoryRoot: repository });
      expect(listing.entries.map((entry) => entry.path)).toEqual([
        ".gitignore",
        "keep.log",
        "package.json",
        "packages",
        "packages/ui",
        "packages/ui/index.js",
        "src",
        "src/index.js",
      ]);
      expect(listing.exclusions.map((exclusion) => `${exclusion.reason}:${exclusion.path}`)).toEqual([
        "gitignored:coverage",
        "gitignored:debug.log",
        "gitignored:dist",
        "dependency_directory:node_modules",
        "dependency_directory:packages/ui/node_modules",
        "special_file:server.sock",
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("identifies listed content with a digest that changes only when content does", async () => {
    const root = await temporary();
    await materialize(root, { "package.json": "{}\n", "src/app.ts": "export const a = 1;\n" });
    const first = await WorkingTreeListing.scan({ root });
    expect((await WorkingTreeListing.scan({ root })).digest).toBe(first.digest);
    await fs.writeFile(path.join(root, "src", "app.ts"), "export const a = 2;\n");
    expect((await WorkingTreeListing.scan({ root })).digest).not.toBe(first.digest);
  });
});

async function expectEquivalent(files: Readonly<Record<string, MemoryFile>>, budgets?: Budgets): Promise<{ candidate: SourceReader; reference: SourceReader }> {
  const root = await temporary();
  await materialize(root, files);
  const candidate = (await WorkingTreeListing.scan({ root, repositoryRoot: root })).open(budgets);
  const reference = memoryReaderFor(files, budgets === undefined ? {} : { budgets });
  expect(candidate.entries).toEqual(reference.entries);
  expect(candidate.files()).toEqual(reference.files());
  const paths = reference.entries.map((entry) => entry.path);
  const [actual, expected] = await Promise.all([candidate.readMany(paths), reference.readMany(paths)]);
  expect([...actual.entries()].map(([key, value]) => [key, comparable(value)])).toEqual([...expected.entries()].map(([key, value]) => [key, comparable(value)]));
  expect(candidate.diagnostics()).toEqual(reference.diagnostics());
  expect(candidate.usage()).toEqual(reference.usage());
  return { candidate, reference };
}

function comparable(result: ReadResult | undefined) {
  if (result === undefined) return undefined;
  return result.ok ? { entry: result.content.entry, text: result.content.text, digest: result.content.digest, bytes: result.content.bytes.toString("base64") } : result.skip;
}

function skipReason(result: ReadResult | undefined): string | undefined {
  return result !== undefined && !result.ok ? result.skip.reason : undefined;
}

async function temporary(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-tree-")));
  temporaryDirectories.push(directory);
  return directory;
}
