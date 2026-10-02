import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ESLint } from "eslint";
import semver from "semver";
import type { ProviderCapability, ProviderCompleteness } from "../contracts/index.js";
import { isSourcePath } from "../facts/project-index.js";
import type { FindingDraft } from "./finding.js";
import { BUILTIN_ESLINT, unavailable, type ProviderAdapter, type ProviderContext, type ProviderExecution, type ProviderPlan } from "./providers.js";
import type { EslintConfigMode, EslintTaskInput, EslintTaskOutput } from "./eslint-task.js";
import { DEFAULT_WORKER_LIMITS, compiledModule, runWorker, type WorkerLimits } from "./worker.js";

/**
 * The ESLint 9 provider. All ESLint-engine plans run in one bounded worker:
 * catalog-approved plugins embedded in the package, verified before they are
 * loaded, plus core ESLint rules, under the application's own configuration
 * when it has one. Rules that Controls require, and only those, run with
 * severities from policy. Fixes are described and never applied.
 */

export const FLAT_CONFIG_FILES = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"];
export const LEGACY_CONFIG_FILES = [".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yaml", ".eslintrc.yml", ".eslintrc.json", ".eslintrc"];

export interface EslintAdapterOptions {
  limits?: WorkerLimits;
}

export class EslintAdapter implements ProviderAdapter {
  readonly engine = BUILTIN_ESLINT;

  constructor(private readonly options: EslintAdapterOptions = {}) {}

  async run(plans: readonly ProviderPlan[], context: ProviderContext): Promise<ProviderExecution[]> {
    const executions = new Map<string, ProviderExecution>();
    const ruleOwners = new Map<string, ProviderPlan>();
    const ruleProblems = new Map<string, Map<string, string>>();
    const rules: Record<string, 1 | 2> = {};
    const plugins: EslintTaskInput["plugins"] = [];
    const reads = new Set<string>([context.root]);
    if (context.repositoryRoot !== null) reads.add(context.repositoryRoot);
    const problem = (plan: ProviderPlan, rule: string, reason: string) => {
      const problems = ruleProblems.get(plan.provider) ?? new Map<string, string>();
      problems.set(rule, reason);
      ruleProblems.set(plan.provider, problems);
    };

    for (const plan of plans) {
      const severity = (rule: string) => (plan.requirements.some((requirement) => requirement.rule === rule && requirement.control.control.strength === "required") ? 2 : 1);
      if (plan.manifest === null) {
        for (const rule of plan.rules) {
          if (rule.includes("/")) problem(plan, rule, `Plugin ${rule.slice(0, rule.indexOf("/"))} is not catalog-approved`);
          else {
            rules[rule] = severity(rule);
            ruleOwners.set(rule, plan);
          }
        }
        continue;
      }
      if (!semver.satisfies(ESLint.version, plan.manifest.engineRange)) {
        executions.set(plan.provider, unavailable(plan, `ESLint ${ESLint.version} is outside ${plan.manifest.engineRange}`));
        continue;
      }
      const artifact = await approvedPlugin(plan, context);
      if (typeof artifact === "string") {
        executions.set(plan.provider, unavailable(plan, artifact));
        continue;
      }
      plugins.push(artifact);
      reads.add(path.dirname(artifact.path));
      for (const rule of plan.rules) {
        if (!plan.manifest.rules.some((declared) => declared.id === rule)) problem(plan, rule, `${plan.provider} does not declare rule ${rule}`);
        else {
          rules[`${plan.provider}/${rule}`] = severity(rule);
          ruleOwners.set(`${plan.provider}/${rule}`, plan);
        }
      }
    }

    const runnable = plans.filter((plan) => !executions.has(plan.provider));
    if (runnable.length === 0) return plans.map((plan) => executions.get(plan.provider)!);
    const files = context.snapshot.files.filter((file) => isSourcePath(file) && !file.endsWith(".d.ts") && (context.scope.mode === "full" || context.scope.files.includes(file)));
    const config = await discoverConfig(context.root, context.repositoryRoot);
    const outcome = await runWorker(
      { module: compiledModule("diagnostics/eslint-task.js"), export: "lint", input: { root: context.root, config, files, plugins, rules } satisfies EslintTaskInput },
      { read: [...reads], network: false, scratch: true },
      this.options.limits ?? DEFAULT_WORKER_LIMITS,
    );
    const capabilities: ProviderCapability[] = ["filesystem-read"];
    if (outcome.status !== "ok") {
      for (const plan of runnable) executions.set(plan.provider, { ...unavailable(plan, `ESLint worker ${outcome.status.replace("_", " ")}: ${outcome.detail}`), denied: outcome.denied, capabilities });
      return plans.map((plan) => executions.get(plan.provider)!);
    }
    const output = outcome.output as EslintTaskOutput;
    if (output.configError !== null) {
      for (const plan of runnable) executions.set(plan.provider, { ...unavailable(plan, `The application ESLint configuration cannot be composed with enterprise rules: ${output.configError}`), engineVersion: output.engineVersion, denied: outcome.denied, capabilities });
      return plans.map((plan) => executions.get(plan.provider)!);
    }

    const partial = output.unanalyzed.length > 0;
    const reason = partial ? `${output.unanalyzed.length} of ${output.files} files could not be parsed or are not matched by the ${output.config === "none" ? "base" : "application"} configuration: ${output.unanalyzed.slice(0, 3).map((entry) => entry.path).join(", ")}` : null;
    for (const plan of runnable) {
      const drafts: FindingDraft[] = [];
      for (const result of output.results) {
        for (const message of result.messages) {
          if (ruleOwners.get(message.ruleId) !== plan) continue;
          const rule = plan.manifest === null ? message.ruleId : message.ruleId.slice(plan.provider.length + 1);
          drafts.push({
            provider: { id: plan.provider, version: plan.manifest?.version ?? output.engineVersion, engine: BUILTIN_ESLINT, engineVersion: output.engineVersion, contribution: plan.contribution },
            rule,
            evidenceKind: "static",
            locations: [{ kind: "source", path: result.path, line: message.line, column: message.column, endLine: message.endLine, endColumn: message.endColumn }],
            severity: message.severity === 2 ? "error" : "warning",
            certainty: "observed",
            classification: output.ruleTypes[message.ruleId] === "problem" ? "defect" : "risk",
            message: message.message,
            completeness: partial ? "partial" : "complete",
            original: { engine: "eslint", ruleId: message.ruleId, messageId: message.messageId, severity: message.severity, suggestions: message.suggestions },
            fix: { available: message.fix || message.suggestions.length > 0, description: message.fix ? "ESLint can rewrite this code; Web Doctor does not apply it" : message.suggestions[0] ?? null },
            suppression: message.suppression === null ? null : { kind: "inline", justification: message.suppression.justification },
            ...(message.anchor === null ? {} : { anchor: message.anchor }),
          });
        }
      }
      const planned = plan.manifest === null ? plan.rules : plan.rules.map((rule) => `${plan.provider}/${rule}`);
      const ruleStatus: Record<string, ProviderCompleteness> = {};
      const problems = ruleProblems.get(plan.provider) ?? new Map<string, string>();
      for (const [index, rule] of plan.rules.entries()) {
        const id = planned[index]!;
        ruleStatus[rule] = problems.has(rule) || Object.hasOwn(output.unavailableRules, id) ? "unavailable" : partial ? "partial" : "complete";
        if (Object.hasOwn(output.unavailableRules, id)) problems.set(rule, output.unavailableRules[id]!);
      }
      const statuses = Object.values(ruleStatus);
      const completeness: ProviderCompleteness = statuses.length > 0 && statuses.every((status) => status === "unavailable") ? "unavailable" : partial || statuses.includes("unavailable") ? "partial" : "complete";
      const reasons = [reason, ...[...problems.entries()].map(([rule, detail]) => `${rule}: ${detail}`)].filter((entry): entry is string => entry !== null);
      executions.set(plan.provider, {
        provider: plan.provider,
        engineVersion: output.engineVersion,
        completeness,
        reason: reasons.length === 0 ? null : reasons.join("; "),
        ruleStatus,
        capabilities,
        denied: outcome.denied,
        files: output.files,
        drafts,
      });
    }
    return plans.map((plan) => executions.get(plan.provider)!);
  }
}

/**
 * The embedded plugin artifact for an approved ESLint provider, verified
 * against its approved digest; or why it cannot be used.
 */
async function approvedPlugin(plan: ProviderPlan, context: ProviderContext): Promise<EslintTaskInput["plugins"][number] | string> {
  const contribution = context.providerContributions[plan.provider];
  if (contribution === undefined) return `${plan.provider} is not embedded in this Web Doctor package`;
  const artifact = plan.manifest?.artifacts.find((candidate) => /\.(?:mjs|cjs|js)$/.test(candidate.path));
  if (artifact === undefined) return `${plan.provider} declares no ESLint plugin artifact`;
  const registryRoot = await fs.realpath(context.registryRoot);
  const expected = path.join(registryRoot, "contributions", ...contribution.split("/"), ...artifact.path.split("/"));
  let actual: string;
  try {
    actual = await fs.realpath(expected);
  } catch {
    return `The ${plan.provider} plugin artifact ${artifact.path} is missing`;
  }
  if (actual !== expected) return `The ${plan.provider} plugin artifact ${artifact.path} resolves outside the embedded registry`;
  const digest = crypto.createHash("sha256").update(await fs.readFile(actual)).digest("hex");
  if (digest !== artifact.digest) return `The ${plan.provider} plugin artifact ${artifact.path} does not match its approved digest`;
  return { namespace: plan.provider, path: actual, digest };
}

/** The application's ESLint configuration: flat first, then legacy, from the root up to the repository root. */
export async function discoverConfig(root: string, repositoryRoot: string | null): Promise<EslintConfigMode> {
  const directories: string[] = [];
  for (let directory = root; ; directory = path.dirname(directory)) {
    directories.push(directory);
    if (repositoryRoot === null || directory === repositoryRoot || path.dirname(directory) === directory || !directory.startsWith(repositoryRoot)) break;
  }
  for (const directory of directories) {
    for (const name of FLAT_CONFIG_FILES) if (await isFile(path.join(directory, name))) return { mode: "flat", file: path.join(directory, name) };
  }
  for (const directory of directories) {
    for (const name of LEGACY_CONFIG_FILES) if (await isFile(path.join(directory, name))) return { mode: "legacy", file: path.join(directory, name) };
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")) as { eslintConfig?: unknown };
      if (manifest.eslintConfig !== undefined) return { mode: "legacy", file: path.join(directory, "package.json") };
    } catch {
      // No package.json configuration here.
    }
  }
  return { mode: "none" };
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}
