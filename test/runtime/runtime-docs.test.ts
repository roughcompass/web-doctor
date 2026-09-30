import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolvePortalSelection } from "../../src/runtime/portal-selection.js";
import {
  resolvePackageUpdateState,
  type InstallationMode,
  type PackageUpdateStatus,
} from "../../src/runtime/update-state.js";

describe("runtime documentation fixtures", () => {
  it("resolves the documented multiple-portal fixture", async () => {
    const fixture = JSON.parse(await fs.readFile(new URL("../../examples/runtime/multiple-portals.json", import.meta.url), "utf8")) as {
      sources: { cli: string[]; repository: string[]; assignment: string[] };
      expected: { status: string; portals: string[]; source: string };
    };
    expect(resolvePortalSelection(fixture.sources)).toMatchObject(fixture.expected);
  });

  it("resolves every documented update-state fixture", async () => {
    const fixture = JSON.parse(await fs.readFile(new URL("../../examples/runtime/update-states.json", import.meta.url), "utf8")) as {
      cases: Array<{
        installedVersion: string;
        installationMode: InstallationMode;
        availableVersion?: string;
        expectedStatus: PackageUpdateStatus;
      }>;
    };
    for (const example of fixture.cases) {
      const state = await resolvePackageUpdateState({
        installedVersion: example.installedVersion,
        installationMode: example.installationMode,
        ...(example.availableVersion === undefined ? {} : {
          distribution: { packageName: "web-doctor", registry: "https://npm.internal.example/" },
          lookup: async () => example.availableVersion!,
        }),
      });
      expect(state.status).toBe(example.expectedStatus);
    }
  });
});