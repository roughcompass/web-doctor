import { canonicalJson } from "../contracts/index.js";

/**
 * Response budgets. A response larger than its byte budget is reduced
 * deterministically: the largest list in its data is windowed to what fits,
 * and a continuation token names the next window. The token is bound to the
 * request, which already identifies the tool, its parameters, and the exact
 * project and policy state, so a stale or foreign token is refused. If one
 * item still does not fit, lists inside it are shortened and long strings are
 * cut, and every reduction is listed in the response's warnings.
 */

export interface ResponseBudget {
  maxBytes: number;
}

export const DEFAULT_RESPONSE_BUDGET: ResponseBudget = { maxBytes: 256 * 1024 };
const MIN_BUDGET = 8 * 1024;
const MAX_STRING = 2_048;

export interface Window {
  path: string[];
  offset: number;
  returned: number;
  total: number;
}

export interface BudgetResult<Data> {
  data: Data;
  window: Window | null;
  /** Reductions without a continuation, such as lists inside one oversized item. */
  reductions: string[];
}

export class ContinuationError extends Error {
  override readonly name = "ContinuationError";

  constructor(readonly code: "invalid_continuation" | "stale_continuation", message: string) {
    super(message);
  }
}

/** A configured budget, never below 8 KiB so a single item and its provenance can fit. */
export function validBudget(budget: ResponseBudget): ResponseBudget {
  return { maxBytes: Math.max(MIN_BUDGET, Math.floor(budget.maxBytes)) };
}

export function encodeWindow(requestId: string, path: readonly string[], offset: number): string {
  return Buffer.from(canonicalJson({ v: 1, w: "window", r: requestId, p: path, o: offset }), "utf8").toString("base64url");
}

/** Reads a window continuation for this request; a token from another request or state is refused. */
export function decodeWindow(token: string, requestId: string): { path: string[]; offset: number } {
  let decoded: { v?: unknown; w?: unknown; r?: unknown; p?: unknown; o?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as typeof decoded;
  } catch {
    throw new ContinuationError("invalid_continuation", "The continuation is not a Web Doctor continuation");
  }
  if (decoded.v !== 1 || decoded.w !== "window" || !Array.isArray(decoded.p) || !decoded.p.every((part) => typeof part === "string") || typeof decoded.o !== "number" || !Number.isSafeInteger(decoded.o) || decoded.o < 0) {
    throw new ContinuationError("invalid_continuation", "The continuation is not a Web Doctor continuation");
  }
  if (decoded.r !== requestId) throw new ContinuationError("stale_continuation", "The continuation belongs to a different request or project state; repeat the request from the start");
  return { path: decoded.p as string[], offset: decoded.o };
}

/**
 * Fits data into a budget, given the size of the whole response for some
 * data. With a continuation, the same path is windowed from its offset.
 */
export function fitToBudget<Data>(data: Data, size: (data: Data) => number, budget: ResponseBudget, from?: { path: string[]; offset: number }): BudgetResult<Data> {
  const limit = budget.maxBytes;
  if (from === undefined && size(data) <= limit) return { data, window: null, reductions: [] };
  const path = from?.path ?? largestList(data)?.path ?? null;
  if (path === null) return shrink(data, size, limit, []);
  const list = at(data, path);
  if (!Array.isArray(list)) throw new ContinuationError("invalid_continuation", "The continuation names no list in this response");
  const offset = Math.min(from?.offset ?? 0, list.length);
  const windowed = (count: number) => replace(data, path, list.slice(offset, offset + count));
  let low = 0;
  let high = list.length - offset;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(windowed(middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  const returned = Math.max(Math.min(1, list.length - offset), low);
  const window = { path, offset, returned, total: list.length };
  const result = windowed(returned);
  if (size(result) <= limit) return { data: result, window, reductions: [] };
  return { ...shrink(result, size, limit, path), window };
}

export function describeWindow(window: Window): string {
  const label = ["data", ...window.path].join(".");
  return window.returned === 0 ? `${label} has no items after ${window.offset}` : `${label} items ${window.offset + 1}-${window.offset + window.returned} of ${window.total}`;
}

/** The list whose serialized items take the most bytes; ties go to the first path in code-unit order. */
export function largestList(data: unknown): { path: string[]; bytes: number } | null {
  let best: { path: string[]; bytes: number } | null = null;
  const visit = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) {
      if (node.length > 1) {
        const bytes = Buffer.byteLength(JSON.stringify(node));
        if (best === null || bytes > best.bytes || (bytes === best.bytes && path.join("\0") < best.path.join("\0"))) best = { path, bytes };
      }
      node.forEach((child, index) => visit(child, [...path, String(index)]));
      return;
    }
    if (node !== null && typeof node === "object") for (const [key, child] of Object.entries(node)) visit(child, [...path, key]);
  };
  visit(data, []);
  return best;
}

/** Reduces data to a budget without a window, for results that page themselves. */
export function reduceToBudget<Data>(data: Data, size: (data: Data) => number, budget: ResponseBudget): BudgetResult<Data> {
  const limit = budget.maxBytes;
  return size(data) <= limit ? { data, window: null, reductions: [] } : shrink(data, size, limit, []);
}

/** Shortens lists inside the kept window, then long strings, recording each reduction. */
function shrink<Data>(data: Data, size: (data: Data) => number, limit: number, windowPath: readonly string[]): BudgetResult<Data> {
  const reductions: string[] = [];
  let current = data;
  for (let round = 0; round < 64 && size(current) > limit; round++) {
    const target = largestList(current);
    if (target === null || target.path.join("\0") === windowPath.join("\0")) break;
    const list = at(current, target.path) as unknown[];
    const kept = Math.max(1, Math.floor(list.length / 2));
    current = replace(current, target.path, list.slice(0, kept));
    reductions.push(`${["data", ...target.path].join(".")} shortened to ${kept} of ${list.length} items`);
  }
  if (size(current) > limit) {
    let cut = 0;
    const visit = (node: unknown): unknown => {
      if (typeof node === "string" && node.length > MAX_STRING) {
        cut += 1;
        return `${node.slice(0, MAX_STRING)}… [${node.length - MAX_STRING} characters omitted]`;
      }
      if (Array.isArray(node)) return node.map(visit);
      if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
      return node;
    };
    current = visit(current) as Data;
    if (cut > 0) reductions.push(`${cut} strings longer than ${MAX_STRING} characters were cut`);
  }
  return { data: current, window: null, reductions: reductions.length > 6 ? [...reductions.slice(0, 5), `${reductions.length - 5} more lists shortened`] : reductions };
}

function at(data: unknown, path: readonly string[]): unknown {
  let node = data;
  for (const part of path) node = node !== null && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  return node;
}

function replace<Data>(data: Data, path: readonly string[], value: unknown): Data {
  if (path.length === 0) return value as Data;
  const [head, ...rest] = path;
  if (Array.isArray(data)) return data.map((item, index) => (String(index) === head ? replace(item, rest, value) : item)) as Data;
  return { ...(data as Record<string, unknown>), [head!]: replace((data as Record<string, unknown>)[head!], rest, value) } as Data;
}
