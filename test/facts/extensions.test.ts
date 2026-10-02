import path from "node:path";
import { SHARED_CATEGORIES, categoriesFor, defineExtension, digestOf, factDocumentProblems } from "@repo-facts/contract";
import { beforeAll, describe, expect, it } from "vitest";
import { WEB_DOCTOR_EXTENSIONS, WEB_DOCTOR_EXTENSION_RELEASE, analyzeExtensions, extensionStateDigest, mergedCategories, type ExtensionFacts } from "../../src/facts/extensions.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer, type SharedFactsComplete } from "../../src/facts/shared-facts.js";
import { WorkingTreeListing } from "../../src/facts/working-tree-reader.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIXED = path.resolve(import.meta.dirname, "../fixtures/web-doctor/mixed-react/tree");
let shared: SharedFactsComplete;
let extensions: ExtensionFacts;

beforeAll(async () => {
  const listing = await WorkingTreeListing.scan({ root: MIXED });
  const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
  shared = await analyzer.analyze(listing.open()) as SharedFactsComplete;
  extensions = await analyzeExtensions(listing.open(), { shared: shared.document });
});

describe("Web Doctor extension categories", () => {
  it("registers only namespaced categories that no shared category or other extension uses", () => {
    const sharedIds = new Set(SHARED_CATEGORIES.map((category) => category.id));
    expect(WEB_DOCTOR_EXTENSIONS.map((extension) => extension.id)).toEqual([
      "web-doctor.components",
      "web-doctor.entry_points",
      "web-doctor.hooks",
      "web-doctor.providers",
      "web-doctor.routes",
      "web-doctor.source_relationships",
      "web-doctor.tests",
    ]);
    for (const extension of WEB_DOCTOR_EXTENSIONS) {
      expect(extension.id.startsWith("web-doctor.")).toBe(true);
      expect(sharedIds.has(extension.id)).toBe(false);
    }
    expect(() => categoriesFor(WEB_DOCTOR_EXTENSIONS)).not.toThrow();
    expect(() => defineExtension({ ...WEB_DOCTOR_EXTENSIONS[0]!, id: "composition" })).toThrow("must be namespaced");
    expect(() => categoriesFor([...WEB_DOCTOR_EXTENSIONS, WEB_DOCTOR_EXTENSIONS[0]!])).toThrow("defined more than once");
  });

  it("publishes React facts in a valid extension document with line evidence and reasoning", () => {
    const { document } = extensions;
    expect(factDocumentProblems(document)).toEqual([]);
    expect(document.detector_release).toBe(WEB_DOCTOR_EXTENSION_RELEASE);
    expect(document.extensions).toEqual(WEB_DOCTOR_EXTENSIONS.map((extension) => ({ id: extension.id, bounded_negative: extension.boundedNegative })));
    const components = extensions.categories["web-doctor.components"]!;
    expect(components.state).toBe("inferred");
    expect(components.facts.map((fact) => fact.key)).toEqual([
      "src/App.tsx#App",
      "src/Header.jsx#Header",
      "src/orders/OrderList.tsx#OrderList",
      "src/orders/OrdersContext.tsx#OrdersProvider",
    ]);
    expect(components.search).toMatchObject({ complete: true, skipped: [] });
    const app = components.facts[0]!;
    expect(app.reasoning).toBe("A capitalized or default-exported function that returns JSX");
    expect(app.evidence.map((id) => document.evidence[id])).toEqual([
      expect.objectContaining({ path: "src/App.tsx", commit: null, detector: "web-doctor.react-components", rule: "web-doctor.component-shape", location: { kind: "lines", start: 6, end: 6 } }),
    ]);
    expect(extensions.categories["web-doctor.hooks"]!.facts.map((fact) => fact.key)).toEqual(["src/orders/useOrders.js#useOrders"]);
    const providers = extensions.categories["web-doctor.providers"]!;
    expect(providers.state).toBe("mixed");
    expect(providers.facts.map((fact) => [fact.key, fact.state])).toEqual([
      ["package:@salt-ds/core#SaltProvider", "inferred"],
      ["src/orders/OrdersContext.tsx#OrdersContext", "observed"],
    ]);
    expect(providers.facts[1]!.value).toMatchObject({ providers: ["src/orders/OrdersContext.tsx#OrdersProvider"], consumers: ["src/orders/useOrders.js#useOrders"] });
  });

  it("never overwrites or duplicates a shared category when merged with the unchanged shared document", () => {
    const merged = mergedCategories(shared.document, extensions);
    for (const category of SHARED_CATEGORIES) expect(merged[category.id], category.id).toBe(shared.document.categories[category.id]);
    for (const extension of WEB_DOCTOR_EXTENSIONS) expect(merged[extension.id]).toBe(extensions.categories[extension.id]);
    expect(Object.keys(merged)).toHaveLength(SHARED_CATEGORIES.length + WEB_DOCTOR_EXTENSIONS.length);
    expect(Object.keys(extensions.categories).sort()).toEqual(WEB_DOCTOR_EXTENSIONS.map((extension) => extension.id));
    expect(shared.document.extensions).toEqual([]);
    expect(digestOf(shared.document).digest).toBe(shared.documentDigest);
    expect(() => mergedCategories(shared.document, { ...extensions, categories: { ...extensions.categories, composition: shared.document.categories.composition! } })).toThrow("would overwrite a shared category");
  });

  it("identifies extension state by what the extensions assert, not by whole-tree inventory", () => {
    const { document, categories, index } = extensions;
    expect(extensions.digest).toBe(extensionStateDigest(document, categories, index));
    expect(extensionStateDigest({ ...document, inventory: { ...document.inventory, bytes: document.inventory.bytes + 1 } }, categories, index)).toBe(extensions.digest);
    const components = categories["web-doctor.components"]!;
    const altered = { ...categories, "web-doctor.components": { ...components, facts: components.facts.slice(1) } };
    expect(extensionStateDigest(document, altered, index)).not.toBe(extensions.digest);
    expect(extensionStateDigest(document, categories, { ...index, digest: "0".repeat(64) })).not.toBe(extensions.digest);
    expect(digestOf(document).digest).toBe(extensions.documentDigest);
  });
});
