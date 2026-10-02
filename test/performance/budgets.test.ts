import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { budgetViolations, percentile, type PerformanceBudgets } from "../../src/runtime/performance-budgets.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const budgets = JSON.parse(fs.readFileSync(path.join(ROOT, "performance", "budgets.json"), "utf8")) as PerformanceBudgets;
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "evidence", "performance-baseline.json"), "utf8")) as { runs: number; repositories: string[]; samples: Record<string, number[]>; summary: Record<string, { p95Ms: number }> };

describe("performance budgets", () => {
  it("budgets every operation the fleet baseline measured, with headroom above it", () => {
    expect(Object.keys(budgets.metrics).sort()).toEqual(Object.keys(baseline.samples).sort());
    expect(baseline.repositories).toHaveLength(8);
    for (const [metric, budget] of Object.entries(budgets.metrics)) {
      expect(baseline.samples[metric]!.length, metric).toBeGreaterThanOrEqual(baseline.runs * baseline.repositories.length);
      expect(budget.p95Ms, metric).toBeGreaterThanOrEqual(2 * baseline.summary[metric]!.p95Ms);
    }
    for (const interactive of ["incrementalQueryMs", "mcpResponseMs", "packageSnapshotLoadMs", "readerMs", "indexMs"]) expect(budgets.metrics[interactive]!.p95Ms).toBeLessThanOrEqual(1000);
    expect(budgetViolations(baseline.samples, budgets)).toEqual([]);
  });

  it("fails when an operation regresses past its budget or is not measured", () => {
    // A regression slows every run; one slow sample among 24 does not move the 95th percentile.
    const factor = Math.ceil((2 * budgets.metrics.incrementalQueryMs!.p95Ms) / baseline.summary.incrementalQueryMs!.p95Ms);
    const regressed = { ...baseline.samples, incrementalQueryMs: baseline.samples.incrementalQueryMs!.map((sample) => sample * factor) };
    const outlier = { ...baseline.samples, incrementalQueryMs: [...baseline.samples.incrementalQueryMs!.slice(1), budgets.metrics.incrementalQueryMs!.p95Ms * 10] };
    expect(budgetViolations(outlier, budgets)).toEqual([]);
    const missing = Object.fromEntries(Object.entries(baseline.samples).filter(([metric]) => metric !== "mcpResponseMs"));
    expect(budgetViolations(regressed, budgets).map((violation) => violation.metric)).toEqual(["incrementalQueryMs"]);
    expect(budgetViolations(missing, budgets)).toEqual([{ metric: "mcpResponseMs", p95Ms: null, budgetMs: 250, message: "mcpResponseMs was not measured" }]);
  });

  it("uses the nearest-rank 95th percentile", () => {
    expect(percentile(Array.from({ length: 20 }, (_, index) => index + 1), 95)).toBe(19);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 95)).toBeNaN();
  });
});
