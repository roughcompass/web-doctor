import {
  mcpResponseSchema,
  stableIdentifier,
  type EffectivePolicySnapshot,
  type McpResponse,
  type ResponseProvenance,
  type SourceLocation,
  type UpdateNotice,
} from "../contracts/index.js";
import type { ProjectSnapshot } from "../facts/project-snapshot.js";
import { queryProvenance } from "../facts/queries.js";
import type { SharedFactsAvailability } from "../facts/shared-facts.js";
import type { BuildProvenance } from "../runtime/provenance.js";
import { DEFAULT_RESPONSE_BUDGET, decodeWindow, describeWindow, encodeWindow, fitToBudget, reduceToBudget, validBudget, type BudgetResult, type ResponseBudget } from "./budget.js";
import { redactValue } from "./redaction.js";

/**
 * The one response envelope CLI JSON output and MCP tool results share. A
 * request's id is derived from the tool, its parameters, and the exact
 * project and policy state, so equivalent requests answer identically from
 * either surface. Every response is redacted and held to a byte budget; a
 * reduced response says so in `truncated`, `complete`, and its warnings.
 */

export type ResponseParameters = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export interface ResponseContext {
  build: BuildProvenance;
  availability: SharedFactsAvailability;
  update: UpdateNotice | null;
}

export interface ResponseInput {
  tool: string;
  parameters: ResponseParameters;
  snapshot: ProjectSnapshot | null;
  policy: EffectivePolicySnapshot | null;
  data: unknown;
  complete: boolean;
  truncated?: boolean;
  continuation?: string | null;
  warnings?: readonly string[];
  budget?: ResponseBudget;
  /**
   * `window` pages an oversized response by its largest list with a
   * continuation; `shrink` only reduces, for results that page themselves.
   */
  budgetMode?: "window" | "shrink";
  /** A window continuation from an earlier page of this same request. */
  window?: string;
}

export function requestIdOf(tool: string, parameters: ResponseParameters, snapshot: ProjectSnapshot | null, policy: EffectivePolicySnapshot | null): string {
  return stableIdentifier("req", { tool, parameters, snapshot: snapshot?.digest ?? null, policy: policy?.digest ?? null });
}

const MAX_EVIDENCE = 100;

export function buildResponse(context: ResponseContext, input: ResponseInput): McpResponse {
  return buildBudgetedResponse(context, input).response;
}

/** The response and whether the budget reduced it. */
export function buildBudgetedResponse(context: ResponseContext, input: ResponseInput): { response: McpResponse; reduced: boolean } {
  const requestId = requestIdOf(input.tool, input.parameters, input.snapshot, input.policy);
  const redacted = redactValue({ data: input.data, warnings: [...(input.warnings ?? [])] });
  const envelope = (data: unknown, warnings: readonly string[], truncated: boolean, continuation: string | null, complete: boolean) => assemble(context, input, requestId, data, warnings, truncated, continuation, complete);
  const size = (data: unknown) => Buffer.byteLength(JSON.stringify(envelope(data, redacted.value.warnings, input.truncated ?? false, input.continuation ?? null, input.complete)));
  const budget = validBudget(input.budget ?? DEFAULT_RESPONSE_BUDGET);
  const from = input.window === undefined ? undefined : decodeWindow(input.window, requestId);
  const fit = (target: ResponseBudget) => (input.budgetMode === "shrink" ? reduceToBudget(redacted.value.data, size, target) : fitToBudget(redacted.value.data, size, target, from));
  const finish = (fitted: BudgetResult<unknown>) => {
    const warnings = [...redacted.value.warnings];
    if (redacted.count > 0) warnings.push(`Redacted ${redacted.count} sensitive ${redacted.count === 1 ? "value" : "values"}`);
    let truncated = input.truncated ?? false;
    let continuation = input.continuation ?? null;
    let complete = input.complete;
    if (fitted.window !== null) {
      const more = fitted.window.offset + fitted.window.returned < fitted.window.total;
      warnings.push(`Response budget of ${budget.maxBytes} bytes: ${describeWindow(fitted.window)}${more ? "; pass the continuation for the next items" : ""}`);
      truncated = more;
      continuation = more ? encodeWindow(requestId, fitted.window.path, fitted.window.offset + fitted.window.returned) : null;
      complete = false;
    }
    if (fitted.reductions.length > 0) {
      warnings.push(`Response budget of ${budget.maxBytes} bytes: ${fitted.reductions.join("; ")}`);
      complete = false;
    }
    return { response: envelope(fitted.data, warnings, truncated, continuation, complete), reduced: fitted.window !== null || fitted.reductions.length > 0 };
  };
  // The budget notice and continuation are added after fitting, so tighten until the final envelope fits.
  let target = budget;
  let result = finish(fit(target));
  for (let attempt = 0; attempt < 6; attempt++) {
    const over = Buffer.byteLength(JSON.stringify(result.response)) - budget.maxBytes;
    if (over <= 0) break;
    target = { maxBytes: target.maxBytes - over - 64 };
    result = finish(fit(target));
  }
  return result;
}

function assemble(context: ResponseContext, input: ResponseInput, requestId: string, data: unknown, inputWarnings: readonly string[], truncated: boolean, continuation: string | null, inputComplete: boolean): McpResponse {
  const provenance = responseProvenance(context, input.snapshot, input.policy);
  const warnings = [...inputWarnings];
  // Only a response built from a project snapshot depends on shared facts.
  const usesFacts = input.snapshot !== null;
  if (usesFacts && provenance.repoFacts.status !== "complete") warnings.push(`Shared repository facts are ${provenance.repoFacts.status}: ${provenance.repoFacts.reason ?? "no reason recorded"}`);
  if (context.update?.status === "outdated") warnings.push(`Web Doctor ${context.update.availableVersion ?? "(newer)"} is available; installed ${context.update.installedVersion}${context.update.command === null ? "" : `. Upgrade with: ${context.update.command}`}`);
  return mcpResponseSchema.parse({
    schema: "web-doctor.mcp-response",
    schemaVersion: 2,
    requestId,
    tool: input.tool,
    complete: inputComplete && (!usesFacts || provenance.repoFacts.status === "complete"),
    truncated,
    ...(truncated && continuation ? { continuationToken: continuation } : {}),
    provenance,
    update: context.update,
    evidence: collectLocations(data),
    warnings: [...new Set(warnings)],
    data,
  });
}

export function responseProvenance(context: ResponseContext, snapshot: ProjectSnapshot | null, policy: EffectivePolicySnapshot | null): ResponseProvenance {
  const { build } = context;
  const facts = snapshot === null ? null : queryProvenance(snapshot);
  const release = context.availability.status === "available" ? context.availability.release : null;
  const status = context.availability.status === "unavailable" ? "unavailable" : facts?.shared.status ?? "incomplete";
  return {
    webDoctor: { version: build.webDoctorVersion, commit: build.webDoctorCommit, registryDigest: build.registryDigest, catalogCommit: build.catalogCommit, catalogDigest: build.catalogDigest },
    repoFacts: {
      status,
      reason: context.availability.status === "unavailable" ? context.availability.problems.join("; ") : facts === null ? "No project was analyzed" : facts.shared.reason,
      release: release?.release ?? null,
      commit: release?.commit ?? null,
      configurationDigest: facts?.shared.configurationDigest ?? null,
      factDocumentDigest: facts?.shared.factDocumentDigest ?? null,
      incompleteCategories: facts?.shared.incompleteCategories ?? [],
    },
    extensions: facts === null ? null : { release: facts.extensions.release, stateDigest: facts.extensions.stateDigest, indexDigest: facts.extensions.indexDigest, incompleteCategories: facts.extensions.incompleteCategories },
    project: snapshot === null ? null : { root: snapshot.root, snapshotDigest: snapshot.digest, treeDigest: snapshot.treeDigest },
    policy: policy === null ? null : { digest: policy.digest, portals: policy.portals },
  };
}

/** Source locations cited anywhere in the response data, deduplicated and bounded. */
export function collectLocations(data: unknown): SourceLocation[] {
  const found = new Map<string, SourceLocation>();
  const visit = (value: unknown, depth: number): void => {
    if (found.size >= MAX_EVIDENCE || depth > 12 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string" && record.path !== "") {
      const lines = record.lines as { start?: unknown; end?: unknown } | null | undefined;
      const line = typeof record.line === "number" ? record.line : typeof lines?.start === "number" ? lines.start : undefined;
      const endLine = typeof record.endLine === "number" ? record.endLine : typeof lines?.end === "number" ? lines.end : undefined;
      if (line !== undefined && Number.isSafeInteger(line) && line > 0) {
        const location: SourceLocation = { path: record.path, line, ...(typeof record.column === "number" && record.column > 0 ? { column: record.column } : {}), ...(endLine !== undefined && endLine > 0 ? { endLine } : {}) };
        found.set(`${location.path}:${location.line}:${location.column ?? 0}`, location);
      }
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(data, 0);
  return [...found.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : (left.line ?? 0) - (right.line ?? 0)));
}
