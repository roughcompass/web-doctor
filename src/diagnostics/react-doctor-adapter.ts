import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import type { ProviderApproval, ProviderCapability, ProviderCompleteness } from "../contracts/index.js";
import { contentDigest } from "../facts/repo-facts-release.js";
import type { FindingDraft } from "./finding.js";
import { unavailable, type ProviderAdapter, type ProviderContext, type ProviderExecution, type ProviderPlan } from "./providers.js";
import { approvedReleaseFor, loadProviderApproval, rulesetProblems, type ApprovedRelease } from "./provider-approval.js";
import { DEFAULT_WORKER_LIMITS, SCRATCH_PLACEHOLDER, runBoundedScript, type WorkerLimits } from "./worker.js";

/**
 * React Doctor, an optional static provider that runs only under its
 * recorded approval. Web Doctor runs React Doctor's scan command in a bounded
 * Node process with no network, no PATH, reads limited to the application and
 * React Doctor itself, and writes limited to a private scratch directory.
 * Reads outside those roots look like missing paths, so no parent-directory
 * configuration is ever loaded. It
 * validates the JSON report against the approved output schema and maps each
 * diagnostic into the normalized finding contract with React Doctor
 * provenance. Absence, rejection, or incompatibility makes only this
 * provider unavailable.
 */

export const REACT_DOCTOR_ENGINE = "react-doctor";

const EXECUTABLE_CONFIGS = ["doctor.config.ts", "doctor.config.mts", "doctor.config.cts", "doctor.config.js", "doctor.config.mjs", "doctor.config.cjs"];
const BACKUPS = [".react-doctor", "audit-backups"];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
/**
 * Workspace markers React Doctor's lint plugin probes in each parent
 * directory, from threads that no preload reaches. Each exact file is
 * readable; parent directories, their other files, and .git are not.
 */
const WORKSPACE_MARKERS = ["package.json", "pnpm-workspace.yaml", "pnpm-workspace.yml", "nx.json", "lerna.json", "turbo.json", "rush.json"];

const diagnosticSchema = z.object({
  filePath: z.string().min(1),
  plugin: z.string().min(1),
  rule: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1),
  help: z.string().optional(),
  title: z.string().optional(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  category: z.string(),
  tags: z.array(z.string()).optional(),
});

const reportSchema = z.object({
  schemaVersion: z.number().int(),
  version: z.string(),
  ok: z.boolean(),
  diagnostics: z.array(diagnosticSchema),
  projects: z.array(z.object({
    directory: z.string(),
    complete: z.boolean(),
    skippedChecks: z.array(z.string()),
    skippedCheckReasons: z.record(z.string(), z.string()).optional(),
    analyzedFileCount: z.number().int().nonnegative().optional(),
  })),
  error: z.object({ message: z.string() }).passthrough().nullable(),
});

export type ReactDoctorReport = z.infer<typeof reportSchema>;

export interface ReactDoctorAdapterOptions {
  limits?: WorkerLimits;
  /** Where React Doctor is installed; defaults to resolving it from Web Doctor. Null means absent. */
  packageRoot?: string | null;
  /** The approval to enforce; defaults to the one Web Doctor ships. */
  approval?: ProviderApproval | null;
}

export class ReactDoctorAdapter implements ProviderAdapter {
  readonly engine = REACT_DOCTOR_ENGINE;

  constructor(private readonly options: ReactDoctorAdapterOptions = {}) {}

  async run(plans: readonly ProviderPlan[], context: ProviderContext): Promise<ProviderExecution[]> {
    const executions: ProviderExecution[] = [];
    for (const plan of plans) executions.push(await this.runPlan(plan, context));
    return executions;
  }

  private async runPlan(plan: ProviderPlan, context: ProviderContext): Promise<ProviderExecution> {
    const manifest = plan.manifest;
    if (manifest === null) return unavailable(plan, "React Doctor is not in the approved catalog");
    const approval = this.options.approval === undefined ? await loadProviderApproval(REACT_DOCTOR_ENGINE) : this.options.approval;
    const approved = approvedReleaseFor(manifest, approval);
    if ("problem" in approved) return unavailable(plan, approved.problem);
    const { release } = approved;
    // The security review approved one exact invocation; it is read from the record, never restated here.
    const { configuration } = approval!.security;
    const catalog = await embeddedCatalog(plan, context);
    const catalogProblems = rulesetProblems(manifest, release, catalog.bytes);
    if (catalogProblems.length > 0) return unavailable(plan, catalogProblems.join("; "));

    const packageRoot = this.options.packageRoot === undefined ? await installedPackageRoot() : this.options.packageRoot;
    if (packageRoot === null) return unavailable(plan, "React Doctor is not installed; it is an optional dependency of Web Doctor");
    const installed = await installedRelease(packageRoot, release);
    if (installed !== null) return unavailable(plan, installed);
    const refusal = await applicationRefusal(context);
    if (refusal !== null) return unavailable(plan, refusal);

    const known = new Map(catalog.rules.map((rule) => [rule.toLowerCase(), rule]));
    const ruleStatus: Record<string, ProviderCompleteness> = {};
    const unknown = plan.rules.filter((rule) => !known.has(rule));
    for (const rule of unknown) ruleStatus[rule] = "unavailable";
    const rules = plan.rules.filter((rule) => known.has(rule));
    if (rules.length === 0) return { ...unavailable(plan, unknown.length > 0 ? `React Doctor ${release.version} has no rules ${unknown.join(", ")}` : "No React Doctor rule was requested"), engineVersion: release.version };

    const root = await fs.realpath(context.root);
    const targets = context.scope.mode === "full" ? [root] : context.scope.files.filter((file) => SOURCE.test(file));
    if (targets.length === 0) return { provider: plan.provider, engineVersion: release.version, completeness: "complete", reason: null, ruleStatus: Object.fromEntries([...Object.entries(ruleStatus), ...rules.map((rule) => [rule, "complete" as const])]), capabilities: CAPABILITIES, denied: [], files: 0, drafts: [] };

    const outcome = await runBoundedScript(
      {
        script: path.join(packageRoot, "bin", "react-doctor.js"),
        args: [...targets, ...configuration.arguments],
        cwd: root,
      },
      {
        read: [root, ...await dependencyRoots(packageRoot), ...ancestorMarkers(root)],
        write: [path.join(root, ...BACKUPS)],
        network: false,
        scratch: true,
        processSpawn: true,
        workerThreads: true,
        addons: true,
        // React Doctor walks parent directories for configuration; it sees none, so the application is scanned alone.
        confineReads: true,
        env: configuration.environment,
      },
      this.options.limits ?? DEFAULT_WORKER_LIMITS,
      async (run) => {
        const reportPath = configuration.arguments[configuration.arguments.indexOf("--json-out") + 1]?.replaceAll(SCRATCH_PLACEHOLDER, run.scratch!);
        const text = reportPath === undefined ? null : await fs.readFile(reportPath, "utf8").catch(() => null);
        if (text === null) throw new Error(`React Doctor wrote no report (exit code ${run.exitCode})${run.stderr.trim() === "" ? "" : `: ${run.stderr.trim().split("\n").at(-1)}`}`);
        return JSON.parse(text) as unknown;
      },
    );
    if (outcome.status !== "ok") return { ...unavailable(plan, `React Doctor ${outcome.status.replace("_", " ")}: ${outcome.detail}`), engineVersion: release.version, capabilities: CAPABILITIES, denied: outcome.denied };
    const parsed = parseReport(outcome.result, release);
    if (typeof parsed === "string") return { ...unavailable(plan, parsed), engineVersion: release.version, capabilities: CAPABILITIES, denied: outcome.denied };

    const incomplete = parsed.projects.filter((project) => !project.complete || project.skippedChecks.length > 0);
    const status: ProviderCompleteness = incomplete.length > 0 ? "partial" : "complete";
    for (const rule of rules) ruleStatus[rule] = status;
    const selected = new Set(rules);
    const drafts: FindingDraft[] = [];
    for (const diagnostic of parsed.diagnostics) {
      const rule = (diagnostic.plugin === REACT_DOCTOR_ENGINE ? diagnostic.rule : `${diagnostic.plugin}/${diagnostic.rule}`).toLowerCase();
      if (!selected.has(rule)) continue;
      const file = await locate(root, diagnostic.filePath, parsed.projects.map((project) => project.directory));
      if (file === null) continue;
      drafts.push({
        provider: { id: plan.provider, version: manifest.version, engine: REACT_DOCTOR_ENGINE, engineVersion: parsed.version, contribution: plan.contribution },
        rule,
        evidenceKind: "static",
        locations: [{ kind: "source", path: file, line: Math.max(1, diagnostic.line), column: Math.max(1, diagnostic.column), endLine: null, endColumn: null }],
        severity: diagnostic.severity,
        certainty: "observed",
        classification: diagnostic.severity === "error" ? "defect" : "risk",
        message: diagnostic.message,
        completeness: status,
        original: { engine: REACT_DOCTOR_ENGINE, plugin: diagnostic.plugin, rule: diagnostic.rule, category: diagnostic.category, tags: diagnostic.tags ?? [], ...(diagnostic.help === undefined ? {} : { help: diagnostic.help }), ...(diagnostic.line === 0 ? { fileLevel: true } : {}) },
      });
    }
    const reasons = [
      ...incomplete.flatMap((project) => project.skippedChecks.map((check) => `${check} was skipped${project.skippedCheckReasons?.[check] === undefined ? "" : `: ${project.skippedCheckReasons[check]!.split("\n")[0]}`}`)),
      ...unknown.map((rule) => `${rule}: React Doctor ${release.version} has no such rule`),
    ];
    return {
      provider: plan.provider,
      engineVersion: parsed.version,
      completeness: status,
      reason: reasons.length === 0 ? null : [...new Set(reasons)].join("; "),
      ruleStatus,
      capabilities: CAPABILITIES,
      denied: outcome.denied,
      files: parsed.projects.reduce((total, project) => total + (project.analyzedFileCount ?? 0), 0),
      drafts,
    };
  }
}

const CAPABILITIES: ProviderCapability[] = ["filesystem-read", "process-spawn"];

/** Validates a React Doctor report against the approved release and its supported output schemas. */
export function parseReport(input: unknown, release: ApprovedRelease): ReactDoctorReport | string {
  const version = typeof input === "object" && input !== null ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof version !== "number" || !release.outputSchemaVersions.includes(version)) {
    return `React Doctor report schema ${String(version)} is not supported; the approved release reports schema ${release.outputSchemaVersions.join(", ")}`;
  }
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return `React Doctor report does not match schema ${version}: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  if (parsed.data.version !== release.version) return `React Doctor reported version ${parsed.data.version}, not the approved ${release.version}`;
  if (!parsed.data.ok) return `React Doctor failed: ${parsed.data.error?.message ?? "no reason reported"}`;
  return parsed.data;
}

async function embeddedCatalog(plan: ProviderPlan, context: ProviderContext): Promise<{ bytes: Buffer | null; rules: string[] }> {
  const contribution = context.providerContributions[plan.provider];
  const artifact = plan.manifest?.artifacts.find((candidate) => candidate.path.endsWith("rules.json"));
  if (contribution === undefined || artifact === undefined) return { bytes: null, rules: [] };
  try {
    const registryRoot = await fs.realpath(context.registryRoot);
    const file = path.join(registryRoot, "contributions", ...contribution.split("/"), ...artifact.path.split("/"));
    if ((await fs.realpath(file)) !== file) return { bytes: null, rules: [] };
    const bytes = await fs.readFile(file);
    const rules = ((JSON.parse(bytes.toString("utf8")) as { rules?: { id?: unknown }[] }).rules ?? []).flatMap((rule) => (typeof rule.id === "string" ? [rule.id] : []));
    return { bytes, rules };
  } catch {
    return { bytes: null, rules: [] };
  }
}

/** React Doctor as Node would resolve it from Web Doctor: its own node_modules first, then each parent's. */
async function installedPackageRoot(): Promise<string | null> {
  for (let directory = path.dirname(fileURLToPath(import.meta.url)); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", "react-doctor");
    try {
      await fs.access(path.join(candidate, "package.json"));
      return await fs.realpath(candidate);
    } catch {
      if (path.dirname(directory) === directory) return null;
    }
  }
}

/** Why the installed package is not the approved release, or null when it is. */
async function installedRelease(packageRoot: string, release: ApprovedRelease): Promise<string | null> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (manifest.name !== "react-doctor") return `${packageRoot} does not hold React Doctor`;
    if (manifest.version !== release.version) return `Installed React Doctor is ${String(manifest.version)}, not the approved ${release.version}`;
    if ((await contentDigest(packageRoot)) !== release.contentDigest) return `Installed React Doctor ${release.version} files differ from the approved release`;
    return null;
  } catch (error) {
    return `React Doctor cannot be verified: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The node_modules directories that hold React Doctor and its dependencies, however npm laid them out. */
async function dependencyRoots(packageRoot: string): Promise<string[]> {
  const roots: string[] = [];
  for (let directory = packageRoot; path.dirname(directory) !== directory; directory = path.dirname(directory)) {
    if (path.basename(directory) === "node_modules") roots.push(directory);
  }
  return roots.length === 0 ? [packageRoot] : roots;
}

function ancestorMarkers(root: string): string[] {
  const markers: string[] = [];
  for (let directory = path.dirname(root); ; directory = path.dirname(directory)) {
    for (const marker of WORKSPACE_MARKERS) markers.push(path.join(directory, marker));
    if (path.dirname(directory) === directory) break;
  }
  return markers;
}

/** Why React Doctor must not run on this application, or null when it may. */
async function applicationRefusal(context: ProviderContext): Promise<string | null> {
  const files = context.snapshot.files ?? [];
  const executable = files.filter((file) => EXECUTABLE_CONFIGS.includes(path.posix.basename(file)));
  if (executable.length > 0) return `React Doctor would run the application's executable configuration (${executable.join(", ")}); use doctor.config.json instead`;
  try {
    await fs.access(path.join(context.root, ...BACKUPS));
    return "React Doctor left audit backups in .react-doctor/audit-backups; restore or remove them before running it";
  } catch {
    return null;
  }
}

async function locate(root: string, filePath: string, projects: readonly string[]): Promise<string | null> {
  const candidates = path.isAbsolute(filePath) ? [filePath] : [path.join(root, filePath), ...projects.map((project) => path.join(path.isAbsolute(project) ? project : path.join(root, project), filePath))];
  for (const candidate of candidates) {
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      await fs.access(candidate);
      return relative.split(path.sep).join("/");
    } catch {
      // Try the next project directory.
    }
  }
  return null;
}
