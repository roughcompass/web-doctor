import { describe, expect, it } from "vitest";
import { resolvePackageUpdateState } from "../../src/runtime/update-state.js";

const distribution = { packageName: "web-doctor", registry: "https://npm.internal.example/" };

describe("package update state", () => {
  it("reports current and outdated states across installation modes", async () => {
    await expect(resolvePackageUpdateState({
      installedVersion: "1.2.3",
      installationMode: "project-exact",
      distribution,
      lookup: async () => "1.2.3",
    })).resolves.toEqual({
      status: "current",
      installedVersion: "1.2.3",
      installationMode: "project-exact",
      packageName: "web-doctor",
      availableVersion: "1.2.3",
      reason: "Installed package is current",
    });
    await expect(resolvePackageUpdateState({
      installedVersion: "1.2.3",
      installationMode: "global",
      distribution,
      lookup: async () => "2.0.0",
    })).resolves.toMatchObject({ status: "outdated", availableVersion: "2.0.0", installationMode: "global" });
  });

  it("returns stable unknown states for missing configuration and lookup failure", async () => {
    await expect(resolvePackageUpdateState({
      installedVersion: "1.2.3",
      installationMode: "workspace",
    })).resolves.toEqual({
      status: "unknown",
      installedVersion: "1.2.3",
      installationMode: "workspace",
      reason: "Enterprise package distribution is not configured",
    });
    const options = {
      installedVersion: "1.2.3",
      installationMode: "project-range" as const,
      distribution,
      lookup: async () => { throw new Error("registry unavailable"); },
    };
    expect(await resolvePackageUpdateState(options)).toEqual(await resolvePackageUpdateState(options));
    await expect(resolvePackageUpdateState(options)).resolves.toMatchObject({
      status: "unknown",
      reason: "Package update state is unavailable: registry unavailable",
    });
  });
});