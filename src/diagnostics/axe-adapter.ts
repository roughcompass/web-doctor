import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import semver from "semver";
import type { ProviderCapability, ProviderCompleteness } from "../contracts/index.js";
import type { AxeTaskInput, AxeTaskOutput } from "./axe-task.js";
import type { FindingDraft } from "./finding.js";
import { unavailable, type ProviderAdapter, type ProviderContext, type ProviderExecution, type ProviderPlan } from "./providers.js";
import { describeTarget, validateRuntimeRequest } from "./runtime-request.js";
import { DEFAULT_WORKER_LIMITS, compiledModule, runWorker, type WorkerLimits } from "./worker.js";

/**
 * The approved axe provider: rendered accessibility checks with axe-core in
 * Playwright's Chromium, run in a bounded worker granted a browser and
 * network access. It runs only for an authorized runtime request, checks only
 * rules both the approved ruleset and effective policy name, and treats rules
 * axe could not decide as partial evidence rather than a clean result.
 */

export const AXE_ENGINE = "axe-core";
const require = createRequire(import.meta.url);

export interface AxeAdapterOptions {
  limits?: WorkerLimits;
  /** Where Playwright's browsers are installed; defaults to PLAYWRIGHT_BROWSERS_PATH or the platform cache. */
  browsersPath?: string;
}

export class AxeAdapter implements ProviderAdapter {
  readonly engine = AXE_ENGINE;

  constructor(private readonly options: AxeAdapterOptions = {}) {}

  async run(plans: readonly ProviderPlan[], context: ProviderContext): Promise<ProviderExecution[]> {
    const executions: ProviderExecution[] = [];
    for (const plan of plans) executions.push(await this.runPlan(plan, context));
    return executions;
  }

  private async runPlan(plan: ProviderPlan, context: ProviderContext): Promise<ProviderExecution> {
    const manifest = plan.manifest;
    const request = context.runtime;
    if (manifest === null || request === undefined || request === null || request.authorized !== true) return unavailable(plan, "Rendered checks need an authorized runtime request that names running targets");
    const axeVersion = (require("axe-core/package.json") as { version: string }).version;
    if (!semver.satisfies(axeVersion, manifest.engineRange)) return unavailable(plan, `axe-core ${axeVersion} is outside ${manifest.engineRange}`);
    const approved = await approvedRuleset(plan, context);
    if (typeof approved === "string") return unavailable(plan, approved);
    const { targets, problems } = validateRuntimeRequest(request, manifest);
    if (problems.length > 0) return unavailable(plan, `The runtime request cannot run: ${problems.join("; ")}`);
    for (const target of targets) {
      if (target.storageState === null) continue;
      try {
        if (!(await fs.lstat(target.storageState)).isFile()) throw new Error("not a file");
      } catch {
        return unavailable(plan, `The storage state for ${target.state} is not a readable file`);
      }
    }

    const known = new Set((require("axe-core") as { getRules(): { ruleId: string }[] }).getRules().map((rule) => rule.ruleId));
    const ruleStatus: Record<string, ProviderCompleteness> = {};
    const problemsByRule: string[] = [];
    const rules = plan.rules.filter((rule) => {
      if (!manifest.rules.some((declared) => declared.id === rule) || !approved.includes(rule)) problemsByRule.push(`${rule}: not in the approved axe ruleset`);
      else if (!known.has(rule)) problemsByRule.push(`${rule}: axe-core ${axeVersion} has no such rule`);
      else return true;
      ruleStatus[rule] = "unavailable";
      return false;
    });
    if (rules.length === 0) return { ...unavailable(plan, problemsByRule.join("; ") || "No approved axe rule was requested"), engineVersion: axeVersion };

    const browsersPath = this.options.browsersPath ?? defaultBrowsersPath();
    const outcome = await runWorker(
      { module: compiledModule("diagnostics/axe-task.js"), export: "scan", input: { targets, rules, axeSourcePath: require.resolve("axe-core/axe.min.js"), timeoutMs: request.timeoutMs ?? 30_000 } satisfies AxeTaskInput },
      { read: [browsersPath, ...targets.flatMap((target) => (target.storageState === null ? [] : [target.storageState]))], network: true, processSpawn: true, scratch: true, env: { PLAYWRIGHT_BROWSERS_PATH: browsersPath } },
      this.options.limits ?? DEFAULT_WORKER_LIMITS,
    );
    const capabilities: ProviderCapability[] = ["browser", "network-target"];
    if (outcome.status !== "ok") return { ...unavailable(plan, `axe worker ${outcome.status.replace("_", " ")}: ${outcome.detail}`), engineVersion: axeVersion, capabilities, denied: outcome.denied };
    const output = outcome.output as AxeTaskOutput;
    if (output.launchError !== null) return { ...unavailable(plan, `The browser could not start: ${output.launchError}`), engineVersion: output.engineVersion, capabilities, denied: outcome.denied };

    const tested = output.targets.filter((result) => result.status === "tested");
    const failed = output.targets.filter((result) => result.status === "failed");
    const review = new Map<string, number>();
    for (const result of tested) for (const item of result.needsReview) review.set(item.id, (review.get(item.id) ?? 0) + item.nodes);
    for (const rule of rules) ruleStatus[rule] = tested.length === 0 ? "unavailable" : failed.length > 0 || review.has(rule) ? "partial" : "complete";
    const drafts: FindingDraft[] = [];
    for (const result of tested) {
      for (const violation of result.violations) {
        for (const node of violation.nodes) {
          drafts.push({
            provider: { id: plan.provider, version: manifest.version, engine: AXE_ENGINE, engineVersion: output.engineVersion, contribution: plan.contribution },
            rule: violation.id,
            evidenceKind: "rendered",
            locations: [{ kind: "rendered", url: result.target.url, route: result.target.route, state: result.target.state, viewport: result.target.viewport, target: node.target.length > 0 ? node.target : ["document"] }],
            severity: violation.impact === "critical" || violation.impact === "serious" ? "error" : "warning",
            certainty: "observed",
            classification: "defect",
            message: violation.help,
            completeness: ruleStatus[violation.id] === "complete" ? "complete" : "partial",
            original: { engine: AXE_ENGINE, impact: violation.impact, tags: violation.tags, helpUrl: violation.helpUrl, failureSummary: node.failureSummary },
            anchor: node.target.join(" "),
          });
        }
      }
    }
    const reasons = [
      ...failed.map((result) => `${describeTarget(result.target)}: ${result.reason ?? "failed"}`),
      ...[...review.entries()].sort().map(([rule, nodes]) => `${rule}: ${nodes} elements need manual review`),
      ...problemsByRule,
    ];
    const statuses = Object.values(ruleStatus);
    const completeness: ProviderCompleteness = tested.length === 0 ? "unavailable" : statuses.every((status) => status === "complete") ? "complete" : "partial";
    return {
      provider: plan.provider,
      engineVersion: output.engineVersion,
      completeness,
      reason: reasons.length === 0 ? null : reasons.join("; "),
      ruleStatus,
      capabilities,
      denied: outcome.denied,
      files: 0,
      drafts,
      testedScope: tested.map((result) => describeTarget(result.target)),
    };
  }
}

/** The approved ruleset artifact, verified against its digest; or why it cannot be used. */
async function approvedRuleset(plan: ProviderPlan, context: ProviderContext): Promise<string[] | string> {
  const contribution = context.providerContributions[plan.provider];
  const artifact = plan.manifest?.artifacts.find((candidate) => candidate.path.endsWith(".json"));
  if (contribution === undefined || artifact === undefined) return `${plan.provider} has no embedded ruleset`;
  const registryRoot = await fs.realpath(context.registryRoot);
  const expected = path.join(registryRoot, "contributions", ...contribution.split("/"), ...artifact.path.split("/"));
  let bytes: Buffer;
  try {
    if ((await fs.realpath(expected)) !== expected) return `The ${plan.provider} ruleset resolves outside the embedded registry`;
    bytes = await fs.readFile(expected);
  } catch {
    return `The ${plan.provider} ruleset ${artifact.path} is missing`;
  }
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== artifact.digest) return `The ${plan.provider} ruleset ${artifact.path} does not match its approved digest`;
  const ruleset = JSON.parse(bytes.toString("utf8")) as { rules?: unknown };
  return Array.isArray(ruleset.rules) ? ruleset.rules.filter((rule): rule is string => typeof rule === "string") : `The ${plan.provider} ruleset lists no rules`;
}

export function defaultBrowsersPath(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined && process.env.PLAYWRIGHT_BROWSERS_PATH !== "") return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ms-playwright");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "ms-playwright");
}
