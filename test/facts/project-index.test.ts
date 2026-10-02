import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectIndex, type IndexedSymbol, type ProjectIndex } from "../../src/facts/project-index.js";
import { WorkingTreeListing } from "../../src/facts/working-tree-reader.js";
import { materialize, readTree } from "../support/repo-facts-fixtures.js";
import { withTraps } from "../support/traps.js";

const MIXED = path.resolve(import.meta.dirname, "../fixtures/web-doctor/mixed-react/tree");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("project index over mixed JavaScript and TypeScript", () => {
  it("indexes components, hooks, contexts, and types with exact source locations", async () => {
    const index = await indexOf(MIXED);
    expect(index.complete).toBe(true);
    expect(index.symbols.map((symbol) => `${symbol.kind} ${symbol.id} ${symbol.location.line}:${symbol.location.column}-${symbol.location.endLine}:${symbol.location.endColumn}`)).toEqual([
      "component src/App.tsx#App 6:17-6:20",
      "component src/Header.jsx#Header 4:25-4:31",
      "component src/orders/OrderList.tsx#OrderList 9:14-9:23",
      "interface src/orders/OrderList.tsx#OrderListProps 4:11-4:25",
      "interface src/orders/OrdersContext.tsx#Order 3:18-3:23",
      "context src/orders/OrdersContext.tsx#OrdersContext 8:14-8:27",
      "component src/orders/OrdersContext.tsx#OrdersProvider 10:17-10:31",
      "hook src/orders/useOrders.js#useOrders 4:17-4:26",
    ]);
    expect(index.symbols.filter((entry) => !entry.exported).map((entry) => entry.id)).toEqual(["src/orders/OrderList.tsx#OrderListProps"]);
  });

  it("derives props from destructuring, TypeScript types, propTypes, and usage", async () => {
    const index = await indexOf(MIXED);
    expect(props(symbol(index, "src/orders/OrderList.tsx#OrderList"))).toEqual({ certainty: "observed", props: ["emptyLabel?:type", "limit:destructuring"] });
    expect(props(symbol(index, "src/orders/OrdersContext.tsx#OrdersProvider"))).toEqual({ certainty: "observed", props: ["children:destructuring"] });
    expect(props(symbol(index, "src/Header.jsx#Header"))).toEqual({ certainty: "observed", props: ["title:prop-types"] });
    expect(props(symbol(index, "src/App.tsx#App"))).toEqual({ certainty: "observed", props: [] });
    expect(symbol(index, "src/orders/OrderList.tsx#OrderList").reasoning).toBe("The function is wrapped in React memo or forwardRef");
  });

  it("resolves hooks, rendered elements, providers, and consumers across files and languages", async () => {
    const index = await indexOf(MIXED);
    const uses = (entries: IndexedSymbol["hooks"]) => entries.map((use) => `${use.name}<${use.symbol ?? use.module ?? "?"}>`);
    expect(uses(symbol(index, "src/App.tsx#App").renders)).toEqual([
      "Header<src/Header.jsx#Header>",
      "OrderList<src/orders/OrderList.tsx#OrderList>",
      "OrdersProvider<src/orders/OrdersContext.tsx#OrdersProvider>",
      "SaltProvider<@salt-ds/core>",
    ]);
    expect(uses(symbol(index, "src/Header.jsx#Header").hooks)).toEqual(["useOrders<src/orders/useOrders.js#useOrders>"]);
    expect(uses(symbol(index, "src/orders/useOrders.js#useOrders").hooks)).toEqual(["useContext<react>"]);
    expect(uses(symbol(index, "src/orders/OrdersContext.tsx#OrdersProvider").renders)).toEqual(["OrdersContext.Provider<src/orders/OrdersContext.tsx#OrdersContext>"]);
    expect(symbol(index, "src/orders/OrdersContext.tsx#OrdersProvider").provides).toEqual(["src/orders/OrdersContext.tsx#OrdersContext"]);
    expect(symbol(index, "src/orders/useOrders.js#useOrders").consumes).toEqual(["src/orders/OrdersContext.tsx#OrdersContext"]);
  });

  it("resolves imports through relative paths, JavaScript extensions, and tsconfig aliases", async () => {
    const index = await indexOf(MIXED);
    const app = index.modules.find((module) => module.path === "src/App.tsx")!;
    expect(app.imports.map((entry) => [entry.specifier, entry.target])).toEqual([
      ["@salt-ds/core", { kind: "package", name: "@salt-ds/core" }],
      ["./orders/OrdersContext", { kind: "module", path: "src/orders/OrdersContext.tsx" }],
      ["@/orders/OrderList", { kind: "module", path: "src/orders/OrderList.tsx" }],
      ["./Header.jsx", { kind: "module", path: "src/Header.jsx" }],
    ]);
    expect(index.modules.find((module) => module.path === "src/Header.jsx")!.exports).toEqual([{ name: "default", symbol: "src/Header.jsx#Header", from: null }]);
  });

  it("records references with their kind, location, and enclosing symbol", async () => {
    const index = await indexOf(MIXED);
    const references = index.references
      .filter((reference) => reference.symbol === "src/orders/useOrders.js#useOrders" || reference.symbol === "src/Header.jsx#Header")
      .map((reference) => `${reference.symbol.split("#")[1]} ${reference.kind} ${reference.path}:${reference.location.line}:${reference.location.column} in ${reference.enclosing ?? "module"}`);
    expect(references).toEqual([
      "Header import src/App.tsx:4:8 in module",
      "Header jsx src/App.tsx:10:10 in src/App.tsx#App",
      "Header value src/Header.jsx:9:1 in module",
      "useOrders import src/Header.jsx:2:10 in module",
      "useOrders call src/Header.jsx:5:22 in src/Header.jsx#Header",
      "useOrders import src/orders/OrderList.tsx:2:10 in module",
      "useOrders call src/orders/OrderList.tsx:10:22 in src/orders/OrderList.tsx#OrderList",
    ]);
  });

  it("is deterministic and reads only reader-admitted bytes without executing anything", async () => {
    const root = await temporary();
    const files = await readTree(MIXED);
    await materialize(root, {
      ...files,
      "vite.config.js": "require('child_process').execSync('touch executed'); export default {};\n",
      ".env": "SECRET=do-not-leak\n",
    });
    const { result: first, attempts } = await withTraps(async () => buildProjectIndex((await WorkingTreeListing.scan({ root })).open()));
    expect(attempts).toEqual([]);
    await expect(fs.access(path.join(root, "executed"))).rejects.toThrow();
    expect(JSON.stringify(first)).not.toContain("do-not-leak");
    const second = await buildProjectIndex((await WorkingTreeListing.scan({ root })).open());
    expect(second.digest).toBe(first.digest);
    expect(first.modules.find((module) => module.path === "vite.config.js")!.imports).toEqual([
      { specifier: "child_process", kind: "require", typeOnly: false, names: [], target: { kind: "package", name: "child_process" }, location: { path: "vite.config.js", line: 1, column: 1, endLine: 1, endColumn: 25 }, enclosing: null },
    ]);
  });

  it("marks computed specifiers unresolved and reports skipped and truncated input", async () => {
    const root = await temporary();
    await materialize(root, {
      "src/a.ts": "export const load = (name: string) => import(`./pages/${name}`);\n",
      "src/b.ts": "export const broken = (;\n",
      "src/c.ts": "export const c = 1;\n",
      "src/d.ts": "export const d = 1;\n",
    });
    const index = await buildProjectIndex((await WorkingTreeListing.scan({ root })).open(), { limits: { maxFiles: 3 } });
    expect(index.modules.find((module) => module.path === "src/a.ts")!.imports[0]!.target).toEqual({ kind: "unresolved", reason: "computed_specifier" });
    expect(index.complete).toBe(false);
    expect(index.truncated.files).toBe(true);
    expect(index.skipped.map((entry) => `${entry.reason}:${entry.path}`)).toEqual(["syntax_error:src/b.ts", "index_file_budget:src/d.ts"]);
  });
});

async function indexOf(tree: string): Promise<ProjectIndex> {
  return buildProjectIndex((await WorkingTreeListing.scan({ root: tree })).open());
}

function symbol(index: ProjectIndex, id: string): IndexedSymbol {
  const found = index.symbols.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`${id} is not indexed`);
  return found;
}

function props(entry: IndexedSymbol) {
  return { certainty: entry.propsCertainty, props: (entry.props ?? []).map((prop) => `${prop.name}${prop.optional ? "?" : ""}:${prop.source}`) };
}

async function temporary(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-index-")));
  temporaryDirectories.push(directory);
  return directory;
}
