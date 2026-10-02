import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, parseContract, type ProviderApproval, type ProviderManifest } from "../contracts/index.js";

/**
 * Third-party analyzer engines that run only under a recorded legal and
 * security approval. The approval ships with Web Doctor in `approvals/`, is
 * reviewed like source, and pins each approved release by version, registry
 * integrity, installed content, rule set, and output schema. A provider
 * manifest for a gated engine is refused at registry build time and at run
 * time unless it names an approved release exactly.
 */

export const APPROVAL_GATED_ENGINES: readonly string[] = ["react-doctor"];

const APPROVALS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../approvals");

export type ApprovedRelease = ProviderApproval["releases"][number];

/** The recorded approval for an engine, or null when none is recorded. */
export async function loadProviderApproval(engine: string, root: string = APPROVALS_ROOT): Promise<ProviderApproval | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, `${engine}.json`), "utf8");
  } catch {
    return null;
  }
  return parseContract("providerApproval", JSON.parse(text) as unknown) as ProviderApproval;
}

/** The approved release a provider manifest selects, or why it is not approved. */
export function approvedReleaseFor(manifest: ProviderManifest, approval: ProviderApproval | null): { release: ApprovedRelease } | { problem: string } {
  if (approval === null) return { problem: `${manifest.engine} has no recorded legal and security approval` };
  if (approval.engine !== manifest.engine) return { problem: `The recorded approval covers ${approval.engine}, not ${manifest.engine}` };
  if (approval.legal.status !== "approved") return { problem: `${manifest.engine} is not legally approved` };
  if (approval.security.status !== "approved") return { problem: `${manifest.engine} is not approved by security review` };
  const release = approval.releases.find((candidate) => candidate.version === manifest.engineRange);
  if (release === undefined) return { problem: `${manifest.id} requests ${manifest.engine} ${manifest.engineRange}; approved releases are ${approval.releases.map((candidate) => candidate.version).join(", ")}, each pinned exactly` };
  return { release };
}

/** SHA-256 of a rule catalog's rules in canonical order, as an approval pins it. */
export function rulesetDigest(catalog: { rules?: unknown }): string {
  const rules = Array.isArray(catalog.rules) ? [...catalog.rules].sort((left, right) => (String((left as { key?: unknown }).key) < String((right as { key?: unknown }).key) ? -1 : 1)) : [];
  return crypto.createHash("sha256").update(canonicalJson(rules)).digest("hex");
}

/** Why a gated provider's embedded rule catalog does not match its approved release; empty when it does. */
export function rulesetProblems(manifest: ProviderManifest, release: ApprovedRelease, catalogBytes: Buffer | null): string[] {
  if (catalogBytes === null) return [`${manifest.id} embeds no rule catalog`];
  let catalog: { rules?: unknown };
  try {
    catalog = JSON.parse(catalogBytes.toString("utf8")) as { rules?: unknown };
  } catch {
    return [`${manifest.id} rule catalog is not JSON`];
  }
  return rulesetDigest(catalog) === release.rulesetDigest ? [] : [`${manifest.id} rule catalog does not match the approved ${manifest.engine} ${release.version} rule set`];
}
