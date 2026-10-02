import type { McpResponse } from "../contracts/index.js";
import { WebDoctor, type ContextQuery, type UpdateConfiguration } from "../core/web-doctor.js";
import { CliUsageError, integer, parseOptions, single, type ParsedOptions } from "./options.js";

/**
 * Product commands over the shared application core: project context,
 * effective policy, and update status. Every command supports `--json`,
 * which prints the same response envelope the MCP server returns.
 */

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliContext {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}

const COMMON = ["--root", "--registry"] as const;

export async function runContextCommand(args: readonly string[], io: CliIo, context: CliContext): Promise<number> {
  const parsed = parseOptions(args, {
    values: [...COMMON, "--limit", "--continuation", "--kind", "--path", "--category", "--symbol", "--references"],
    flags: ["--json"],
  });
  const query = contextQuery(parsed);
  const limit = integer(parsed, "limit");
  const continuation = single(parsed, "continuation");
  return withCore(parsed, context, {}, async (core) => {
    const response = await core.context(query, { ...(limit === undefined ? {} : { limit }), ...(continuation === undefined ? {} : { continuation }) });
    print(io, parsed, response, renderContext);
    return 0;
  });
}

export async function runPolicyEffective(args: readonly string[], io: CliIo, context: CliContext): Promise<number> {
  const parsed = parseOptions(args, { values: [...COMMON, "--file", "--continuation"], repeatable: ["--portal"], flags: ["--json", "--ci"] });
  if (parsed.positionals.length > 0) throw new CliUsageError(`Unexpected argument ${parsed.positionals[0]}`);
  return withCore(parsed, context, { mode: parsed.flags.has("ci") ? "ci" : "local" }, async (core) => {
    const file = single(parsed, "file");
    const continuation = single(parsed, "continuation");
    const response = await core.effectivePolicy({ ...(file === undefined ? {} : { file }), ...(continuation === undefined ? {} : { continuation }) });
    print(io, parsed, response, renderPolicy);
    const requirement = (response.data as { portalRequirement: { exitCode: number } }).portalRequirement;
    return requirement.exitCode;
  });
}

export async function withCore(
  parsed: ParsedOptions,
  context: CliContext,
  overrides: { mode?: "local" | "ci"; allowRuntime?: boolean },
  action: (core: WebDoctor) => Promise<number>,
): Promise<number> {
  const root = single(parsed, "root");
  const registryRoot = single(parsed, "registry") ?? context.env.WEB_DOCTOR_REGISTRY_ROOT;
  const portals = parsed.values.get("portal");
  const core = await WebDoctor.open({
    cwd: context.cwd,
    caller: "cli",
    watch: false,
    ...(root === undefined ? {} : { root }),
    ...(registryRoot === undefined ? {} : { registryRoot }),
    ...(portals === undefined ? {} : { portals }),
    ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
    ...(overrides.allowRuntime === undefined ? {} : { allowRuntime: overrides.allowRuntime }),
    ...budgetOf(context.env),
    ...(context.env.WEB_DOCTOR_REPO_FACTS_METADATA === undefined ? {} : { repoFactsMetadataPath: context.env.WEB_DOCTOR_REPO_FACTS_METADATA }),
    update: updateConfiguration(context.env),
  });
  try {
    return await action(core);
  } finally {
    await core.close();
  }
}

/** `WEB_DOCTOR_RESPONSE_BUDGET` sets the byte budget for every response, identically for the CLI and the MCP server. */
export function budgetOf(env: CliContext["env"]): { budget?: { maxBytes: number } } {
  const value = env.WEB_DOCTOR_RESPONSE_BUDGET;
  if (value === undefined || value === "") return {};
  if (!/^\d+$/.test(value)) throw new CliUsageError("WEB_DOCTOR_RESPONSE_BUDGET must be a number of bytes");
  return { budget: { maxBytes: Number(value) } };
}

/** Package update checks run only when an enterprise update registry is configured. */
export function updateConfiguration(env: CliContext["env"]): UpdateConfiguration {
  const registry = env.WEB_DOCTOR_UPDATE_REGISTRY;
  const managedRoot = env.WEB_DOCTOR_MANAGED_ROOT === undefined || env.WEB_DOCTOR_MANAGED_ROOT === "" ? {} : { managedRoot: env.WEB_DOCTOR_MANAGED_ROOT };
  return registry === undefined || registry === ""
    ? managedRoot
    : { ...managedRoot, distribution: { packageName: env.WEB_DOCTOR_UPDATE_PACKAGE ?? "web-doctor", registry, ...(env.WEB_DOCTOR_UPDATE_TAG === undefined ? {} : { tag: env.WEB_DOCTOR_UPDATE_TAG }) } };
}

export function print(io: CliIo, parsed: ParsedOptions, response: McpResponse, human: (response: McpResponse) => string[]): void {
  if (parsed.flags.has("json")) {
    io.stdout(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  for (const line of human(response)) io.stdout(`${line}\n`);
  for (const warning of response.warnings) io.stdout(`warning: ${warning}\n`);
  io.stdout(`${provenanceLine(response)}\n`);
}

function contextQuery(parsed: ParsedOptions): ContextQuery {
  const [topic = "overview", subject, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new CliUsageError(`Unexpected argument ${extra[0]}`);
  const optional = (name: string) => {
    const value = single(parsed, name);
    return value === undefined ? {} : { [name]: value };
  };
  const requireSubject = () => {
    if (subject === undefined) throw new CliUsageError(`context ${topic} requires a symbol id or name`);
    return subject;
  };
  switch (topic) {
    case "overview":
      return { query: "project_overview" };
    case "symbol": {
      const references = integer(parsed, "references");
      return { query: "explain_symbol", symbol: requireSubject(), ...(references === undefined ? {} : { referenceLimit: references }) };
    }
    case "usages": {
      const kind = single(parsed, "kind");
      if (kind !== undefined && !["jsx", "call", "import", "export", "type", "value"].includes(kind)) throw new CliUsageError(`Unknown reference kind ${kind}`);
      return { query: "usages", symbol: requireSubject(), ...(kind === undefined ? {} : { kind: kind as "jsx" }), ...optional("path") };
    }
    case "data-path":
      return { query: "data_path", symbol: requireSubject() };
    case "boundaries":
      return { query: "runtime_boundaries", ...optional("category") };
    case "tests":
      return { query: "tests", ...optional("path"), ...optional("symbol") };
    case "services":
      return { query: "service_dependencies", ...optional("path") };
    case "commands":
      return { query: "verification_commands", ...optional("kind") };
    default:
      throw new CliUsageError(`Unknown context topic ${topic}; use overview, symbol, usages, data-path, boundaries, tests, services, or commands`);
  }
}

function renderContext(response: McpResponse): string[] {
  const result = response.data as { query: string; summary: Record<string, unknown> | null; items: unknown[]; page: { returned: number; total: number; truncated: boolean }; unresolved: { subject: string; reason: string }[] };
  const lines = [`${result.query}: ${result.page.returned} of ${result.page.total}${result.page.truncated ? " (more with --continuation)" : ""}`];
  for (const [key, value] of Object.entries(result.summary ?? {})) lines.push(`  ${key}: ${Array.isArray(value) ? value.join(", ") || "none" : String(value)}`);
  for (const item of result.items) lines.push(`- ${describe(item)}`);
  for (const entry of result.unresolved) lines.push(`unresolved: ${entry.subject}: ${entry.reason}`);
  if (response.truncated && response.continuationToken !== undefined) lines.push(`continuation: ${response.continuationToken}`);
  return lines;
}

function renderPolicy(response: McpResponse): string[] {
  const data = response.data as { policy: { digest: string; portals: string[]; controls: { control: { id: string; strength: string } }[]; conflicts: string[]; unresolvedApplicability: string[] }; portalSelection: { status: string } };
  const lines = [`Effective policy ${data.policy.digest}`, `  portals: ${data.policy.portals.join(", ") || `none (${data.portalSelection.status})`}`];
  for (const entry of data.policy.controls) lines.push(`- ${entry.control.strength} ${entry.control.id}${data.policy.unresolvedApplicability.includes(entry.control.id) ? " (applicability unresolved)" : ""}`);
  for (const conflict of data.policy.conflicts) lines.push(`conflict: ${conflict}`);
  return lines;
}

function describe(item: unknown): string {
  if (typeof item !== "object" || item === null) return String(item);
  const record = item as Record<string, unknown>;
  if (typeof record.id === "string" && typeof record.state === "string") return `${record.id} ${record.state}${typeof record.facts === "number" ? ` (${record.facts} facts)` : ""}`;
  if (typeof record.symbol === "object" && record.symbol !== null) {
    const symbol = record.symbol as { id: string; kind: string };
    return `${symbol.kind} ${symbol.id}`;
  }
  if (typeof record.key === "string") return `${record.key}${typeof record.state === "string" ? ` ${record.state}` : ""}`;
  if (typeof record.kind === "string" && typeof record.path === "string") return `${record.kind} ${record.path}${typeof (record.location as { line?: unknown } | undefined)?.line === "number" ? `:${(record.location as { line: number }).line}` : ""}`;
  return JSON.stringify(item);
}

function provenanceLine(response: McpResponse): string {
  const { webDoctor, repoFacts, extensions, project } = response.provenance;
  if (project === null) return `Web Doctor ${webDoctor.version} registry ${webDoctor.registryDigest.slice(0, 12)}; repo-facts ${repoFacts.release ?? "unavailable"} not used`;
  return `Web Doctor ${webDoctor.version} registry ${webDoctor.registryDigest.slice(0, 12)}; repo-facts ${repoFacts.release ?? "unavailable"} ${repoFacts.status}${repoFacts.factDocumentDigest === null ? "" : ` facts ${repoFacts.factDocumentDigest.slice(0, 12)}`}${extensions === null ? "" : `; extensions ${extensions.stateDigest.slice(0, 12)}`}`;
}
