import fs from "node:fs/promises";
import path from "node:path";
import { diagnosticsReportSchema, parseContract, type DiagnosticsReport, type McpResponse, type ProfileEvidence, type RequirementStrength } from "../contracts/index.js";
import { redactValue } from "../core/redaction.js";
import type { ScopeRequest, UpdateOutcome } from "../core/web-doctor.js";
import { parseRuntimeRequest } from "../diagnostics/runtime-request.js";
import type { UpgradePlan } from "../guidance/upgrade.js";
import type { VerificationPlan } from "../guidance/verification.js";
import { CliUsageError, parseOptions, single, type ParsedOptions } from "./options.js";
import { print, withCore, type CliContext, type CliIo } from "./product.js";

/**
 * Diagnostics, explanation, planning, and update commands over the shared
 * core. `--json` prints the MCP response envelope; `check` exits with its
 * gate's code, so the same command serves local use and CI.
 */

const COMMON = ["--root", "--registry"] as const;
const GATES = ["required", "recommended", "informational"] as const;

export async function runCheck(args: readonly string[], io: CliIo, context: CliContext): Promise<number> {
  const parsed = parseOptions(args, { values: [...COMMON, "--changed", "--changed-lines", "--runtime", "--baseline", "--gate", "--report", "--continuation"], repeatable: ["--portal", "--file"], flags: ["--json", "--ci"] });
  noPositionals(parsed);
  const scope = scopeOf(parsed);
  const gate = single(parsed, "gate");
  if (gate !== undefined && !(GATES as readonly string[]).includes(gate)) throw new CliUsageError(`--gate must be one of ${GATES.join(", ")}`);
  const runtimePath = single(parsed, "runtime");
  const runtime = runtimePath === undefined ? null : parseRuntimeRequest(await readJson(runtimePath, context, "runtime request"));
  const baseline = await reportOption(parsed, "baseline", context);
  const archive = single(parsed, "report");
  return withCore(parsed, context, { mode: parsed.flags.has("ci") ? "ci" : "local", allowRuntime: runtime !== null }, async (core) => {
    const request = { scope, runtime, baseline, ...(gate === undefined ? {} : { gate: gate as RequirementStrength }) };
    if (archive !== undefined) {
      // The complete report for archival and gates, written only where the caller asked.
      const { report } = await core.diagnose(request);
      await fs.writeFile(path.resolve(context.cwd, archive), `${JSON.stringify(redactValue(report).value, null, 2)}\n`);
    }
    const response = await core.runDiagnostics({ ...request, ...continued(parsed) });
    print(io, parsed, response, renderReport);
    return (response.data as DiagnosticsReport).gate.exitCode;
  });
}

export async function runExplain(args: readonly string[], io: CliIo, context: CliContext): Promise<number> {
  const parsed = parseOptions(args, { values: [...COMMON, "--report", "--continuation"], repeatable: ["--portal"], flags: ["--json"] });
  const [subject, id, ...extra] = parsed.positionals;
  if ((subject !== "finding" && subject !== "control") || id === undefined || extra.length > 0) throw new CliUsageError("Use explain finding <id> or explain control <id>");
  const report = await reportOption(parsed, "report", context);
  return withCore(parsed, context, {}, async (core) => {
    const response = subject === "finding" ? await core.explainFinding({ finding: id, report, ...continued(parsed) }) : await core.explainControl({ control: id, report, ...continued(parsed) });
    print(io, parsed, response, subject === "finding" ? renderFinding : renderControl);
    return 0;
  });
}

export async function runPlan(args: readonly string[], io: CliIo, context: CliContext): Promise<number> {
  const [kind, ...rest] = args;
  if (kind === "upgrade") {
    const parsed = parseOptions(rest, { values: [...COMMON, "--continuation"], flags: ["--json"] });
    const [first, second, ...extra] = parsed.positionals;
    if (first === undefined || extra.length > 0) throw new CliUsageError("Use plan upgrade [package] <target>");
    const [name, target] = second === undefined ? ["react", first] : [first, second];
    return withCore(parsed, context, {}, async (core) => {
      const response = await core.planUpgrade({ package: name, target, ...continued(parsed) });
      print(io, parsed, response, renderUpgrade);
      return (response.data as UpgradePlan).status === "unresolved" ? 4 : 0;
    });
  }
  if (kind === "verification") {
    const parsed = parseOptions(rest, { values: [...COMMON, "--report", "--profile", "--measured-by", "--continuation"], repeatable: ["--portal", "--file", "--control"], flags: ["--json"] });
    noPositionals(parsed);
    const profilePath = single(parsed, "profile");
    const provider = single(parsed, "measured-by");
    if ((profilePath === undefined) !== (provider === undefined)) throw new CliUsageError("--profile and --measured-by go together");
    const measurements = profilePath === undefined ? [] : [{ provider: provider!, profile: parseContract("profileEvidence", await readJson(profilePath, context, "profile evidence")) as ProfileEvidence }];
    const report = await reportOption(parsed, "report", context);
    return withCore(parsed, context, {}, async (core) => {
      const response = await core.planVerification({
        report,
        measurements,
        ...continued(parsed),
        ...(parsed.values.has("file") ? { files: parsed.values.get("file")! } : {}),
        ...(parsed.values.has("control") ? { controls: parsed.values.get("control")! } : {}),
      });
      print(io, parsed, response, renderVerification);
      return 0;
    });
  }
  throw new CliUsageError("Use plan upgrade or plan verification");
}

export async function runUpdate(args: readonly string[], io: CliIo, context: CliContext): Promise<number> {
  const subcommand = args[0] === "status" || args[0] === "rollback" ? args[0] : null;
  const parsed = parseOptions(subcommand === null ? args : args.slice(1), { values: [...COMMON], flags: ["--json"] });
  noPositionals(parsed);
  return withCore(parsed, context, {}, async (core) => {
    if (subcommand === "status") {
      const response = await core.updateStatus();
      print(io, parsed, response, renderNotice);
      return 0;
    }
    const response = subcommand === "rollback" ? await core.applyRollback() : await core.applyUpdate();
    print(io, parsed, response, renderUpdate);
    const outcome = (response.data as { outcome: UpdateOutcome }).outcome;
    return outcome.status === "failed" || outcome.status === "unknown" ? 1 : outcome.status === "action_required" ? 2 : 0;
  });
}

function continued(parsed: ParsedOptions): { continuation?: string } {
  const continuation = single(parsed, "continuation");
  return continuation === undefined ? {} : { continuation };
}

function scopeOf(parsed: ParsedOptions): ScopeRequest {
  const changed = single(parsed, "changed");
  const lines = single(parsed, "changed-lines");
  const files = parsed.values.get("file");
  if ([changed, lines, files].filter((value) => value !== undefined).length > 1) throw new CliUsageError("Use only one of --changed, --changed-lines, or --file");
  if (changed !== undefined) return { mode: "changed-files", base: changed };
  if (lines !== undefined) return { mode: "changed-lines", base: lines };
  if (files !== undefined) return { mode: "files", files };
  return { mode: "full" };
}

function noPositionals(parsed: ParsedOptions): void {
  if (parsed.positionals.length > 0) throw new CliUsageError(`Unexpected argument ${parsed.positionals[0]}`);
}

async function readJson(file: string, context: CliContext, label: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path.resolve(context.cwd, file), "utf8")) as unknown;
  } catch (error) {
    throw new CliUsageError(`Cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A diagnostics report file: the `check --json` envelope or a bare report. */
async function reportOption(parsed: ParsedOptions, name: string, context: CliContext): Promise<DiagnosticsReport | null> {
  const file = single(parsed, name);
  if (file === undefined) return null;
  const input = await readJson(file, context, "diagnostics report");
  const candidate = typeof input === "object" && input !== null && (input as { schema?: unknown }).schema === "web-doctor.mcp-response" ? (input as { data?: unknown }).data : input;
  const report = diagnosticsReportSchema.safeParse(candidate);
  if (!report.success) throw new CliUsageError(`${file} is not a Web Doctor diagnostics report`);
  return report.data;
}

function renderReport(response: McpResponse): string[] {
  const report = response.data as DiagnosticsReport;
  const lines = [`Diagnostics ${report.gate.status} (gate ${report.gate.level}, exit ${report.gate.exitCode}); scope ${report.scope.mode}${report.scope.files.length > 0 ? ` over ${report.scope.files.length} files` : ""}`];
  for (const run of report.runs) lines.push(`  ${run.provider} ${run.engineVersion ?? ""} ${run.completeness}${run.reason === null ? "" : `: ${run.reason}`}`.replace(/ {2,}/g, " ").replace(/^ /, "  "));
  for (const finding of report.findings) {
    const location = finding.locations[0]!;
    const place = location.kind === "source" ? `${location.path}:${location.line}:${location.column}` : `${location.url} [${location.state}]`;
    lines.push(`${finding.severity} ${place} ${finding.provider.id}/${finding.rule}: ${finding.message}${finding.baseline === "existing" ? " (existing)" : ""}`);
    lines.push(`  ${finding.id} Controls: ${finding.controls.join(", ") || "none"}`);
  }
  for (const outcome of report.controls.filter((entry) => entry.status !== "met")) lines.push(`control ${outcome.control} ${outcome.status.replace("_", " ")}${outcome.reasons.length === 0 ? "" : `: ${outcome.reasons.join("; ")}`}`);
  for (const entry of report.fullProjectOnly) lines.push(`needs a full-project run: ${entry.reason}`);
  for (const reason of report.gate.reasons) lines.push(`gate: ${reason}`);
  return lines;
}

function renderFinding(response: McpResponse): string[] {
  const data = response.data as { finding: DiagnosticsReport["findings"][number]; recommendation: { status: string; reason: string; approved: { name: string; module: string | null; usage: string }[]; generic: { remediation: string[]; replaced: boolean } }; impact: { owner: { name: string; path: string } | null; consumers: unknown[] } | null; verification: VerificationPlan };
  const lines = [`${data.finding.provider.id}/${data.finding.rule}: ${data.finding.message}`, `Obligations:`];
  for (const obligation of data.finding.obligations) lines.push(`  ${obligation.strength} ${obligation.layer} ${obligation.control}${obligation.remediation === null ? "" : `: ${obligation.remediation}`}`);
  lines.push(`Recommendation (${data.recommendation.status}): ${data.recommendation.reason}`);
  for (const pattern of data.recommendation.approved) lines.push(`  use ${pattern.name}${pattern.module === null ? "" : ` from ${pattern.module}`}: ${pattern.usage}`);
  if (!data.recommendation.generic.replaced) for (const text of data.recommendation.generic.remediation) lines.push(`  ${text}`);
  if (data.impact?.owner !== null && data.impact !== null) lines.push(`Likely shared owner: ${data.impact.owner!.name} in ${data.impact.owner!.path} (${data.impact.consumers.length} consumers)`);
  lines.push(data.verification.statement);
  return lines;
}

function renderControl(response: McpResponse): string[] {
  const data = response.data as { control: { id: string; title: string; strength: string }; effective: boolean; reason: string | null; layer: string | null; outcome: { status: string } | null; verification: VerificationPlan | null };
  return [
    `${data.control.strength} ${data.layer ?? "unknown"} ${data.control.id}: ${data.control.title}`,
    data.effective ? `Effective for this application${data.outcome === null ? "" : `; last outcome ${data.outcome.status.replace("_", " ")}`}` : `Not effective: ${data.reason}`,
    ...(data.verification === null ? [] : [data.verification.statement]),
  ];
}

function renderUpgrade(response: McpResponse): string[] {
  const plan = response.data as UpgradePlan;
  const lines = [`Upgrade ${plan.package} ${plan.current.version ?? "unknown"} to ${plan.target}: ${plan.status}`];
  for (const reason of plan.unresolved) lines.push(`  unresolved: ${reason}`);
  for (const blocker of plan.blockers) lines.push(`blocker before ${blocker.stage}: ${blocker.package} ${blocker.installed ?? ""} - ${blocker.reason}`.replace("  -", " -"));
  for (const stage of plan.stages) {
    lines.push(`${stage.order}. ${stage.id}: ${stage.purpose}`);
    for (const change of stage.changes) lines.push(`   ${change.title} -> ${change.replacement} (${change.occurrences.length} places)`);
    for (const step of stage.verification) lines.push(`   verify: ${step.command ?? step.description}`);
    lines.push(`   rollback: ${stage.rollback}`);
  }
  for (const item of plan.manual) lines.push(`manual: ${item}`);
  return lines;
}

function renderVerification(response: McpResponse): string[] {
  const plan = response.data as VerificationPlan;
  const lines = [plan.statement];
  for (const item of plan.items) lines.push(`${item.status === "satisfied" ? "done" : item.status === "failed" ? "FAIL" : "todo"} ${item.type}${item.required ? " (required)" : ""}: ${item.description}${item.command === null ? "" : ` [${item.command}]`}`);
  return lines;
}

function renderNotice(response: McpResponse): string[] {
  const notice = response.data as { status: string; installedVersion: string; availableVersion: string | null; command: string | null; reason: string };
  return [`Web Doctor ${notice.installedVersion}: ${notice.status}${notice.availableVersion === null ? "" : ` (available ${notice.availableVersion})`}`, `  ${notice.reason}`, ...(notice.command === null ? [] : [`  upgrade with: ${notice.command}`])];
}

function renderUpdate(response: McpResponse): string[] {
  const { outcome } = response.data as { outcome: UpdateOutcome };
  return [`Update ${outcome.status.replace("_", " ")}: ${outcome.reason}`, ...(outcome.status === "action_required" && outcome.command !== null ? [`  run: ${outcome.command}`] : [])];
}
