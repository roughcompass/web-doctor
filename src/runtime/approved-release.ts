import pacote from "pacote";
import { internalNpmSourceSchema, type InternalNpmSource } from "../contracts/index.js";
import type { EnterprisePackageDistribution } from "./update-state.js";

/**
 * The approved coordinates of one Web Doctor release in the enterprise
 * registry: exact version, SHA-512 integrity, and source provenance. A
 * managed update installs only a release whose integrity the registry
 * publishes and whose source commit it records.
 */
export async function approvedRelease(distribution: EnterprisePackageDistribution, version: string, options: { allowInsecureRegistry?: boolean } = {}): Promise<InternalNpmSource> {
  const registry = new URL(distribution.registry);
  if (registry.protocol !== "https:" && options.allowInsecureRegistry !== true) throw new Error("Enterprise npm registry must use HTTPS");
  const manifest = await pacote.manifest(`${distribution.packageName}@${version}`, { registry: registry.href, fullMetadata: true }) as unknown as {
    version: string;
    _integrity?: string;
    dist?: { integrity?: string };
    gitHead?: string;
    repository?: string | { url?: string };
  };
  const integrity = manifest.dist?.integrity ?? manifest._integrity;
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (integrity === undefined || !integrity.startsWith("sha512-")) throw new Error(`${distribution.packageName}@${version} has no SHA-512 integrity in the enterprise registry`);
  if (manifest.gitHead === undefined || repository === undefined) throw new Error(`${distribution.packageName}@${version} does not record its source repository and commit`);
  return internalNpmSourceSchema.parse({
    schema: "web-doctor.npm-source",
    schemaVersion: 1,
    registry: "internal",
    packageName: distribution.packageName,
    version: manifest.version,
    integrity,
    provenance: { repository, commit: manifest.gitHead },
  });
}
