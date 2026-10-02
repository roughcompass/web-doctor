import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DocumentCategory, FactDocument, MemoryFile } from "@repo-facts/contract";
import { factDocumentProblems } from "@repo-facts/contract";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeExtensions, type ExtensionFacts } from "../../src/facts/extensions.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer, type SharedFactsComplete } from "../../src/facts/shared-facts.js";
import { WorkingTreeListing } from "../../src/facts/working-tree-reader.js";
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

const APPLICATION: Record<string, MemoryFile> = {
  "package.json": JSON.stringify({
    name: "shell",
    dependencies: { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "6.30.0", "single-spa-react": "6.0.2" },
    devDependencies: { webpack: "5.99.9" },
  }),
  "webpack.config.js": [
    'const path = require("node:path");',
    "",
    "module.exports = {",
    "  entry: {",
    '    main: path.resolve(__dirname, "src/index.tsx"),',
    '    legacy: "./src/legacy.js",',
    "    generated: getEntries(),",
    "  },",
    "};",
    "",
  ].join("\n"),
  "src/index.tsx": 'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
  "src/legacy.js": 'import ReactDOM from "react-dom";\nimport { App } from "./App";\n\nReactDOM.render(<App />, document.querySelector(hostSelector()));\n',
  "src/lifecycles.tsx": 'import singleSpaReact from "single-spa-react";\nimport { App } from "./App";\n\nconst lifecycles = singleSpaReact({ rootComponent: App });\n\nexport const { bootstrap, mount, unmount } = lifecycles;\n',
  "src/App.tsx": [
    'import { BrowserRouter, Route, Routes, createBrowserRouter } from "react-router-dom";',
    "",
    'const base = "/app";',
    "",
    "export function App() {",
    "  return (",
    "    <BrowserRouter>",
    "      <Routes>",
    '        <Route path="/" element={<Layout />}>',
    "          <Route index element={<Home />} />",
    '          <Route path="orders" element={<Orders />} />',
    "          <Route path={`${base}/reports`} element={<Reports />} />",
    "        </Route>",
    "      </Routes>",
    "    </BrowserRouter>",
    "  );",
    "}",
    "",
    'export const router = createBrowserRouter([{ path: "/admin", element: <Admin />, children: [{ path: "users", Component: Users }] }]);',
    "",
    "function Layout() {",
    "  return <main />;",
    "}",
    "function Home() {",
    "  return <p>Home</p>;",
    "}",
    "function Orders() {",
    "  return <p>Orders</p>;",
    "}",
    "function Reports() {",
    "  return <p>Reports</p>;",
    "}",
    "function Admin() {",
    "  return <p>Admin</p>;",
    "}",
    "function Users() {",
    "  return <p>Users</p>;",
    "}",
    "",
  ].join("\n"),
  "src/lookalikes.tsx": [
    "function createRoot(value: unknown) {",
    "  return { render: (element: unknown) => [value, element] };",
    "}",
    "function singleSpaReact(options: unknown) {",
    "  return options;",
    "}",
    "function Route(props: { path: string }) {",
    "  return <span>{props.path}</span>;",
    "}",
    "",
    'createRoot(1).render(<Route path="/lookalike" />);',
    "singleSpaReact({ rootComponent: Route });",
    "",
  ].join("\n"),
};

describe("entry-point, route, test, and relationship extensions", () => {
  it("reports build entries, React roots, and single-spa lifecycles, keeping computed values unresolved", async () => {
    const { extensions } = await analyze(APPLICATION);
    const entries = facts(extensions, "web-doctor.entry_points");
    expect(Object.keys(entries)).toEqual([
      "build:webpack.config.js#generated",
      "build:webpack.config.js#legacy",
      "build:webpack.config.js#main",
      "mount:src/index.tsx:4",
      "mount:src/legacy.js:4",
      "single-spa:src/lifecycles.tsx",
    ]);
    expect(entries["build:webpack.config.js#main"]).toMatchObject({ state: "inferred", value: { module: "src/index.tsx", resolution: "idiom" } });
    expect(entries["build:webpack.config.js#legacy"]).toMatchObject({ state: "observed", value: { module: "src/legacy.js", resolution: "literal" } });
    expect(entries["build:webpack.config.js#generated"]).toMatchObject({ state: "observed", value: { module: null, resolution: "computed", expression: "getEntries()" } });
    expect(entries["mount:src/index.tsx:4"]!.value).toMatchObject({ api: "createRoot", package: "react-dom", component: { symbol: "src/App.tsx#App" }, container: { kind: "literal", value: "#root" } });
    expect(entries["mount:src/legacy.js:4"]!.value).toMatchObject({ api: "render", component: { symbol: "src/App.tsx#App" }, container: { kind: "computed", expression: "document.querySelector(hostSelector())" } });
    expect(entries["single-spa:src/lifecycles.tsx"]!.value).toMatchObject({ root_component: { symbol: "src/App.tsx#App" }, lifecycles: ["bootstrap", "mount", "unmount"] });
  });

  it("maps Vite's default HTML entry and rspack federated exposes to source modules", async () => {
    const vite = await analyze({
      "package.json": JSON.stringify({ name: "billing", dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.21" } }),
      "vite.config.ts": 'import { defineConfig } from "vite";\n\nexport default defineConfig({ build: { target: "esnext" } });\n',
      "index.html": '<!doctype html>\n<script src="https://cdn.example.test/analytics.js"></script>\n<script type="module" src="/src/preview.tsx"></script>\n',
      "src/preview.tsx": "export const preview = 1;\n",
    });
    expect(facts(vite.extensions, "web-doctor.entry_points")["build:vite.config.ts#index.html#0"]).toMatchObject({ state: "observed", value: { source: "vite", module: "src/preview.tsx", resolution: "literal" } });

    const rspack = await analyze({
      "package.json": JSON.stringify({ name: "admin", dependencies: { react: "18.3.1" }, devDependencies: { "@rspack/core": "2.2.8" } }),
      "rspack.config.cjs": [
        'const rspack = require("@rspack/core");',
        "",
        "module.exports = {",
        "  plugins: [",
        "    new rspack.container.ModuleFederationPluginV1({",
        '      name: "mfAdmin",',
        '      exposes: { "./Admin": "./src/Admin.tsx", "./Dynamic": exposedPath() },',
        "    }),",
        "  ],",
        "};",
        "",
      ].join("\n"),
      "src/index.tsx": "export {};\n",
      "src/Admin.tsx": "export function Admin() {\n  return <section />;\n}\n",
    });
    const entries = facts(rspack.extensions, "web-doctor.entry_points");
    expect(entries["build:rspack.config.cjs#main"]).toMatchObject({ state: "inferred", value: { module: "src/index.tsx", resolution: "default" } });
    expect(entries["federation-expose:mfAdmin#./Admin"]?.value).toMatchObject({ module: "src/Admin.tsx", resolution: "literal", components: ["src/Admin.tsx#Admin"] });
    expect(entries["federation-expose:mfAdmin#./Dynamic"]).toMatchObject({ state: "observed", value: { module: null, resolution: "computed", expression: "exposedPath()", components: [] } });
  });

  it("reports React Router routes with nesting and unresolved computed paths", async () => {
    const { extensions } = await analyze(APPLICATION);
    const routes = Object.values(facts(extensions, "web-doctor.routes")).map((fact) => {
      const value = fact.value as { style: string; path: { kind: string; value?: string; expression?: string } | null; index: boolean; element: { symbol: string | null } | null; parent: string | null };
      return [value.style, value.path?.value ?? value.path?.expression ?? (value.index ? "(index)" : null), value.element?.symbol?.split("#")[1] ?? null, value.parent];
    });
    expect(routes).toHaveLength(6);
    expect(routes).toEqual(expect.arrayContaining([
      ["object", "/admin", "Admin", null],
      ["object", "users", "Users", "src/App.tsx:19:44"],
      ["element", "/", "Layout", null],
      ["element", "(index)", "Home", "src/App.tsx:9:9"],
      ["element", "orders", "Orders", "src/App.tsx:9:9"],
      ["element", "`${base}/reports`", "Reports", "src/App.tsx:9:9"],
    ]));
    expect(Object.values(facts(extensions, "web-doctor.routes")).find((fact) => JSON.stringify(fact.value).includes("reports"))!.value).toMatchObject({ path: { kind: "computed" } });
  });

  it("ignores same-named local functions and activates build entries only for shared build tools", async () => {
    const { extensions } = await analyze(APPLICATION);
    const framework = JSON.stringify([extensions.categories["web-doctor.entry_points"]!.facts, extensions.categories["web-doctor.routes"]!.facts]);
    expect(framework).not.toContain("lookalike");
    expect(framework).not.toContain("src/lookalikes.tsx");
    expect(extensions.index.runtime.mounts.map((mount) => mount.path)).toEqual(["src/index.tsx", "src/legacy.js"]);
    const withoutShared = await analyze(APPLICATION, { shared: false });
    expect(Object.keys(facts(withoutShared.extensions, "web-doctor.entry_points")).filter((key) => key.startsWith("build:"))).toEqual([]);
  });

  it("reports test files only with a declared or imported framework", async () => {
    const files = {
      "package.json": JSON.stringify({ name: "tested", devDependencies: {} }),
      "src/math.ts": "export const add = (a: number, b: number) => a + b;\n",
      "src/math.test.ts": 'import { expect, it } from "vitest";\nimport { add } from "./math";\n\nit("adds", () => expect(add(1, 2)).toBe(3));\n',
      "src/undeclared.test.ts": 'import { add } from "./math";\n\nadd(1, 2);\n',
      "src/contest.ts": "export const contest = true;\n",
    };
    const { extensions } = await analyze(files);
    const tests = facts(extensions, "web-doctor.tests");
    expect(Object.keys(tests)).toEqual(["src/math.test.ts"]);
    expect(tests["src/math.test.ts"]).toMatchObject({
      state: "inferred",
      reasoning: "The file uses the .test suffix that test runners collect, and it imports vitest",
      value: { imports_framework: "vitest", subjects: ["src/math.ts"], symbols: ["src/math.ts#add"] },
    });

    const declared = await analyze({ ...files, "package.json": JSON.stringify({ name: "tested", scripts: { test: "vitest run" }, devDependencies: { vitest: "2.1.9" } }) });
    const declaredTests = facts(declared.extensions, "web-doctor.tests");
    expect(Object.keys(declaredTests)).toEqual(["src/math.test.ts", "src/undeclared.test.ts"]);
    expect(declaredTests["src/undeclared.test.ts"]!.value).toMatchObject({ frameworks: ["vitest"], imports_framework: null, commands: ["package.json#scripts/test"] });
  });

  it("links frame hosts and message channels to shared composition and runtime facts only when those exist", async () => {
    const fixture = await loadGoldenFixture("federation-shell");
    const { extensions, shared } = await analyze(fixture.files);
    const relationships = facts(extensions, "web-doctor.source_relationships");
    expect(Object.keys(relationships)).toEqual(["iframe:src/App.tsx:9", "message:receive:src/App.tsx:6"]);
    expect(relationships["iframe:src/App.tsx:9"]!.value).toEqual({ kind: "iframe-host", component: "src/App.tsx#LegacyFrame", src: { kind: "literal", value: "http://127.0.0.1:9103" }, shared_fact: "iframe:http://127.0.0.1:9103" });
    expect(relationships["message:receive:src/App.tsx:6"]!.value).toMatchObject({ symbol: "src/App.tsx#LegacyFrame", shared_fact: "postMessage:receive", shared_state: "observed" });
    expect(shared!.categories.composition!.facts.some((fact) => fact.key === "iframe:http://127.0.0.1:9103")).toBe(true);

    const withoutShared = await analyze(fixture.files, { shared: false });
    expect(facts(withoutShared.extensions, "web-doctor.source_relationships")).toEqual({});
    expect(withoutShared.extensions.categories["web-doctor.source_relationships"]!.state).toBe("unknown");
  });

  it("maps Next.js files to routes only when the shared document reports Next.js", async () => {
    const fixture = await loadGoldenFixture("javascript-app");
    const { extensions } = await analyze(fixture.files);
    expect(facts(extensions, "web-doctor.routes")).toEqual({
      "next:pages/index.js": expect.objectContaining({ state: "inferred", value: expect.objectContaining({ router: "next", path: { kind: "literal", value: "/" } }) }),
    });
    const withoutShared = await analyze(fixture.files, { shared: false });
    expect(facts(withoutShared.extensions, "web-doctor.routes")).toEqual({});
  });
});

async function analyze(files: Readonly<Record<string, MemoryFile>>, options: { shared?: boolean } = {}): Promise<{ extensions: ExtensionFacts; shared: FactDocument | undefined }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-source-")));
  temporaryDirectories.push(root);
  await materialize(root, files);
  const listing = await WorkingTreeListing.scan({ root, repositoryRoot: root });
  const shared = options.shared === false ? undefined : (await analyzer.analyze(listing.open()) as SharedFactsComplete).document;
  const extensions = await analyzeExtensions(listing.open(), shared === undefined ? {} : { shared });
  expect(factDocumentProblems(extensions.document)).toEqual([]);
  return { extensions, shared };
}

function facts(extensions: ExtensionFacts, category: string): Record<string, DocumentCategory["facts"][number]> {
  return Object.fromEntries(extensions.categories[category]!.facts.map((fact) => [fact.key, fact]));
}
