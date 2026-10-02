import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryFile } from "@repo-facts/contract";
import { DETECTOR_RELEASE } from "@repo-facts/bundle";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import {
  QueryError,
  dataPath,
  explainSymbol,
  projectOverview,
  runtimeBoundaries,
  serviceDependencies,
  tests,
  usages,
  verificationCommands,
  type DataPathSegment,
  type QueryResult,
} from "../../src/facts/queries.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { loadGoldenFixture, materialize, readTree } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIXED = path.resolve(import.meta.dirname, "../fixtures/web-doctor/mixed-react/tree");
const temporaryDirectories: string[] = [];
let analyzer: SharedFactsAnalyzer;
let mixed: ProjectSnapshot;

beforeAll(async () => {
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
  mixed = await snapshot({
    ...await readTree(MIXED),
    "src/orders/api.ts": 'export async function loadOrders() {\n  const response = await fetch("https://orders.example.test/api/orders");\n  const body = await response.json();\n  return body.orders;\n}\n',
    "src/orders/useOrders.js": 'import { useContext } from "react";\nimport { loadOrders } from "./api";\nimport { OrdersContext } from "./OrdersContext";\n\nexport function useOrders() {\n  void loadOrders;\n  return useContext(OrdersContext);\n}\n',
    "src/orders/OrderList.test.tsx": 'import { it } from "vitest";\nimport { OrderList } from "./OrderList";\n\nit("renders", () => void (<OrderList limit={1} />));\n',
  });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("task-scoped project queries", () => {
  it("pages the project overview deterministically with totals and continuations", () => {
    const first = projectOverview(mixed, { limit: 10 });
    expect(first.page).toMatchObject({ limit: 10, offset: 0, returned: 10, total: 33, truncated: true });
    const second = projectOverview(mixed, { limit: 10, continuation: first.page.continuation! });
    const third = projectOverview(mixed, { limit: 10, continuation: second.page.continuation! });
    expect(second.page).toMatchObject({ offset: 10, returned: 10 });
    const fourth = projectOverview(mixed, { limit: 10, continuation: third.page.continuation! });
    expect(third.page).toMatchObject({ offset: 20, returned: 10, truncated: true });
    expect(fourth.page).toMatchObject({ offset: 30, returned: 3, truncated: false, continuation: null });
    const ids = [...first.items, ...second.items, ...third.items, ...fourth.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(33);
    expect(ids.filter((id) => id.startsWith("web-doctor."))).toHaveLength(7);
    expect(projectOverview(mixed, { limit: 10 })).toEqual(first);
    expect(first.summary).toMatchObject({ frameworks: ["package.json#react"], build_tools: ["typescript", "vite"], components: 4, hooks: 1 });
    expectProvenance(first);
  });

  it("refuses continuations from another query, other parameters, or a changed project", async () => {
    const page = usages(mixed, { symbol: "useOrders" }, { limit: 1 });
    expect(() => usages(mixed, { symbol: "OrderList" }, { continuation: page.page.continuation! })).toThrow(QueryError);
    expect(() => projectOverview(mixed, { continuation: page.page.continuation! })).toThrow("different query");
    const changed = await snapshot({ ...await readTree(MIXED), "src/extra.ts": "export const extra = 1;\n" });
    expect(() => usages(changed, { symbol: "useOrders" }, { continuation: page.page.continuation! })).toThrow("project changed");
    expect(() => usages(mixed, { symbol: "useOrders" }, { limit: 0 })).toThrow("Limits must be integers");
  });

  it("explains a symbol with its extension fact evidence and bounded references", () => {
    const explanation = explainSymbol(mixed, { symbol: "OrderList", referenceLimit: 2 });
    expect(explanation.items).toHaveLength(1);
    const [item] = explanation.items;
    expect(item!.symbol).toMatchObject({ id: "src/orders/OrderList.tsx#OrderList", kind: "component" });
    expect(item!.fact).toMatchObject({ source: "extension", category: "web-doctor.components", state: "inferred", evidence: [{ path: "src/orders/OrderList.tsx", lines: { start: 9, end: 9 }, detector: "web-doctor.react-components" }] });
    expect(item!.references).toMatchObject({ total: 4, returned: 2, byKind: { import: 2, jsx: 2 } });
    expect(explainSymbol(mixed, { symbol: "Missing" })).toMatchObject({ items: [], unresolved: [{ subject: "Missing", reason: "No indexed top-level symbol has this id or name" }] });
  });

  it("returns a deterministic subset of usages with a total, continuation, and narrowing guidance", () => {
    const first = usages(mixed, { symbol: "useOrders" }, { limit: 2 });
    expect(first.page).toMatchObject({ returned: 2, total: 4, truncated: true });
    expect(first.items.map((item) => `${item.kind}:${item.path}:${item.location.line}`)).toEqual(["import:src/Header.jsx:2", "call:src/Header.jsx:5"]);
    expect(first.narrowing).toEqual([
      { parameter: "kind", values: [{ value: "call", count: 2 }, { value: "import", count: 2 }] },
      { parameter: "path", values: [{ value: "src/Header.jsx", count: 2 }, { value: "src/orders/OrderList.tsx", count: 2 }] },
    ]);
    const narrowed = usages(mixed, { symbol: "useOrders", kind: "call", path: "src/orders" });
    expect(narrowed.items.map((item) => item.enclosing)).toEqual(["src/orders/OrderList.tsx#OrderList"]);
    expect(narrowed.page).toMatchObject({ total: 1, truncated: false, continuation: null });
  });

  it("traces a component's data path through props, callers, hooks, contexts, imports, and services", () => {
    const path = dataPath(mixed, { symbol: "src/orders/OrderList.tsx#OrderList" }, { limit: 100 });
    const kinds = (kind: DataPathSegment["kind"]) => path.items.filter((segment) => segment.kind === kind);
    expect(kinds("prop").map((segment) => (segment as { name: string }).name)).toEqual(["emptyLabel", "limit"]);
    expect(kinds("caller")).toEqual([
      expect.objectContaining({ caller: "src/App.tsx#App", path: "src/App.tsx", attributes: ["limit"] }),
      expect.objectContaining({ caller: null, path: "src/orders/OrderList.test.tsx", attributes: ["limit"] }),
    ]);
    expect(kinds("hook").map((segment) => `${segment.symbol.split("#")[1]}:${(segment as { name: string }).name}:${(segment as { resolution: string }).resolution}`)).toEqual([
      "OrderList:useOrders:local",
      "useOrders:useContext:package",
    ]);
    expect(kinds("context")).toEqual([
      expect.objectContaining({ context: "src/orders/OrdersContext.tsx#OrdersContext", providers: ["src/orders/OrdersContext.tsx#OrdersProvider"], providerSites: [expect.objectContaining({ path: "src/App.tsx", caller: "src/App.tsx#App" })] }),
    ]);
    expect(kinds("service")).toEqual([
      expect.objectContaining({ key: expect.stringContaining("orders.example.test"), callSites: [expect.objectContaining({ path: "src/orders/api.ts", lines: { start: 2, end: 2 } })] }),
    ]);
    expect(path.unresolved).toContainEqual({ subject: "src/orders/OrdersContext.tsx#OrdersContext value", reason: "The value a provider passes is computed at runtime" });
    expectProvenance(path);
  });

  it("reports runtime boundaries from shared composition and Web Doctor relationships with evidence", async () => {
    const federation = await snapshot((await loadGoldenFixture("federation-shell")).files);
    const boundaries = runtimeBoundaries(federation);
    expect(boundaries.items.map((item) => `${item.source}:${item.category}:${item.key}`)).toEqual([
      "shared:composition:iframe:http://127.0.0.1:9103",
      "shared:composition:module-federation:mfShell",
      "shared:runtime_integrations:postMessage:receive",
      "extension:web-doctor.source_relationships:iframe:src/App.tsx:9",
      "extension:web-doctor.source_relationships:message:receive:src/App.tsx:6",
    ]);
    for (const item of boundaries.items) expect(item.evidence.length, item.key).toBeGreaterThan(0);
    expect(boundaries.unresolved.map((entry) => entry.subject)).toContain("runtime behavior");
  });

  it("finds tests by subject or symbol and reports declared test commands without running them", () => {
    expect(tests(mixed, { symbol: "src/orders/OrderList.tsx#OrderList" }).items.map((item) => item.key)).toEqual(["src/orders/OrderList.test.tsx"]);
    expect(tests(mixed, { path: "src/App.tsx" })).toMatchObject({ items: [], unresolved: [{ subject: "src/App.tsx" }] });
    const commands = verificationCommands(mixed, { kind: "test" });
    expect(commands.items.map((item) => item.key)).toEqual(["package.json#scripts/test"]);
    expect(commands.items[0]!.evidence[0]).toMatchObject({ path: "package.json", pointer: "/scripts/test" });
    expect(commands.summary).toMatchObject({ executed: false });
  });

  it("lists Service Dependencies with call-site evidence and explicit missing evidence", () => {
    const services = serviceDependencies(mixed, { path: "src/orders" });
    expect(services.items).toHaveLength(1);
    expect(services.items[0]).toMatchObject({ access: { state: "unknown" }, callSites: [expect.objectContaining({ path: "src/orders/api.ts" })] });
    expect(serviceDependencies(mixed, { path: "src/components" }).items).toEqual([]);
  });
});

function expectProvenance(result: QueryResult<unknown>): void {
  expect(result.provenance).toMatchObject({
    snapshotDigest: mixed.digest,
    treeDigest: mixed.treeDigest,
    shared: { status: "complete", detectorRelease: DETECTOR_RELEASE, factDocumentDigest: expect.stringMatching(/^[0-9a-f]{64}$/), configurationDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    extensions: { stateDigest: mixed.extensions.digest, indexDigest: mixed.extensions.index.digest },
  });
}

async function snapshot(files: Readonly<Record<string, MemoryFile>>): Promise<ProjectSnapshot> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-query-")));
  temporaryDirectories.push(root);
  await materialize(root, files);
  return analyzeProject({ root, repositoryRoot: root, analyzer });
}
