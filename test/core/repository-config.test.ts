import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRepositoryConfig } from "../../src/core/repository-config.js";
import { WebDoctor } from "../../src/core/web-doctor.js";
import { representativePolicyPacks } from "../fixtures/policies.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";
import { materialize } from "../support/repo-facts-fixtures.js";

let workspace: string;
let registry: string;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-config-")));
  registry = (await writeEmbeddedRegistry(path.join(workspace, "registry"), { policies: representativePolicyPacks })).root;
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function project(name: string, config?: unknown): Promise<string> {
  const root = path.join(workspace, name);
  await materialize(root, { "package.json": '{"name":"configured","dependencies":{"react":"18.3.1"}}\n', "src/App.tsx": "export const App = () => <main />;\n" });
  if (config !== undefined) await fs.writeFile(path.join(root, "web-doctor.config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return root;
}

describe("repository configuration", () => {
  it("is optional and rejects links, invalid JSON, and invalid documents", async () => {
    expect(await loadRepositoryConfig(await project("none"))).toEqual({ path: null, config: null });
    await expect(loadRepositoryConfig(await project("broken", "{ not json"))).rejects.toThrow("is not valid JSON");
    await expect(loadRepositoryConfig(await project("invalid", { schema: "web-doctor.repository-config", schemaVersion: 1, portals: ["Not An Id"] }))).rejects.toThrow("is invalid");
    await expect(loadRepositoryConfig(await project("future", { schema: "web-doctor.repository-config", schemaVersion: 2 }))).rejects.toThrow("supported versions: 1");
    const linked = await project("linked");
    await fs.writeFile(path.join(workspace, "outside.json"), JSON.stringify({ schema: "web-doctor.repository-config", schemaVersion: 1 }));
    await fs.symlink(path.join(workspace, "outside.json"), path.join(linked, "web-doctor.config.json"));
    await expect(loadRepositoryConfig(linked)).rejects.toThrow("must be a regular file");
  });

  it("applies configured portals and reports a conflict with explicit portals instead of choosing one", async () => {
    const root = await project("portals", { schema: "web-doctor.repository-config", schemaVersion: 1, portals: ["wealth"], applicationMetadata: { managed: true } });
    const configured = await WebDoctor.open({ cwd: root, caller: "cli", registryRoot: registry, watch: false });
    const agreeing = await WebDoctor.open({ cwd: root, caller: "cli", registryRoot: registry, watch: false, portals: ["wealth"] });
    const contradicting = await WebDoctor.open({ cwd: root, caller: "mcp", registryRoot: registry, watch: false, portals: ["advisor"] });
    try {
      const fromConfig = (await configured.effectivePolicy()).data as { policy: { portals: string[] }; portalSelection: { status: string; sources: unknown[] } };
      expect(fromConfig.policy.portals).toEqual(["wealth"]);
      expect(fromConfig.portalSelection).toEqual({ status: "resolved", portals: ["wealth"], sources: [{ source: "repository", portals: ["wealth"] }] });
      expect(((await agreeing.effectivePolicy()).data as { portalSelection: { status: string } }).portalSelection.status).toBe("resolved");

      const conflict = await contradicting.effectivePolicy();
      expect(conflict.data).toMatchObject({
        policy: { portals: [], conflicts: ["Portal sources disagree: explicit=[advisor]; repository=[wealth]"] },
        portalSelection: { status: "conflict", message: "Portal sources disagree: explicit=[advisor]; repository=[wealth]" },
        portalRequirement: { status: "warning", claimsPortalConformance: false },
      });
      expect(conflict.warnings).toContain("Portal sources disagree: explicit=[advisor]; repository=[wealth]");
      expect(conflict.complete).toBe(false);
    } finally {
      await Promise.all([configured.close(), agreeing.close(), contradicting.close()]);
    }
  });
});
