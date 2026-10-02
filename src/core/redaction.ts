/**
 * Sensitive-value redaction for everything Web Doctor returns. Shared facts,
 * extension facts, findings, and warnings can quote commands, URLs, and
 * source literals; well-known credential shapes in them are replaced with
 * `[redacted]` before any response, report, or human output is produced.
 * The count of redactions is reported so nothing is silently altered.
 */

export const REDACTED = "[redacted]";

/** Identifiers that name a secret, such as NPM_TOKEN or client_secret; plural prose such as "tokens" does not match. */
const KEY_NAMES = "(?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET|AUTH_?KEY|CREDENTIALS?)(?:_[A-Za-z0-9_]*)?(?![A-Za-z0-9]))";

/** Patterns whose match is replaced; a pattern with a `keep` group keeps that prefix. */
const PATTERNS: readonly { pattern: RegExp; keep: boolean }[] = [
  // Private key blocks.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, keep: false },
  // Credentials embedded in URLs: scheme://user:password@host.
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'`]+@/gi, keep: true },
  // Authorization-style headers and bearer or basic credentials.
  { pattern: /((?:authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token)\s*[:=]\s*["']?(?:bearer\s+|basic\s+|token\s+)?)[^\s"'`,;]+/gi, keep: true },
  { pattern: /(\bbearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, keep: true },
  // Secret-named assignments and options: TOKEN=..., --password=..., password: "...".
  { pattern: new RegExp(`(\\b${KEY_NAMES}\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s"'\`;&|,]+)`, "gi"), keep: true },
  { pattern: /(--(?:password|passwd|token|api-key|apikey|secret|auth-token|client-secret)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"'`;&|]+)/gi, keep: true },
  // Secret query parameters.
  { pattern: /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|signature|sig|client_secret)=)[^&\s"'`#]+/gi, keep: true },
  // Well-known token formats.
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, keep: false },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, keep: false },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, keep: false },
  { pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g, keep: false },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, keep: false },
  { pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, keep: false },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, keep: false },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, keep: false },
];

export function redactText(text: string): { text: string; count: number } {
  let count = 0;
  let result = text;
  for (const { pattern, keep } of PATTERNS) {
    result = result.replace(pattern, (match: string, prefix: unknown) => {
      const kept = keep && typeof prefix === "string" ? prefix : "";
      const url = kept.endsWith("://");
      const secret = match.slice(kept.length, url ? -1 : undefined).replace(/^["']|["']$/g, "");
      if (secret === REDACTED) return match;
      count += 1;
      return `${kept}${REDACTED}${url ? "@" : ""}`;
    });
  }
  return { text: result, count };
}

/** Redacts every string in a JSON value, keys included; returns the value and how many values changed. */
export function redactValue<Value>(value: Value): { value: Value; count: number } {
  let count = 0;
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      const redacted = redactText(node);
      count += redacted.count;
      return redacted.text;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === "object") {
      const entries = Object.entries(node).map(([key, child]) => [visit(key) as string, visit(child)] as const);
      return Object.fromEntries(entries);
    }
    return node;
  };
  const redacted = visit(value) as Value;
  return { value: redacted, count };
}
