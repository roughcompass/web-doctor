import { type BlobContent, type Detector, type DetectorContext, type Evidence, compareCodeUnits } from "@repo-facts/contract";
import { type IndexLocation, type IndexedSymbol, type IndexedUse, type ProjectIndex, SOURCE_EXTENSIONS } from "./project-index.js";

/**
 * Extension detectors that publish the project index's React facts through
 * the shared detector contract: every fact cites line evidence from the
 * reader, inferred facts explain their reasoning, and each category records
 * the complete source surface it searched and anything it skipped.
 */

export const COMPONENTS = "web-doctor.components";
export const HOOKS = "web-doctor.hooks";
export const PROVIDERS = "web-doctor.providers";

const SOURCE_INPUTS = SOURCE_EXTENSIONS.map((extension) => `**/*${extension}`);

export function reactDetectors(index: ProjectIndex): Detector[] {
  return [
    {
      id: "web-doctor.source-index",
      version: "1",
      stage: "parse",
      inputs: SOURCE_INPUTS,
      categories: [],
      async run(context) {
        for (const entry of index.skipped) {
          if (entry.reason === "syntax_error") context.diagnostic(entry.path, "syntax_error", entry.detail);
          else if (entry.reason === "index_file_budget") context.diagnostic(entry.path, "file_budget_exhausted", entry.detail);
        }
      },
    },
    {
      id: "web-doctor.react-components",
      version: "1",
      stage: "architecture",
      inputs: SOURCE_INPUTS,
      categories: [COMPONENTS],
      async run(context) {
        for (const symbol of index.symbols.filter((candidate) => candidate.kind === "component")) {
          const evidence = await lineEvidence(context, "web-doctor.component-shape", [symbol.location]);
          if (evidence.length === 0) continue;
          context.fact({
            category: COMPONENTS,
            key: symbol.id,
            basis: "inferred",
            reasoning: symbol.reasoning ?? "The declaration has the shape of a React component",
            rule: "web-doctor.component-shape",
            evidence,
            value: {
              name: symbol.name,
              path: symbol.path,
              line: symbol.location.line,
              exported: symbol.exported,
              props: symbol.props?.map((prop) => ({ name: prop.name, optional: prop.optional, source: prop.source })) ?? null,
              props_certainty: symbol.propsCertainty,
              hooks: symbol.hooks.map(useValue),
              renders: symbol.renders.map(useValue),
              provides: symbol.provides,
              consumes: symbol.consumes,
            },
          });
        }
        search(context, index, COMPONENTS, "web-doctor.component-shape");
      },
    },
    {
      id: "web-doctor.react-hooks",
      version: "1",
      stage: "architecture",
      inputs: SOURCE_INPUTS,
      categories: [HOOKS],
      async run(context) {
        for (const symbol of index.symbols.filter((candidate) => candidate.kind === "hook")) {
          const evidence = await lineEvidence(context, "web-doctor.hook-name", [symbol.location]);
          if (evidence.length === 0) continue;
          context.fact({
            category: HOOKS,
            key: symbol.id,
            basis: "inferred",
            reasoning: symbol.reasoning ?? "The function is named like a React hook",
            rule: "web-doctor.hook-name",
            evidence,
            value: { name: symbol.name, path: symbol.path, line: symbol.location.line, exported: symbol.exported, hooks: symbol.hooks.map(useValue), consumes: symbol.consumes },
          });
        }
        search(context, index, HOOKS, "web-doctor.hook-name");
      },
    },
    {
      id: "web-doctor.react-providers",
      version: "1",
      stage: "architecture",
      inputs: SOURCE_INPUTS,
      categories: [PROVIDERS],
      async run(context) {
        const symbols = index.symbols;
        for (const contextSymbol of symbols.filter((candidate) => candidate.kind === "context")) {
          const providers = symbols.filter((candidate) => candidate.provides.includes(contextSymbol.id));
          const consumers = symbols.filter((candidate) => candidate.consumes.includes(contextSymbol.id));
          const evidence = await lineEvidence(context, "web-doctor.create-context", [contextSymbol.location, ...providers.map((provider) => provider.location)]);
          if (evidence.length === 0) continue;
          context.fact({
            category: PROVIDERS,
            key: contextSymbol.id,
            basis: "observed",
            rule: "web-doctor.create-context",
            evidence,
            value: { kind: "context", name: contextSymbol.name, path: contextSymbol.path, line: contextSymbol.location.line, providers: providers.map((entry) => entry.id), consumers: consumers.map((entry) => entry.id) },
          });
        }
        const packageProviders = new Map<string, { name: string; module: string; sites: { symbol: IndexedSymbol; use: IndexedUse }[] }>();
        for (const symbol of symbols) {
          for (const use of symbol.renders) {
            if (use.module === null || use.symbol !== null || !/Provider$/.test(use.name)) continue;
            const key = `package:${use.module}#${use.name}`;
            const entry = packageProviders.get(key) ?? { name: use.name, module: use.module, sites: [] };
            entry.sites.push({ symbol, use });
            packageProviders.set(key, entry);
          }
        }
        for (const [key, entry] of [...packageProviders.entries()].sort(([left], [right]) => compareCodeUnits(left, right))) {
          const evidence = await lineEvidence(context, "web-doctor.package-provider", entry.sites.map((site) => site.use.location));
          if (evidence.length === 0) continue;
          context.fact({
            category: PROVIDERS,
            key,
            basis: "inferred",
            reasoning: `Application components render ${entry.name}, a ${entry.module} element named as a provider; what it provides is defined by the package`,
            rule: "web-doctor.package-provider",
            evidence,
            value: { kind: "package", name: entry.name, module: entry.module, rendered_by: [...new Set(entry.sites.map((site) => site.symbol.id))].sort(compareCodeUnits) },
          });
        }
        search(context, index, PROVIDERS, "web-doctor.create-context");
      },
    },
  ];
}

function useValue(use: IndexedUse) {
  return { name: use.name, symbol: use.symbol, module: use.module };
}

async function lineEvidence(context: DetectorContext, rule: string, locations: readonly IndexLocation[]): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    const key = `${location.path}:${location.line}:${location.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const content: BlobContent | null = await context.text(location.path);
    if (content !== null) evidence.push(context.lines(content, rule, location.line, location.endLine));
  }
  return evidence;
}

/** Every source path the index considered is the surface; index skips and truncation leave the search incomplete. */
export function search(context: DetectorContext, index: ProjectIndex, category: string, rule: string): void {
  const skipped = [...new Set(index.skipped.map((entry) => entry.path))].sort(compareCodeUnits);
  const surface = [...new Set([...index.modules.map((module) => module.path), ...skipped])].sort(compareCodeUnits);
  context.search({ category, rule, surface, complete: !index.truncated.files && !index.truncated.symbols, skipped });
}
