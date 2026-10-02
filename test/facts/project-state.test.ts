import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { ProjectState } from "../../src/facts/project-state.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { materialize, readTree } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIXED = path.resolve(import.meta.dirname, "../fixtures/web-doctor/mixed-react/tree");
const temporaryDirectories: string[] = [];
const states: ProjectState[] = [];
let analyzer: SharedFactsAnalyzer;

beforeAll(async () => {
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
});

afterEach(async () => {
  await Promise.all(states.splice(0).map((state) => state.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function lockfile(react: string): string {
  return `${JSON.stringify({
    name: "mixed-react",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "mixed-react", dependencies: { react } },
      "node_modules/react": { version: react, integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}` },
    },
  }, null, 2)}\n`;
}

describe("live project state", () => {
  it("never returns a shared or extension fact invalidated by an observed change during a long session", async () => {
    const root = await project();
    const state = await ProjectState.open({ root, repositoryRoot: root, analyzer });
    states.push(state);
    expect(state.isWatching).toBe(true);
    await expectFresh(state, root);

    const edit = async (action: () => Promise<void>): Promise<{ snapshot: ProjectSnapshot; runs: { shared: number; extensions: number } }> => {
      const before = { observed: state.observedChanges, shared: state.stats.sharedRuns, extensions: state.stats.extensionRuns };
      await action();
      await state.waitForChange(before.observed);
      const snapshot = await expectFresh(state, root);
      return { snapshot, runs: { shared: state.stats.sharedRuns - before.shared, extensions: state.stats.extensionRuns - before.extensions } };
    };

    // Component source: props and the fact's evidence change.
    const orderList = (await readTree(MIXED))["src/orders/OrderList.tsx"]!.toString();
    const component = await edit(() => write(root, "src/orders/OrderList.tsx", orderList.replace("emptyLabel?: string;", "emptyLabel?: string;\n  title: string;")));
    expect(propsOf(component.snapshot, "src/orders/OrderList.tsx#OrderList")).toEqual(["emptyLabel", "limit", "title"]);
    expect(component.runs.extensions).toBe(1);
    expect(state.lastRefresh!.invalidatedFacts).toContain("web-doctor.components/src/orders/OrderList.tsx#OrderList");

    // Manifest: a new direct dependency reaches the shared document.
    const manifest = await edit(async () => {
      const current = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
      current.dependencies["react-router-dom"] = "6.30.0";
      await write(root, "package.json", `${JSON.stringify(current, null, 2)}\n`);
    });
    expect(sharedKeys(manifest.snapshot, "dependencies")).toContain("package.json#dependencies/react-router-dom");
    expect(manifest.runs.shared).toBe(1);

    // Lockfile: resolved versions change, so version-dependent facts are recomputed.
    const locked = await edit(() => write(root, "package-lock.json", lockfile("18.2.0")));
    expect(JSON.stringify(sharedDocument(locked.snapshot).categories.resolved_dependencies)).toContain("18.2.0");

    // Tests: a new test file becomes a test fact.
    const tested = await edit(() => write(root, "src/Header.test.jsx", 'import { it } from "vitest";\nimport Header from "./Header.jsx";\n\nit("renders", () => void Header);\n'));
    expect(tested.snapshot.extensions.categories["web-doctor.tests"]!.facts.map((fact) => fact.key)).toContain("src/Header.test.jsx");

    // Configuration: a build configuration adds an entry point.
    const configured = await edit(() => write(root, "vite.config.ts", 'import { defineConfig } from "vite";\n\nexport default defineConfig({ build: { rollupOptions: { input: "src/main.tsx" } } });\n'));
    expect(configured.snapshot.extensions.categories["web-doctor.entry_points"]!.facts.map((fact) => fact.key)).toContain("build:vite.config.ts#main");

    // A file no extension reads: shared facts are recomputed from new content, extension facts are reused.
    const readme = await edit(() => write(root, "README.md", "# Mixed\n\nNotes.\n"));
    expect(readme.runs).toEqual({ shared: 1, extensions: 0 });
    expect(state.lastRefresh).toMatchObject({ extensionsReused: true, invalidatedFacts: [] });

    // Ignored output: the listed content is identical, so both results are reused.
    const ignored = await edit(() => write(root, "dist/bundle.js", "minified();\n"));
    expect(ignored.runs).toEqual({ shared: 0, extensions: 0 });
    expect(state.lastRefresh).toMatchObject({ sharedReused: true, extensionsReused: true });
  }, 120_000);

  it("rescans on every request when it is not watching", async () => {
    const root = await project();
    const state = await ProjectState.open({ root, repositoryRoot: root, analyzer, watch: false });
    states.push(state);
    expect(state.isWatching).toBe(false);
    const first = await state.current();
    await write(root, "src/orders/useOrders.js", 'import { useContext } from "react";\nimport { OrdersContext } from "./OrdersContext";\n\nexport function useOrderList() {\n  return useContext(OrdersContext);\n}\n');
    const second = await state.current();
    expect(second.digest).not.toBe(first.digest);
    expect(second.extensions.index.symbols.map((symbol) => symbol.name)).toContain("useOrderList");
    expect(second.extensions.index.symbols.map((symbol) => symbol.name)).not.toContain("useOrders");
    // One scan when opening, then one for each request.
    expect(state.stats.scans).toBe(3);
  });
});

async function project(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-live-")));
  temporaryDirectories.push(root);
  const files = await readTree(MIXED);
  const manifest = JSON.parse(files["package.json"]!.toString()) as Record<string, unknown>;
  await materialize(root, { ...files, "package.json": `${JSON.stringify(manifest, null, 2)}\n`, "package-lock.json": lockfile("18.3.1"), ".gitignore": "dist/\n", "README.md": "# Mixed\n" });
  return root;
}

async function expectFresh(state: ProjectState, root: string): Promise<ProjectSnapshot> {
  const live = await state.current();
  const fresh = await analyzeProject({ root, repositoryRoot: root, analyzer });
  expect(live.digest).toBe(fresh.digest);
  expect(live.treeDigest).toBe(fresh.treeDigest);
  return live;
}

async function write(root: string, file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

function sharedDocument(snapshot: ProjectSnapshot) {
  if (snapshot.shared.status !== "complete") throw new Error("Shared facts are incomplete");
  return snapshot.shared.document;
}

function sharedKeys(snapshot: ProjectSnapshot, category: string): string[] {
  return sharedDocument(snapshot).categories[category]!.facts.map((fact) => fact.key);
}

function propsOf(snapshot: ProjectSnapshot, id: string): string[] {
  return (snapshot.extensions.index.symbols.find((symbol) => symbol.id === id)?.props ?? []).map((prop) => prop.name);
}
