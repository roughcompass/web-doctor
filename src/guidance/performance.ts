import { compareCodeUnits } from "@repo-facts/contract";
import { stableIdentifier, type ProfileEvidence } from "../contracts/index.js";
import type { IndexLocation, IndexedSymbol, IndexedUse, ProjectIndex } from "../facts/project-index.js";

/**
 * Performance guidance at three evidence levels:
 *
 * - A proven defect needs measurement: a supplied profile shows a component
 *   exceeding the commit budget in a named interaction.
 * - A static risk is a pattern whose effect is certain but whose cost is not,
 *   such as a new prop value on every render defeating a memo boundary.
 * - Measurement required covers patterns that cross no optimization boundary,
 *   where the only honest advice is to measure before changing anything.
 *
 * No observation claims an improvement. Improvement is established only by
 * profiling the same interaction again after a change.
 */

export type PerformanceClassification = "defect" | "risk" | "measurement_required";

export interface Measurement {
  interaction: string;
  source: string;
  component: string;
  commits: number;
  actualDurationMs: number;
  maxCommitMs: number;
  budgetMs: number;
}

export interface PerformanceObservation {
  id: string;
  kind: "hotspot" | "inline-prop";
  classification: PerformanceClassification;
  /** The component whose render creates the value, or the measured component. */
  symbol: string;
  element: IndexedUse | null;
  attribute: string | null;
  propKind: "function" | "object" | "array" | null;
  location: IndexLocation;
  reasoning: string;
  recommendation: string;
  measurement: Measurement | null;
  /** Never claimed from one run; only a second measurement of the same interaction establishes it. */
  improvement: null;
  verification: { kind: string; description: string }[];
}

export interface PerformanceAnalysis {
  observations: PerformanceObservation[];
  /** Profiled components that match no single indexed symbol. */
  unmatched: string[];
}

export function analyzePerformance(index: ProjectIndex, profile?: ProfileEvidence): PerformanceAnalysis {
  const symbols = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  const hotspots = new Map<string, Measurement>();
  const unmatched: string[] = [];
  for (const entry of profile?.components ?? []) {
    const symbol = resolveComponent(index, entry.component);
    if (symbol === undefined) {
      unmatched.push(entry.component);
      continue;
    }
    if (entry.maxCommitMs >= profile!.commitBudgetMs) {
      hotspots.set(symbol.id, { interaction: profile!.interaction, source: profile!.source, component: entry.component, commits: entry.commits, actualDurationMs: entry.actualDurationMs, maxCommitMs: entry.maxCommitMs, budgetMs: profile!.commitBudgetMs });
    }
  }
  const reprofile = (interaction: string) => ({ kind: "profile", description: `Profile "${interaction}" again after any change and compare commit durations for the same components` });
  const observations: PerformanceObservation[] = [];

  for (const [id, measurement] of hotspots) {
    const symbol = symbols.get(id)!;
    observations.push({
      id: stableIdentifier("perf", { kind: "hotspot", id, interaction: measurement.interaction }),
      kind: "hotspot",
      classification: "defect",
      symbol: id,
      element: null,
      attribute: null,
      propKind: null,
      location: symbol.location,
      reasoning: `Profiling "${measurement.interaction}" measured a ${measurement.maxCommitMs} ms commit in ${symbol.name}, over the ${measurement.budgetMs} ms budget, across ${measurement.commits} commits`,
      recommendation: `Find what makes ${symbol.name} expensive in this interaction before choosing a fix; its inline props and renders below are candidates`,
      measurement,
      improvement: null,
      verification: [reprofile(measurement.interaction)],
    });
  }

  for (const symbol of index.symbols) {
    for (const prop of symbol.inlineProps) {
      const target = prop.element.symbol === null ? undefined : symbols.get(prop.element.symbol);
      const memoized = target?.memoized === true;
      const measured = target === undefined ? undefined : hotspots.get(target.id);
      const noun = prop.kind === "function" ? "function" : prop.kind === "object" ? "object" : "array";
      const observation: Omit<PerformanceObservation, "id" | "classification" | "reasoning" | "recommendation" | "verification"> = {
        kind: "inline-prop",
        symbol: symbol.id,
        element: prop.element,
        attribute: prop.attribute,
        propKind: prop.kind,
        location: prop.location,
        measurement: measured ?? null,
        improvement: null,
      };
      const id = stableIdentifier("perf", { kind: "inline-prop", symbol: symbol.id, attribute: prop.attribute, location: prop.location });
      if (memoized) {
        observations.push({
          ...observation,
          id,
          classification: "risk",
          reasoning: `${prop.element.name} is wrapped in memo, but ${prop.attribute} receives a new ${noun} each time ${symbol.name} renders, so the memo never skips a render${measured === undefined ? "; how much that costs is not measured" : `; profiling "${measured.interaction}" measured ${prop.element.name} at ${measured.maxCommitMs} ms per commit`}`,
          recommendation: `If measurement shows ${prop.element.name} re-rendering matters, keep ${prop.attribute} stable across renders; otherwise the memo wrapper adds cost without benefit`,
          verification: [measured === undefined ? { kind: "profile", description: `Profile the interactions that re-render ${symbol.name} and check whether ${prop.element.name} commits are significant` } : reprofile(measured.interaction)],
        });
      } else {
        observations.push({
          ...observation,
          id,
          classification: "measurement_required",
          reasoning: `${prop.attribute} receives a new ${noun} each time ${symbol.name} renders, but ${prop.element.name} is not a proven optimization boundary, so the new value has no established cost`,
          recommendation: `Do not add memoization for this alone; measure the interaction first and change it only if ${prop.element.name} shows up as a cost`,
          verification: [{ kind: "profile", description: `Profile the interactions that re-render ${symbol.name} before changing ${prop.attribute}` }],
        });
      }
    }
  }
  return {
    observations: observations.sort((left, right) => compareCodeUnits(left.symbol, right.symbol) || left.location.line - right.location.line || left.location.column - right.location.column || compareCodeUnits(left.id, right.id)),
    unmatched: unmatched.sort(compareCodeUnits),
  };
}

function resolveComponent(index: ProjectIndex, component: string): IndexedSymbol | undefined {
  const exact = index.symbols.find((symbol) => symbol.id === component);
  if (exact !== undefined) return exact;
  const named = index.symbols.filter((symbol) => symbol.name === component && (symbol.kind === "component" || symbol.kind === "hook"));
  return named.length === 1 ? named[0] : undefined;
}
