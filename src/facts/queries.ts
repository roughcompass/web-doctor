import { type DocumentFact, type FactDocument, type ServiceDependency, compareCodeUnits } from "@repo-facts/contract";
import { canonicalJson, sha256 } from "../contracts/index.js";
import type { IndexLocation, IndexedProp, IndexedReference, IndexedSymbol, ProjectIndex, ReferenceKind } from "./project-index.js";
import type { ProjectSnapshot } from "./project-snapshot.js";

/**
 * Task-scoped questions over one project snapshot. Every answer carries the
 * evidence behind each item, both provenance chains (the shared detector
 * release and Web Doctor's extension state), a deterministic page with its
 * total count, and a continuation bound to the exact snapshot it came from.
 * Portions a static reading cannot establish are listed as unresolved.
 */

export const QUERY_RESULT_SCHEMA = "web-doctor.query-result";
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 500;

export type QueryName =
  | "project_overview"
  | "explain_symbol"
  | "data_path"
  | "usages"
  | "runtime_boundaries"
  | "tests"
  | "service_dependencies"
  | "verification_commands";

export type QueryParameters = Readonly<Record<string, string | number | null>>;

export class QueryError extends Error {
  override readonly name = "QueryError";

  constructor(readonly code: "invalid_continuation" | "stale_continuation" | "invalid_limit", message: string) {
    super(message);
  }
}

export interface PageOptions {
  limit?: number;
  continuation?: string;
}

export interface EvidenceView {
  id: string;
  path: string;
  lines: { start: number; end: number } | null;
  pointer: string | null;
  rule: string;
  detector: string;
}

export interface FactView {
  source: "shared" | "extension";
  category: string;
  key: string;
  state: string;
  value: unknown;
  rule: string;
  reasoning: string | null;
  evidence: EvidenceView[];
  candidates: { value: unknown; rule: string; evidence: EvidenceView[] }[] | null;
}

export interface QueryProvenance {
  snapshotDigest: string;
  treeDigest: string;
  shared: {
    status: "complete" | "incomplete";
    reason: string | null;
    detectorRelease: string | null;
    configurationDigest: string | null;
    factDocumentDigest: string | null;
    incompleteCategories: string[];
  };
  extensions: {
    release: string;
    documentDigest: string;
    indexDigest: string;
    stateDigest: string;
    incompleteCategories: string[];
  };
}

export interface QueryPage {
  limit: number;
  offset: number;
  returned: number;
  total: number;
  truncated: boolean;
  continuation: string | null;
}

export interface Unresolved {
  subject: string;
  reason: string;
}

export interface Narrowing {
  parameter: string;
  values: { value: string; count: number }[];
}

export interface QueryResult<Item> {
  schema: typeof QUERY_RESULT_SCHEMA;
  schemaVersion: 1;
  query: QueryName;
  parameters: QueryParameters;
  summary: Record<string, unknown> | null;
  items: Item[];
  page: QueryPage;
  provenance: QueryProvenance;
  unresolved: Unresolved[];
  narrowing: Narrowing[];
}

export interface CategorySummary {
  id: string;
  source: "shared" | "extension";
  state: string;
  facts: number;
  complete: boolean;
  skipped: number;
  keys: string[];
}

export function projectOverview(snapshot: ProjectSnapshot, options: PageOptions = {}): QueryResult<CategorySummary> {
  const categories: CategorySummary[] = [];
  const shared = sharedDocument(snapshot);
  const summarize = (source: CategorySummary["source"], id: string, category: FactDocument["categories"][string]) => categories.push({
    id,
    source,
    state: category.state,
    facts: category.facts.length,
    complete: category.search.complete && category.search.skipped.length === 0,
    skipped: category.search.skipped.length,
    keys: category.facts.slice(0, 5).map((fact) => fact.key),
  });
  if (shared !== null) for (const [id, category] of Object.entries(shared.categories)) summarize("shared", id, category);
  for (const [id, category] of Object.entries(snapshot.extensions.categories)) summarize("extension", id, category);
  categories.sort((left, right) => compareCodeUnits(left.id, right.id));
  const facts = (category: string) => (shared?.categories[category]?.facts ?? []).map((fact) => fact.key);
  const index = snapshot.extensions.index;
  const summary = {
    root: snapshot.root,
    package_managers: facts("package_managers"),
    frameworks: facts("frameworks"),
    build_tools: facts("build_tools"),
    test_frameworks: facts("test_frameworks"),
    runtime_requirements: facts("runtime_requirements"),
    verification_commands: facts("verification_commands").length,
    service_dependencies: shared?.service_dependencies.length ?? 0,
    modules: index.modules.length,
    components: index.symbols.filter((symbol) => symbol.kind === "component").length,
    hooks: index.symbols.filter((symbol) => symbol.kind === "hook").length,
    entry_points: snapshot.extensions.categories["web-doctor.entry_points"]?.facts.length ?? 0,
    tests: snapshot.extensions.categories["web-doctor.tests"]?.facts.length ?? 0,
    skipped_inputs: snapshot.shared.status === "complete" ? snapshot.shared.skippedInputs.length : null,
    excluded_paths: snapshot.exclusions.length,
  };
  return result(snapshot, "project_overview", {}, categories, options, { summary, unresolved: [...sharedUnresolved(snapshot), ...categoryUnresolved(snapshot, "all")] });
}

export interface SymbolExplanation {
  symbol: IndexedSymbol;
  fact: FactView | null;
  references: { total: number; returned: number; byKind: Record<string, number>; items: IndexedReference[] };
}

export function explainSymbol(snapshot: ProjectSnapshot, parameters: { symbol: string; referenceLimit?: number }, options: PageOptions = {}): QueryResult<SymbolExplanation> {
  const index = snapshot.extensions.index;
  const referenceLimit = boundedLimit(parameters.referenceLimit ?? 20);
  const matches = findSymbols(index, parameters.symbol);
  const items = matches.map((symbol): SymbolExplanation => {
    const references = referencesTo(index, symbol.id);
    const byKind: Record<string, number> = {};
    for (const reference of references) byKind[reference.kind] = (byKind[reference.kind] ?? 0) + 1;
    return { symbol, fact: extensionFactFor(snapshot, symbol.id), references: { total: references.length, returned: Math.min(references.length, referenceLimit), byKind, items: references.slice(0, referenceLimit) } };
  });
  const unresolved = matches.length === 0 ? [{ subject: parameters.symbol, reason: "No indexed top-level symbol has this id or name" }] : [];
  return result(snapshot, "explain_symbol", { symbol: parameters.symbol, referenceLimit }, items, options, { unresolved: [...unresolved, ...indexUnresolved(index)] });
}

export function usages(snapshot: ProjectSnapshot, parameters: { symbol: string; kind?: ReferenceKind; path?: string }, options: PageOptions = {}): QueryResult<IndexedReference> {
  const index = snapshot.extensions.index;
  const matches = findSymbols(index, parameters.symbol);
  const unresolved: Unresolved[] = [];
  if (matches.length !== 1) unresolved.push({ subject: parameters.symbol, reason: matches.length === 0 ? "No indexed top-level symbol has this id or name" : `The name matches ${matches.length} symbols; pass one id: ${matches.map((match) => match.id).join(", ")}` });
  const all = matches.length === 1 ? referencesTo(index, matches[0]!.id) : [];
  const filtered = all.filter((reference) => (parameters.kind === undefined || reference.kind === parameters.kind) && (parameters.path === undefined || reference.path === parameters.path || reference.path.startsWith(`${parameters.path.replace(/\/$/, "")}/`)));
  const narrowing = [countBy("kind", filtered.map((reference) => reference.kind)), countBy("path", filtered.map((reference) => reference.path))];
  if (index.truncated.references) unresolved.push({ subject: "references", reason: `The index kept ${index.references.length} of ${index.totals.references} references; usages beyond the index budget are not listed` });
  return result(snapshot, "usages", { symbol: parameters.symbol, kind: parameters.kind ?? null, path: parameters.path ?? null }, filtered, options, { unresolved: [...unresolved, ...indexUnresolved(index)], narrowing });
}

export type DataPathSegment =
  | { kind: "prop"; symbol: string; name: string; optional: boolean; source: IndexedProp["source"]; location: IndexLocation | null }
  | { kind: "caller"; symbol: string; caller: string | null; path: string; location: IndexLocation; attributes: string[] | null }
  | { kind: "hook"; symbol: string; name: string; resolution: "local" | "package" | "unresolved"; target: string | null; location: IndexLocation }
  | { kind: "context"; symbol: string; context: string; providers: string[]; providerSites: { provider: string; path: string; location: IndexLocation; caller: string | null }[] }
  | { kind: "import"; symbol: string; path: string; specifier: string | null; target: unknown; location: IndexLocation }
  | { kind: "service"; symbol: string; service: string; key: string; client: unknown; endpoint: string; callSites: EvidenceView[] };

/**
 * How a component or hook receives data, as far as source relationships
 * show: its props and who passes them, the hooks it calls (following local
 * hooks), the contexts it reads and where they are provided, the modules it
 * imports, and Service Dependencies called from those modules. Runtime-only
 * portions are listed as unresolved.
 */
export function dataPath(snapshot: ProjectSnapshot, parameters: { symbol: string }, options: PageOptions = {}): QueryResult<DataPathSegment> {
  const index = snapshot.extensions.index;
  const matches = findSymbols(index, parameters.symbol);
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? "No indexed top-level symbol has this id or name" : `The name matches ${matches.length} symbols; pass one id: ${matches.map((match) => match.id).join(", ")}`;
    return result(snapshot, "data_path", { symbol: parameters.symbol }, [], options, { unresolved: [{ subject: parameters.symbol, reason }] });
  }
  const root = matches[0]!;
  const segments: DataPathSegment[] = [];
  const unresolved: Unresolved[] = [];
  const symbols = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));

  if (root.propsCertainty === "unknown") unresolved.push({ subject: `${root.id} props`, reason: "The props this symbol accepts could not be established statically" });
  for (const prop of root.props ?? []) segments.push({ kind: "prop", symbol: root.id, name: prop.name, optional: prop.optional, source: prop.source, location: prop.location });
  for (const reference of referencesTo(index, root.id).filter((candidate) => candidate.kind === "jsx")) {
    segments.push({ kind: "caller", symbol: root.id, caller: reference.enclosing, path: reference.path, location: reference.location, attributes: reference.attributes });
    if (reference.attributes?.includes("...")) unresolved.push({ subject: `${reference.path}:${reference.location.line}`, reason: "Props passed through a spread are not statically enumerable" });
  }

  const visited = new Set<string>();
  const files = new Set<string>();
  const visit = (symbol: IndexedSymbol, depth: number) => {
    if (visited.has(symbol.id) || depth > 3) return;
    visited.add(symbol.id);
    files.add(symbol.path);
    for (const hook of symbol.hooks) {
      const resolution = hook.symbol !== null ? "local" : hook.module !== null ? "package" : "unresolved";
      segments.push({ kind: "hook", symbol: symbol.id, name: hook.name, resolution, target: hook.symbol ?? hook.module, location: hook.location });
      if (resolution === "package" && !["useState", "useReducer", "useRef", "useMemo", "useCallback", "useEffect", "useLayoutEffect", "useContext", "useId", "use"].includes(hook.name)) {
        unresolved.push({ subject: `${hook.name} in ${symbol.id}`, reason: `${hook.name} from ${hook.module} returns data determined at runtime` });
      }
      if (resolution === "unresolved") unresolved.push({ subject: `${hook.name} in ${symbol.id}`, reason: "The hook could not be resolved to a symbol or package" });
      const local = hook.symbol === null ? undefined : symbols.get(hook.symbol);
      if (local !== undefined) visit(local, depth + 1);
    }
    for (const contextId of symbol.consumes) {
      const providers = index.symbols.filter((candidate) => candidate.provides.includes(contextId)).map((candidate) => candidate.id);
      const providerSites = providers.flatMap((provider) => referencesTo(index, provider).filter((reference) => reference.kind === "jsx").map((reference) => ({ provider, path: reference.path, location: reference.location, caller: reference.enclosing })));
      segments.push({ kind: "context", symbol: symbol.id, context: contextId, providers, providerSites });
      if (providers.length === 0) unresolved.push({ subject: contextId, reason: "No provider for this context appears in source; a host may provide it at runtime, or the default value applies" });
      unresolved.push({ subject: `${contextId} value`, reason: "The value a provider passes is computed at runtime" });
    }
  };
  visit(root, 0);

  const modules = new Map(index.modules.map((module) => [module.path, module]));
  for (const file of [...files].sort(compareCodeUnits)) {
    for (const imported of modules.get(file)?.imports ?? []) {
      if (imported.typeOnly) continue;
      segments.push({ kind: "import", symbol: root.id, path: file, specifier: imported.specifier, target: imported.target, location: imported.location });
      if (imported.target.kind === "module") files.add(imported.target.path);
    }
  }
  const shared = sharedDocument(snapshot);
  if (shared === null) unresolved.push({ subject: "Service Dependencies", reason: "Shared repository facts are incomplete, so Service Dependencies are unavailable" });
  for (const service of shared?.service_dependencies ?? []) {
    const callSites = service.call_sites.map((id) => evidenceView(shared!, id)).filter((view): view is EvidenceView => view !== null);
    if (!callSites.some((site) => files.has(site.path))) continue;
    segments.push({ kind: "service", symbol: root.id, service: service.id, key: service.key, client: service.client, endpoint: service.endpoint.state, callSites });
    if (!service.characterizable) unresolved.push({ subject: service.key, reason: `The Service Dependency is missing ${service.missing_evidence.join(", ")}` });
  }
  return result(snapshot, "data_path", { symbol: parameters.symbol }, segments, options, { unresolved: dedupe(unresolved) });
}

export function runtimeBoundaries(snapshot: ProjectSnapshot, parameters: { category?: string } = {}, options: PageOptions = {}): QueryResult<FactView> {
  const shared = sharedDocument(snapshot);
  const views: FactView[] = [];
  for (const category of ["composition", "runtime_integrations", "served_origins", "egress_routes"]) {
    if (shared !== null) for (const fact of shared.categories[category]?.facts ?? []) views.push(factView("shared", shared, category, fact));
  }
  for (const category of ["web-doctor.entry_points", "web-doctor.source_relationships"]) {
    for (const fact of snapshot.extensions.categories[category]?.facts ?? []) views.push(factView("extension", snapshot.extensions.document, category, fact));
  }
  const filtered = views.filter((view) => parameters.category === undefined || view.category === parameters.category);
  return result(snapshot, "runtime_boundaries", { category: parameters.category ?? null }, filtered, options, {
    unresolved: [...sharedUnresolved(snapshot), ...categoryUnresolved(snapshot, ["composition", "runtime_integrations", "served_origins", "egress_routes", "web-doctor.entry_points", "web-doctor.source_relationships"]), { subject: "runtime behavior", reason: "These are static source and configuration relationships; runtime mounting, loading, and message traffic require measurement" }],
    narrowing: [countBy("category", filtered.map((view) => view.category))],
  });
}

export function tests(snapshot: ProjectSnapshot, parameters: { path?: string; symbol?: string } = {}, options: PageOptions = {}): QueryResult<FactView> {
  const facts = snapshot.extensions.categories["web-doctor.tests"]?.facts ?? [];
  const matching = facts.filter((fact) => {
    const value = fact.value as { subjects?: string[]; symbols?: string[] };
    return (parameters.path === undefined || (value.subjects ?? []).includes(parameters.path) || fact.key === parameters.path)
      && (parameters.symbol === undefined || (value.symbols ?? []).includes(parameters.symbol));
  });
  const shared = sharedDocument(snapshot);
  const summary = {
    test_frameworks: (shared?.categories.test_frameworks?.facts ?? []).map((fact) => fact.key),
    test_commands: (shared?.categories.verification_commands?.facts ?? []).filter((fact) => kindsOf(fact).includes("test")).map((fact) => fact.key),
    category_state: snapshot.extensions.categories["web-doctor.tests"]?.state ?? "unknown",
  };
  const unresolved = [...sharedUnresolved(snapshot), ...categoryUnresolved(snapshot, ["web-doctor.tests", "test_frameworks"])];
  if (matching.length === 0 && (parameters.path !== undefined || parameters.symbol !== undefined)) unresolved.push({ subject: parameters.symbol ?? parameters.path!, reason: "No test file imports this module or references this symbol directly; indirect coverage is not established statically" });
  return result(snapshot, "tests", { path: parameters.path ?? null, symbol: parameters.symbol ?? null }, matching.map((fact) => factView("extension", snapshot.extensions.document, "web-doctor.tests", fact)), options, { summary, unresolved });
}

export interface ServiceView {
  id: string;
  key: string;
  client: ServiceDependency["client"];
  characterizable: boolean;
  missingEvidence: string[];
  access: ServiceDependency["access"];
  endpoint: { state: string; value: unknown };
  operations: { state: string; value: unknown };
  callSites: EvidenceView[];
}

export function serviceDependencies(snapshot: ProjectSnapshot, parameters: { path?: string } = {}, options: PageOptions = {}): QueryResult<ServiceView> {
  const shared = sharedDocument(snapshot);
  const services = (shared?.service_dependencies ?? []).map((service): ServiceView => ({
    id: service.id,
    key: service.key,
    client: service.client,
    characterizable: service.characterizable,
    missingEvidence: service.missing_evidence,
    access: service.access,
    endpoint: { state: service.endpoint.state, value: service.endpoint.value },
    operations: { state: service.operations.state, value: service.operations.value },
    callSites: service.call_sites.map((id) => evidenceView(shared!, id)).filter((view): view is EvidenceView => view !== null),
  })).filter((service) => parameters.path === undefined || service.callSites.some((site) => site.path === parameters.path || site.path.startsWith(`${parameters.path!.replace(/\/$/, "")}/`)));
  const unresolved = [...sharedUnresolved(snapshot), ...categoryUnresolved(snapshot, ["access_signals", "api_contracts", "egress_routes", "runtime_integrations", "served_origins"]), ...services.filter((service) => !service.characterizable).map((service) => ({ subject: service.key, reason: `Missing ${service.missingEvidence.join(", ")}` }))];
  return result(snapshot, "service_dependencies", { path: parameters.path ?? null }, services, options, { unresolved });
}

export function verificationCommands(snapshot: ProjectSnapshot, parameters: { kind?: string } = {}, options: PageOptions = {}): QueryResult<FactView> {
  const shared = sharedDocument(snapshot);
  const facts = (shared?.categories.verification_commands?.facts ?? []).filter((fact) => parameters.kind === undefined || kindsOf(fact).includes(parameters.kind));
  return result(snapshot, "verification_commands", { kind: parameters.kind ?? null }, facts.map((fact) => factView("shared", shared!, "verification_commands", fact)), options, {
    summary: { executed: false, note: "Commands are reported as declared; Web Doctor never runs them" },
    unresolved: [...sharedUnresolved(snapshot), ...categoryUnresolved(snapshot, ["verification_commands"])],
    narrowing: [countBy("kind", facts.flatMap(kindsOf))],
  });
}

export function queryProvenance(snapshot: ProjectSnapshot): QueryProvenance {
  const shared = snapshot.shared;
  return {
    snapshotDigest: snapshot.digest,
    treeDigest: snapshot.treeDigest,
    shared: {
      status: shared.status,
      reason: shared.status === "incomplete" ? `${shared.reason}: ${shared.problems.join("; ")}` : null,
      detectorRelease: shared.provenance?.detectorRelease ?? null,
      configurationDigest: shared.provenance?.configurationDigest ?? null,
      factDocumentDigest: shared.status === "complete" ? shared.documentDigest : null,
      incompleteCategories: shared.status === "complete" ? shared.incompleteCategories : [],
    },
    extensions: {
      release: snapshot.extensions.release,
      documentDigest: snapshot.extensions.documentDigest,
      indexDigest: snapshot.extensions.index.digest,
      stateDigest: snapshot.extensions.digest,
      incompleteCategories: Object.entries(snapshot.extensions.categories).filter(([, category]) => !category.search.complete || category.search.skipped.length > 0).map(([id]) => id).sort(compareCodeUnits),
    },
  };
}

function result<Item>(
  snapshot: ProjectSnapshot,
  query: QueryName,
  parameters: QueryParameters,
  all: readonly Item[],
  options: PageOptions,
  extra: { summary?: Record<string, unknown>; unresolved?: Unresolved[]; narrowing?: Narrowing[] } = {},
): QueryResult<Item> {
  const limit = boundedLimit(options.limit ?? DEFAULT_QUERY_LIMIT);
  const offset = options.continuation === undefined ? 0 : decodeContinuation(options.continuation, query, parameters, snapshot.digest);
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  return {
    schema: QUERY_RESULT_SCHEMA,
    schemaVersion: 1,
    query,
    parameters,
    summary: extra.summary ?? null,
    items,
    page: { limit, offset, returned: items.length, total: all.length, truncated: next < all.length, continuation: next < all.length ? encodeContinuation(query, parameters, next, snapshot.digest) : null },
    provenance: queryProvenance(snapshot),
    unresolved: extra.unresolved ?? [],
    narrowing: next < all.length || offset > 0 ? (extra.narrowing ?? []).filter((entry) => entry.values.length > 1) : [],
  };
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) throw new QueryError("invalid_limit", `Limits must be integers from 1 to ${MAX_QUERY_LIMIT}`);
  return limit;
}

/** A continuation names the query, its parameters, the next offset, and the snapshot it pages through. */
export function encodeContinuation(query: QueryName, parameters: QueryParameters, offset: number, snapshotDigest: string): string {
  return Buffer.from(canonicalJson({ v: 1, q: query, p: sha256(canonicalJson(parameters)), o: offset, s: snapshotDigest }), "utf8").toString("base64url");
}

function decodeContinuation(token: string, query: QueryName, parameters: QueryParameters, snapshotDigest: string): number {
  let decoded: { v?: unknown; q?: unknown; p?: unknown; o?: unknown; s?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as typeof decoded;
  } catch {
    throw new QueryError("invalid_continuation", "The continuation is not a Web Doctor continuation");
  }
  if (decoded.v !== 1 || decoded.q !== query || decoded.p !== sha256(canonicalJson(parameters)) || typeof decoded.o !== "number" || !Number.isSafeInteger(decoded.o) || decoded.o < 0) {
    throw new QueryError("invalid_continuation", "The continuation belongs to a different query or parameters");
  }
  if (decoded.s !== snapshotDigest) throw new QueryError("stale_continuation", "The project changed since this continuation was issued; repeat the query from the start");
  return decoded.o;
}

function sharedDocument(snapshot: ProjectSnapshot): FactDocument | null {
  return snapshot.shared.status === "complete" ? snapshot.shared.document : null;
}

function sharedUnresolved(snapshot: ProjectSnapshot): Unresolved[] {
  return snapshot.shared.status === "complete" ? [] : [{ subject: "shared repository facts", reason: `${snapshot.shared.reason}: ${snapshot.shared.problems.join("; ")}` }];
}

/**
 * Categories a query reads whose search was incomplete or skipped inputs, so
 * an answer built from them is never presented as complete.
 */
function categoryUnresolved(snapshot: ProjectSnapshot, categories: readonly string[] | "all"): Unresolved[] {
  const shared = sharedDocument(snapshot);
  const sources: [string, FactDocument["categories"]][] = [...(shared === null ? [] : [["shared", shared.categories] as [string, FactDocument["categories"]]]), ["extension", snapshot.extensions.categories]];
  const found: Unresolved[] = [];
  for (const [source, entries] of sources) {
    for (const [id, category] of Object.entries(entries).sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (categories !== "all" && !categories.includes(id)) continue;
      if (category.search.complete && category.search.skipped.length === 0) continue;
      const skipped = category.search.skipped.length;
      found.push({ subject: `${source} category ${id}`, reason: skipped > 0 ? `${skipped} ${skipped === 1 ? "input was" : "inputs were"} skipped while searching it` : "Its search did not complete" });
    }
  }
  return found;
}

function indexUnresolved(index: ProjectIndex): Unresolved[] {
  return index.complete ? [] : [{ subject: "source index", reason: `The index is incomplete: ${index.skipped.length} source inputs were skipped${index.truncated.files || index.truncated.symbols ? " and limits truncated it" : ""}` }];
}

function findSymbols(index: ProjectIndex, query: string): IndexedSymbol[] {
  const exact = index.symbols.filter((symbol) => symbol.id === query);
  return exact.length > 0 ? exact : index.symbols.filter((symbol) => symbol.name === query);
}

function referencesTo(index: ProjectIndex, symbol: string): IndexedReference[] {
  return index.references.filter((reference) => reference.symbol === symbol);
}

function extensionFactFor(snapshot: ProjectSnapshot, key: string): FactView | null {
  for (const [category, entry] of Object.entries(snapshot.extensions.categories)) {
    const fact = entry.facts.find((candidate) => candidate.key === key);
    if (fact !== undefined) return factView("extension", snapshot.extensions.document, category, fact);
  }
  return null;
}

export function factView(source: FactView["source"], document: FactDocument, category: string, fact: DocumentFact): FactView {
  const views = (ids: readonly string[]) => ids.map((id) => evidenceView(document, id)).filter((view): view is EvidenceView => view !== null);
  return {
    source,
    category,
    key: fact.key,
    state: fact.state,
    value: fact.value,
    rule: fact.rule,
    reasoning: fact.reasoning ?? null,
    evidence: views(fact.evidence),
    candidates: fact.candidates === undefined ? null : fact.candidates.map((candidate) => ({ value: candidate.value, rule: candidate.rule, evidence: views(candidate.evidence) })),
  };
}

function evidenceView(document: FactDocument, id: string): EvidenceView | null {
  const evidence = document.evidence[id];
  if (evidence === undefined) return null;
  return {
    id,
    path: evidence.path,
    lines: evidence.location.kind === "lines" ? { start: evidence.location.start, end: evidence.location.end } : null,
    pointer: evidence.location.kind === "pointer" ? evidence.location.pointer : null,
    rule: evidence.rule,
    detector: evidence.detector,
  };
}

function kindsOf(fact: DocumentFact): string[] {
  const kinds = (fact.value as { kinds?: unknown }).kinds;
  return Array.isArray(kinds) ? kinds.filter((kind): kind is string => typeof kind === "string") : [];
}

function countBy(parameter: string, values: readonly string[]): Narrowing {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return { parameter, values: [...counts.entries()].map(([value, count]) => ({ value, count })).sort((left, right) => right.count - left.count || compareCodeUnits(left.value, right.value)).slice(0, 20) };
}

function dedupe(unresolved: readonly Unresolved[]): Unresolved[] {
  const seen = new Map<string, Unresolved>();
  for (const entry of unresolved) seen.set(`${entry.subject}\0${entry.reason}`, entry);
  return [...seen.values()];
}
