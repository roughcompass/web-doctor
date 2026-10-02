import path from "node:path";
import * as z from "zod/v4";
import type { ProviderManifest } from "../contracts/index.js";

/**
 * An explicit, authorized request to check rendered application states.
 * Web Doctor never discovers targets or starts an application server; the
 * caller names each running target, the state it represents, and how to
 * reach that state with declarative steps rather than scripts.
 */

export type RuntimeStep =
  | { action: "goto"; url: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "press"; key: string }
  | { action: "waitFor"; selector: string };

export interface RuntimeTarget {
  url: string;
  route?: string;
  state: string;
  viewport?: { width: number; height: number };
  steps?: RuntimeStep[];
  /** A Playwright storage-state file for an authenticated target; read, never echoed. */
  storageState?: string;
}

export interface RuntimeRequest {
  /** Must be true: runtime checks start a browser and contact the targets. */
  authorized: true;
  targets: RuntimeTarget[];
  /** Allows targets beyond loopback when the approved provider declares network-target. */
  allowRemoteHosts?: boolean;
  timeoutMs?: number;
}

const text = z.string().min(1);
const stepSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("goto"), url: text }),
  z.strictObject({ action: z.literal("click"), selector: text }),
  z.strictObject({ action: z.literal("fill"), selector: text, value: z.string() }),
  z.strictObject({ action: z.literal("press"), key: text }),
  z.strictObject({ action: z.literal("waitFor"), selector: text }),
]);

/** The shape of a runtime request, before its targets are checked against a provider. */
export const runtimeRequestSchema = z.strictObject({
  authorized: z.literal(true),
  targets: z.array(z.strictObject({
    url: text,
    route: text.optional(),
    state: text,
    viewport: z.strictObject({ width: z.int(), height: z.int() }).optional(),
    steps: z.array(stepSchema).max(50).optional(),
    storageState: text.optional(),
  })).min(1).max(50),
  allowRemoteHosts: z.boolean().optional(),
  timeoutMs: z.int().positive().max(600_000).optional(),
});

export class RuntimeRequestError extends Error {
  override readonly name = "RuntimeRequestError";
}

/** Parses a runtime request; `authorized` must be literally true. */
export function parseRuntimeRequest(input: unknown): RuntimeRequest {
  const parsed = runtimeRequestSchema.safeParse(input);
  if (!parsed.success) throw new RuntimeRequestError(`Invalid runtime request: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")}`);
  return parsed.data as RuntimeRequest;
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface ValidatedTarget {
  url: string;
  route: string | null;
  state: string;
  viewport: { width: number; height: number };
  steps: RuntimeStep[];
  storageState: string | null;
}

/** Validates targets against the approved provider's capabilities; returns the problems found. */
export function validateRuntimeRequest(request: RuntimeRequest, manifest: ProviderManifest): { targets: ValidatedTarget[]; problems: string[] } {
  const problems: string[] = [];
  const targets: ValidatedTarget[] = [];
  if (request.authorized !== true) problems.push("The runtime request is not authorized");
  if (!manifest.capabilities.includes("browser")) problems.push(`${manifest.id} does not declare the browser capability`);
  const remote = request.allowRemoteHosts === true && manifest.capabilities.includes("network-target");
  const checkUrl = (value: string, label: string): boolean => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      problems.push(`${label} is not a URL`);
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      problems.push(`${label} must use http or https`);
      return false;
    }
    if (!remote && !LOOPBACK.has(url.hostname)) {
      problems.push(`${label} is not a loopback address; remote targets need allowRemoteHosts and an approved network-target capability`);
      return false;
    }
    if (url.username !== "" || url.password !== "") {
      problems.push(`${label} must not embed credentials; use a storage-state file`);
      return false;
    }
    return true;
  };
  for (const [index, target] of request.targets.entries()) {
    const label = `Target ${index + 1}`;
    if (!checkUrl(target.url, label)) continue;
    if (target.state.trim() === "") {
      problems.push(`${label} needs a state label`);
      continue;
    }
    const viewport = target.viewport ?? DEFAULT_VIEWPORT;
    if (![viewport.width, viewport.height].every((size) => Number.isSafeInteger(size) && size >= 200 && size <= 7_680)) {
      problems.push(`${label} has an unsupported viewport`);
      continue;
    }
    const steps = target.steps ?? [];
    if (steps.some((step) => step.action === "goto" && !checkUrl(step.url, `${label} step`))) continue;
    if (target.storageState !== undefined && !path.isAbsolute(target.storageState)) {
      problems.push(`${label} storage state must be an absolute path`);
      continue;
    }
    targets.push({ url: target.url, route: target.route ?? null, state: target.state.trim(), viewport, steps, storageState: target.storageState ?? null });
  }
  if (request.targets.length === 0) problems.push("The runtime request names no targets");
  return { targets, problems };
}

export function describeTarget(target: Pick<ValidatedTarget, "url" | "state" | "viewport">): string {
  return `${target.url} [${target.state}] ${target.viewport.width}x${target.viewport.height}`;
}
