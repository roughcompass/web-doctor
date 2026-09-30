import crypto from "node:crypto";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export class CanonicalJsonError extends Error {
  override readonly name = "CanonicalJsonError";
}

export const MAX_CANONICAL_DEPTH = 64;

export function canonicalJson(value: unknown): string {
  return serialize(value, 0, "$");
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestDocument(value: unknown): { canonical: string; digest: string } {
  const canonical = canonicalJson(value);
  return { canonical, digest: sha256(canonical) };
}

export function stableIdentifier(prefix: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) {
    throw new CanonicalJsonError(`Invalid identifier prefix ${JSON.stringify(prefix)}`);
  }
  return `${prefix}_${digestDocument(value).digest}`;
}

function serialize(value: unknown, depth: number, path: string): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalJsonError(`${path} exceeds the maximum nesting depth of ${MAX_CANONICAL_DEPTH}`);
  }

  switch (typeof value) {
    case "string":
      if (!value.isWellFormed()) throw new CanonicalJsonError(`${path} is not well-formed Unicode`);
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(`${path} must be a safe integer (got ${String(value)})`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => serialize(item, depth + 1, `${path}[${index}]`)).join(",")}]`;
      }
      if (!isPlainObject(value)) throw new CanonicalJsonError(`${path} must be a plain object`);
      return `{${Object.keys(value)
        .sort()
        .map((key) => {
          if (!key.isWellFormed()) throw new CanonicalJsonError(`${path} has a key that is not well-formed Unicode`);
          return `${JSON.stringify(key)}:${serialize(value[key], depth + 1, `${path}.${key}`)}`;
        })
        .join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`${path} has unsupported type ${typeof value}`);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}