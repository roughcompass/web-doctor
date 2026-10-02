/**
 * Approved performance budgets and the check that enforces them. Budgets are
 * 95th-percentile limits in milliseconds for each measured operation; a
 * measurement set violates a budget when its 95th percentile exceeds it, or
 * when a budgeted operation was not measured at all.
 */

export interface PerformanceBudgets {
  schema: "web-doctor.performance-budgets";
  schemaVersion: 1;
  approvedBy: string;
  approvedOn: string;
  basis: string;
  metrics: Record<string, { p95Ms: number; description: string }>;
  /** Targets for production-size applications, confirmed on pilot applications rather than the fleet benchmark. */
  serviceLevels?: { application: string; targets: Record<string, number>; verification: string };
}

export interface BudgetViolation {
  metric: string;
  p95Ms: number | null;
  budgetMs: number;
  message: string;
}

/** The value at a percentile of samples, by the nearest-rank method. */
export function percentile(samples: readonly number[], rank: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1))]!;
}

export function budgetViolations(samples: Readonly<Record<string, readonly number[]>>, budgets: PerformanceBudgets): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  for (const [metric, budget] of Object.entries(budgets.metrics).sort(([left], [right]) => (left < right ? -1 : 1))) {
    const measured = samples[metric] ?? [];
    if (measured.length === 0) {
      violations.push({ metric, p95Ms: null, budgetMs: budget.p95Ms, message: `${metric} was not measured` });
      continue;
    }
    const p95 = percentile(measured, 95);
    if (p95 > budget.p95Ms) violations.push({ metric, p95Ms: p95, budgetMs: budget.p95Ms, message: `${metric} p95 is ${p95} ms, over its ${budget.p95Ms} ms budget` });
  }
  return violations;
}
