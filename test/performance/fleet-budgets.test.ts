import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetViolations, type PerformanceBudgets } from "../../src/runtime/performance-budgets.js";
import { writePerformanceRegistry } from "../support/performance-registry.js";

/**
 * Measures the fleet against the approved budgets. Timing is only meaningful
 * without other load, so this runs with `npm run test:performance`, which
 * sets WEB_DOCTOR_PERFORMANCE=1 and runs it alone.
 */

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const FLEET = process.env.WEB_DOCTOR_FLEET_ROOT ?? path.resolve(ROOT, "../fleet");
const enabled = process.env.WEB_DOCTOR_PERFORMANCE === "1" && fs.existsSync(FLEET);

describe.runIf(enabled)("fleet performance budgets", () => {
  let workspace: string;
  let measurement: { samples: Record<string, number[]>; violations: { message: string }[] };
  let exitCode = 0;

  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "web-doctor-performance-budgets-"));
    const registry = await writePerformanceRegistry(workspace);
    const out = path.join(workspace, "measurement.json");
    try {
      await execFileAsync(process.execPath, [path.join(ROOT, "scripts", "measure-performance.mjs"), "--registry", registry, "--runs", "3", "--out", out, "--check", FLEET], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      exitCode = (error as { code?: number }).code ?? 1;
    }
    measurement = JSON.parse(fs.readFileSync(out, "utf8"));
  }, 1_800_000);

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("keeps every operation within its approved budget", () => {
    expect(measurement.violations.map((violation) => violation.message)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("would fail the same measurements against budgets they exceed", () => {
    const budgets = JSON.parse(fs.readFileSync(path.join(ROOT, "performance", "budgets.json"), "utf8")) as PerformanceBudgets;
    const tightened = { ...budgets, metrics: Object.fromEntries(Object.entries(budgets.metrics).map(([metric, budget]) => [metric, { ...budget, p95Ms: 0 }])) };
    expect(budgetViolations(measurement.samples, tightened).map((violation) => violation.metric).sort()).toEqual(Object.keys(budgets.metrics).sort());
  });
});
