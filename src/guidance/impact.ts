import { type DocumentFact, compareCodeUnits } from "@repo-facts/contract";
import type { FindingObligation, NormalizedFinding } from "../contracts/index.js";
import type { IndexedSymbol } from "../facts/project-index.js";
import type { ProjectSnapshot } from "../facts/project-snapshot.js";
import { factView, type FactView } from "../facts/queries.js";

/**
 * Shared-repair guidance. Equivalent findings (same provider and rule) are
 * traced to the application-owned components that produce them, using Web
 * Doctor's symbol references for source findings and route facts for
 * rendered ones. When one component accounts for findings in several
 * consumers, it is presented as the likely owner, with every consumer it
 * affects, the routes and tests that cover them, and the order of work: the
 * shared repair first, local edits only where findings remain. Shared
 * package and federation facts qualify what Web Doctor cannot see. Every
 * finding location and obligation is retained.
 */

type FindingLocation = NormalizedFinding["locations"][number];

export interface OwnerCandidate {
  symbol: string;
  name: string;
  path: string;
  /** How findings reach it: the flagged element renders it, it contains the finding, or a flagged route renders it. */
  via: ("usage" | "definition" | "route")[];
  covers: string[];
  certainty: "observed" | "inferred";
}

export interface AffectedConsumer {
  module: string;
  symbol: string | null;
  findings: string[];
  /** Whether a finding was reported here; unflagged consumers still change with a shared repair. */
  flagged: boolean;
}

export interface SharedRepair {
  provider: string;
  rule: string;
  findings: string[];
  /** Every location of every finding in the group. */
  locations: FindingLocation[];
  owner: (OwnerCandidate & { package: FactView | null; published: boolean; exposures: FactView[] }) | null;
  candidates: OwnerCandidate[];
  consumers: AffectedConsumer[];
  routes: FactView[];
  tests: FactView[];
  order: string[];
  verification: { kind: string; description: string; evidence: FactView | null }[];
  uncertainty: string[];
  obligations: FindingObligation[];
  modifiesProject: false;
}

export interface ImpactAnalysis {
  repairs: SharedRepair[];
  /** Findings no shared owner accounts for. */
  independent: string[];
}

const MAX_RENDER_DEPTH = 6;

export function sharedRepairs(input: { findings: readonly NormalizedFinding[]; snapshot: ProjectSnapshot }): ImpactAnalysis {
  const { snapshot } = input;
  const index = snapshot.extensions.index;
  const symbols = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  const routes = snapshot.extensions.categories["web-doctor.routes"]?.facts ?? [];
  const groups = new Map<string, NormalizedFinding[]>();
  for (const finding of [...input.findings].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const key = `${finding.provider.id}\0${finding.rule}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  const repairs: SharedRepair[] = [];
  const independent: string[] = [];
  for (const [, findings] of [...groups.entries()].sort(([left], [right]) => compareCodeUnits(left, right))) {
    const repair = findings.length < 2 ? null : repairFor(findings, snapshot, symbols, routes);
    if (repair === null) independent.push(...findings.map((finding) => finding.id));
    else repairs.push(repair);
  }
  return { repairs, independent: independent.sort(compareCodeUnits) };
}

function repairFor(findings: readonly NormalizedFinding[], snapshot: ProjectSnapshot, symbols: ReadonlyMap<string, IndexedSymbol>, routes: readonly DocumentFact[]): SharedRepair | null {
  const index = snapshot.extensions.index;
  const candidates = new Map<string, OwnerCandidate>();
  const sites = new Map<string, Set<string>>();
  const note = (symbol: IndexedSymbol, finding: NormalizedFinding, via: OwnerCandidate["via"][number]) => {
    const candidate = candidates.get(symbol.id) ?? { symbol: symbol.id, name: symbol.name, path: symbol.path, via: [], covers: [], certainty: "observed" as const };
    if (!candidate.via.includes(via)) candidate.via.push(via);
    if (!candidate.covers.includes(finding.id)) candidate.covers.push(finding.id);
    if (via === "route") candidate.certainty = "inferred";
    candidates.set(symbol.id, candidate);
  };
  for (const finding of findings) {
    const places = new Set<string>();
    for (const location of finding.locations) {
      if (location.kind === "source") {
        places.add(location.path);
        for (const reference of index.references) {
          if (reference.kind !== "jsx" || reference.path !== location.path || reference.location.line !== location.line) continue;
          const target = symbols.get(reference.symbol);
          if (target?.kind === "component") note(target, finding, "usage");
        }
        for (const symbol of index.symbols) {
          if (symbol.kind === "component" && symbol.path === location.path && symbol.location.line <= location.line && location.line <= symbol.location.endLine) note(symbol, finding, "definition");
        }
      } else if (location.route !== null) {
        places.add(`route:${location.route}`);
        for (const route of routes) {
          const value = route.value as { path?: { kind?: string; value?: string } | null; element?: { symbol?: string | null } | null };
          if (value.path?.kind !== "literal" || value.path.value !== location.route || typeof value.element?.symbol !== "string") continue;
          for (const symbol of renderClosure(value.element.symbol, symbols)) note(symbol, finding, "route");
        }
      }
    }
    sites.set(finding.id, places);
  }
  const distinctSites = new Set([...sites.values()].flatMap((places) => [...places]));
  if (distinctSites.size < 2) return null;

  const covering = [...candidates.values()].filter((candidate) => candidate.covers.length === findings.length);
  const direct = covering.filter((candidate) => !candidate.via.includes("route") || candidate.via.length > 1);
  const chosen = direct.length === 1 ? direct[0]! : direct.length === 0 && covering.length === 1 ? covering[0]! : null;
  const ranked = [...candidates.values()].sort((left, right) => right.covers.length - left.covers.length || compareCodeUnits(left.symbol, right.symbol));
  if (chosen === null && ranked.every((candidate) => candidate.covers.length < 2)) return null;

  const shared = snapshot.shared.status === "complete" ? snapshot.shared.document : null;
  const extensions = snapshot.extensions.document;
  const uncertainty: string[] = [];
  const rendered = findings.filter((finding) => finding.locations.every((location) => location.kind === "rendered"));
  if (rendered.length > 0) uncertainty.push(`${rendered.length} rendered ${rendered.length === 1 ? "finding maps" : "findings map"} to source only through route elements and the components they render`);
  if (chosen === null) uncertainty.push(covering.length > 1 ? `${covering.map((candidate) => candidate.name).join(", ")} each account for every finding; Web Doctor cannot tell which one produces them` : "No single component accounts for every finding");
  if (!index.complete) uncertainty.push("The source index is incomplete, so some consumers may be missing");

  let owner: SharedRepair["owner"] = null;
  if (chosen !== null) {
    const pkg = shared === null ? null : packageOf(chosen.path, shared.categories.package_identity?.facts ?? []);
    const published = shared !== null && pkg !== null && (shared.categories.packages_produced?.facts ?? []).some((fact) => (fact.value as { manifest?: unknown; published?: unknown }).manifest === pkg.key && (fact.value as { published?: unknown }).published === true);
    const exposures = (snapshot.extensions.categories["web-doctor.entry_points"]?.facts ?? []).filter((fact) => {
      const value = fact.value as { kind?: unknown; module?: unknown; components?: unknown };
      return value.kind === "federated-expose" && (value.module === chosen.path || (Array.isArray(value.components) && value.components.includes(chosen.symbol)));
    });
    if (published) uncertainty.push(`${String((pkg!.value as { name?: unknown }).name)} is published, so consumers outside this repository are not visible`);
    if (exposures.length > 0) uncertainty.push(`${chosen.name} is exposed to remote applications through module federation, and their use is not visible`);
    owner = { ...chosen, package: pkg === null || shared === null ? null : factView("shared", shared, "package_identity", pkg), published, exposures: exposures.map((fact) => factView("extension", extensions, "web-doctor.entry_points", fact)) };
  }

  const flaggedModules = new Map<string, string[]>();
  for (const finding of findings) {
    for (const location of finding.locations) if (location.kind === "source") flaggedModules.set(location.path, [...new Set([...(flaggedModules.get(location.path) ?? []), finding.id])]);
  }
  const consumerSymbol = new Map<string, string | null>();
  if (owner !== null) {
    for (const reference of index.references) {
      if (reference.symbol !== owner.symbol || reference.kind !== "jsx" || reference.path === owner.path) continue;
      if (!consumerSymbol.has(reference.path) || consumerSymbol.get(reference.path) === null) consumerSymbol.set(reference.path, reference.enclosing);
    }
  }
  for (const module of flaggedModules.keys()) if (!consumerSymbol.has(module) && module !== owner?.path) consumerSymbol.set(module, null);
  const consumers: AffectedConsumer[] = [...consumerSymbol.entries()].map(([module, symbol]) => ({ module, symbol, findings: (flaggedModules.get(module) ?? []).sort(compareCodeUnits), flagged: flaggedModules.has(module) })).sort((left, right) => compareCodeUnits(left.module, right.module));

  const consumerSymbols = new Set(consumers.flatMap((consumer) => (consumer.symbol === null ? [] : [consumer.symbol])));
  const flaggedRoutes = new Set(findings.flatMap((finding) => finding.locations.flatMap((location) => (location.kind === "rendered" && location.route !== null ? [location.route] : []))));
  const routeFacts = routes.filter((fact) => {
    const value = fact.value as { path?: { kind?: string; value?: string } | null; element?: { symbol?: string | null } | null };
    const element = value.element?.symbol ?? null;
    return (element !== null && (consumerSymbols.has(element) || element === owner?.symbol)) || (value.path?.kind === "literal" && flaggedRoutes.has(value.path.value!));
  });
  const modules = new Set([...(owner === null ? [] : [owner.path]), ...consumers.map((consumer) => consumer.module)]);
  const testFacts = (snapshot.extensions.categories["web-doctor.tests"]?.facts ?? []).filter((fact) => ((fact.value as { subjects?: string[] }).subjects ?? []).some((subject) => modules.has(subject)));
  const unflagged = consumers.filter((consumer) => !consumer.flagged).length;
  const flaggedConsumers = new Set([...sites.values()].flatMap((places) => [...places])).size;

  const provider = findings[0]!.provider.id;
  const rule = findings[0]!.rule;
  const order = owner === null
    ? [
      `Inspect ${ranked.filter((candidate) => candidate.covers.length > 1).map((candidate) => candidate.name).join(", ")} first; they account for several of these findings`,
      "Edit consumers only after confirming the shared component does not produce the finding",
    ]
    : [
      `Repair ${owner.name} in ${owner.path}; it accounts for ${findings.length} findings in ${flaggedConsumers} consumers`,
      `Run ${provider} ${rule} again across every affected consumer${unflagged > 0 ? `, including ${unflagged} without a finding` : ""}`,
      "Edit a consumer only where its finding remains after the shared repair",
    ];
  const verification = [
    ...testFacts.map((fact) => ({ kind: "test", description: `Run ${fact.key}`, evidence: factView("extension", extensions, "web-doctor.tests", fact) })),
    ...routeFacts.map((fact) => ({ kind: "rendered", description: `Check route ${String((fact.value as { path?: { value?: string } | null }).path?.value ?? fact.key)} after the repair`, evidence: factView("extension", extensions, "web-doctor.routes", fact) })),
    { kind: "check", description: `Run ${provider} ${rule} on ${[...modules].sort(compareCodeUnits).join(", ") || "the flagged routes"}`, evidence: null },
  ];
  const obligations = [...new Map(findings.flatMap((finding) => finding.obligations).map((obligation) => [obligation.control, obligation])).values()].sort((left, right) => compareCodeUnits(left.control, right.control));
  return {
    provider,
    rule,
    findings: findings.map((finding) => finding.id),
    locations: findings.flatMap((finding) => finding.locations).sort((left, right) => compareCodeUnits(placeOf(left), placeOf(right))),
    owner,
    candidates: ranked.map((candidate) => ({ ...candidate, covers: [...candidate.covers].sort(compareCodeUnits) })),
    consumers,
    routes: routeFacts.map((fact) => factView("extension", extensions, "web-doctor.routes", fact)),
    tests: testFacts.map((fact) => factView("extension", extensions, "web-doctor.tests", fact)),
    order,
    verification,
    uncertainty,
    obligations,
    modifiesProject: false,
  };
}

function placeOf(location: FindingLocation): string {
  return location.kind === "source" ? `${location.path}\0${String(location.line).padStart(8, "0")}\0${String(location.column).padStart(8, "0")}` : `\u{10ffff}${location.url}\0${location.state}`;
}

/** A component and the application components it renders, to a bounded depth. */
function renderClosure(root: string, symbols: ReadonlyMap<string, IndexedSymbol>): IndexedSymbol[] {
  const seen = new Map<string, IndexedSymbol>();
  let frontier = [root];
  for (let depth = 0; depth < MAX_RENDER_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const symbol = symbols.get(id);
      if (symbol === undefined || seen.has(id) || symbol.kind !== "component") continue;
      seen.set(id, symbol);
      for (const use of symbol.renders) if (use.symbol !== null) next.push(use.symbol);
    }
    frontier = next;
  }
  return [...seen.values()];
}

/** The workspace package whose manifest directory most closely contains a path. */
function packageOf(file: string, identities: readonly DocumentFact[]): DocumentFact | null {
  let best: DocumentFact | null = null;
  let length = -1;
  for (const fact of identities) {
    const directory = fact.key.includes("/") ? fact.key.slice(0, fact.key.lastIndexOf("/")) : "";
    if ((directory === "" || file.startsWith(`${directory}/`)) && directory.length > length) {
      best = fact;
      length = directory.length;
    }
  }
  return best;
}

