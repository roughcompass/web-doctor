import pacote from "pacote";
import semver from "semver";

export type InstallationMode = "managed" | "project-exact" | "project-range" | "workspace" | "global" | "immutable-ci" | "unknown";
export type PackageUpdateStatus = "current" | "outdated" | "unknown";

export interface EnterprisePackageDistribution {
  packageName: string;
  registry: string;
  tag?: string;
}

export interface PackageUpdateOptions {
  installedVersion: string;
  installationMode: InstallationMode;
  distribution?: EnterprisePackageDistribution;
  lookup?: (distribution: EnterprisePackageDistribution) => Promise<string>;
}

export interface PackageUpdateState {
  status: PackageUpdateStatus;
  installedVersion: string;
  installationMode: InstallationMode;
  packageName?: string;
  availableVersion?: string;
  reason: string;
}

export async function resolvePackageUpdateState(options: PackageUpdateOptions): Promise<PackageUpdateState> {
  const base = {
    installedVersion: options.installedVersion,
    installationMode: options.installationMode,
  };
  if (semver.valid(options.installedVersion) === null) {
    return { ...base, status: "unknown", reason: "Installed package version is not valid semver" };
  }
  if (options.distribution === undefined) {
    return { ...base, status: "unknown", reason: "Enterprise package distribution is not configured" };
  }
  const distribution = options.distribution;
  try {
    const availableVersion = await (options.lookup ?? lookupEnterpriseVersion)(distribution);
    if (semver.valid(availableVersion) === null) throw new Error("Registry returned an invalid package version");
    const status = semver.gt(availableVersion, options.installedVersion) ? "outdated" : "current";
    return {
      ...base,
      status,
      packageName: distribution.packageName,
      availableVersion,
      reason: status === "outdated" ? "A newer enterprise package version is available" : "Installed package is current",
    };
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      packageName: distribution.packageName,
      reason: `Package update state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function lookupEnterpriseVersion(distribution: EnterprisePackageDistribution): Promise<string> {
  const registry = new URL(distribution.registry);
  if (registry.protocol !== "https:") throw new Error("Enterprise npm registry must use HTTPS");
  const manifest = await pacote.manifest(`${distribution.packageName}@${distribution.tag ?? "latest"}`, { registry: registry.href });
  return manifest.version;
}