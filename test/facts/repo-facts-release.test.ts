import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DETECTOR_RELEASE } from "@repo-facts/bundle";
import { afterEach, describe, expect, it } from "vitest";
import { parseContract } from "../../src/contracts/index.js";
import {
  loadRepoFactsRelease,
  recordRepoFactsRelease,
  verifyInstalledRepoFacts,
  writeRepoFactsRelease,
} from "../../src/facts/repo-facts-release.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("pinned repo-facts release", () => {
  it("maps the scope only to the internal registry and disables lifecycle scripts", async () => {
    const npmrc = await fs.readFile(path.join(ROOT, ".npmrc"), "utf8");
    const settings = npmrc.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(settings).toEqual([
      "@repo-facts:registry=${REPO_FACTS_NPM_REGISTRY}",
      "omit-lockfile-registry-resolved=true",
      "ignore-scripts=true",
    ]);
    expect(settings.join("\n")).not.toMatch(/replace-registry-host|_authToken|_auth\s*=/);
    for (const workflow of ["registry.yml", "release.yml"]) {
      const text = await fs.readFile(path.join(ROOT, ".github", "workflows", workflow), "utf8");
      expect(text, workflow).toContain("- run: npm ci --ignore-scripts\n        env:\n          REPO_FACTS_NPM_REGISTRY: ${{ vars.REPO_FACTS_NPM_REGISTRY }}");
    }
  });

  it("pins bundle and contract at one exact release that the lockfile records without registry URLs", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const lock = JSON.parse(await fs.readFile(path.join(ROOT, "npm-shrinkwrap.json"), "utf8")) as { packages: Record<string, { version: string; integrity: string; resolved?: string }> };
    expect(manifest.dependencies["@repo-facts/bundle"]).toBe(DETECTOR_RELEASE);
    expect(manifest.dependencies["@repo-facts/contract"]).toBe(DETECTOR_RELEASE);
    const entries = Object.entries(lock.packages).filter(([key]) => key.includes("node_modules/@repo-facts/"));
    expect(entries.map(([key]) => key).sort()).toEqual(
      ["architecture", "bundle", "contract", "core", "services", "syntax"].map((name) => `node_modules/@repo-facts/${name}`),
    );
    for (const [key, entry] of entries) {
      expect(entry.version, key).toBe(DETECTOR_RELEASE);
      expect(entry.integrity, key).toMatch(/^sha512-/);
      expect(entry.resolved, key).toBeUndefined();
    }
  });

  it("records every lockstep package's integrity, commit, and installed content as build metadata", async () => {
    const release = await recordRepoFactsRelease({ root: ROOT });
    expect(release.release).toBe(DETECTOR_RELEASE);
    expect(release.packages.map((entry) => entry.name)).toEqual([
      "@repo-facts/architecture",
      "@repo-facts/bundle",
      "@repo-facts/contract",
      "@repo-facts/core",
      "@repo-facts/services",
      "@repo-facts/syntax",
    ]);
    expect(await verifyInstalledRepoFacts(release)).toEqual({ status: "verified", release: release.release, commit: release.commit });

    const directory = await temporary();
    const output = path.join(directory, "repo-facts.json");
    await writeRepoFactsRelease(output, release);
    expect(await loadRepoFactsRelease(output)).toEqual(release);
    expect(() => parseContract("repoFactsRelease", { ...release, schemaVersion: 2 })).toThrow("supported versions: 1");
  });

  it("vendors golden fixtures from the pinned release's source commit", async () => {
    const release = await recordRepoFactsRelease({ root: ROOT });
    const source = JSON.parse(await fs.readFile(path.join(ROOT, "test", "fixtures", "repo-facts", "SOURCE.json"), "utf8")) as { commit: string; release: string };
    expect(source).toEqual({ repository: "repo-facts", commit: release.commit, release: release.release });
  });

  it("detects substituted installed packages at runtime", async () => {
    const release = await recordRepoFactsRelease({ root: ROOT });
    const directory = await temporary();
    await fs.cp(path.join(ROOT, "node_modules", "@repo-facts"), path.join(directory, "node_modules", "@repo-facts"), { recursive: true });
    await fs.writeFile(path.join(directory, "consumer.js"), "");
    const resolveFrom = path.join(directory, "consumer.js");
    expect((await verifyInstalledRepoFacts(release, { resolveFrom })).status).toBe("verified");

    await fs.appendFile(path.join(directory, "node_modules", "@repo-facts", "core", "dist", "index.js"), "\n// substituted\n");
    expect(await verifyInstalledRepoFacts(release, { resolveFrom })).toEqual({
      status: "invalid",
      problems: ["@repo-facts/core installed files differ from the recorded release"],
    });

    await fs.rm(path.join(directory, "node_modules", "@repo-facts", "bundle"), { recursive: true });
    const missing = await verifyInstalledRepoFacts(release, { resolveFrom });
    expect(missing.status).toBe("invalid");
    expect(missing.status === "invalid" && missing.problems[0]).toContain("@repo-facts/bundle is not installed");
  });

  it("refuses ranges, mixed versions, nested copies, aliases, registry URLs, and missing integrity", async () => {
    const cases: [string, Record<string, string>, Record<string, object>, string][] = [
      ["range", { "@repo-facts/bundle": "^0.1.0", "@repo-facts/contract": "0.1.0" }, {}, "must be pinned to an exact version, not ^0.1.0"],
      ["split pins", { "@repo-facts/bundle": "0.1.0", "@repo-facts/contract": "0.1.1" }, {}, "are different releases"],
      ["mixed lock", pins(), { "node_modules/@repo-facts/core": { version: "0.2.0", integrity: INTEGRITY } }, "node_modules/@repo-facts/core is 0.2.0, not the pinned release 0.1.0"],
      ["nested copy", pins(), { "node_modules/@repo-facts/bundle/node_modules/@repo-facts/contract": { version: "0.1.0-rc.0", integrity: INTEGRITY } }, "is 0.1.0-rc.0, not the pinned release 0.1.0"],
      ["alias", pins(), { "node_modules/@repo-facts/core": { name: "not-repo-facts", version: "0.1.0", integrity: INTEGRITY } }, "is an alias for not-repo-facts"],
      ["registry URL", pins(), { "node_modules/@repo-facts/core": { version: "0.1.0", integrity: INTEGRITY, resolved: "https://registry.npmjs.org/@repo-facts/core/-/core-0.1.0.tgz" } }, "records a registry URL"],
      ["missing integrity", pins(), { "node_modules/@repo-facts/core": { version: "0.1.0" } }, "has no SHA-512 integrity"],
    ];
    for (const [name, dependencies, extraLock, message] of cases) {
      const directory = await temporary();
      await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "consumer", dependencies }));
      await fs.writeFile(path.join(directory, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/@repo-facts/bundle": { version: "0.1.0", integrity: INTEGRITY },
          "node_modules/@repo-facts/contract": { version: "0.1.0", integrity: INTEGRITY },
          ...extraLock,
        },
      }));
      await expect(recordRepoFactsRelease({ root: directory }), name).rejects.toThrow(message);
    }
  });

  it("fails closed without contacting any other registry when the internal registry is not configured", async () => {
    const directory = await temporary();
    await fs.copyFile(path.join(ROOT, ".npmrc"), path.join(directory, ".npmrc"));
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true }));
    await fs.writeFile(path.join(directory, "empty-npmrc"), "");
    const requests: string[] = [];
    const publicRegistry = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.statusCode = 404;
      response.end("{}");
    });
    await new Promise<void>((resolve) => publicRegistry.listen(0, "127.0.0.1", resolve));
    const address = publicRegistry.address();
    if (address === null || typeof address === "string") throw new Error("Registry address is unavailable");
    try {
      const npm = (args: string[]) => spawnSync("npm", [...args, "--userconfig", path.join(directory, "empty-npmrc")], {
        cwd: directory,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          npm_config_cache: path.join(directory, "cache"),
          npm_config_registry: `http://127.0.0.1:${address.port}/`,
          npm_config_update_notifier: "false",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      });
      expect(npm(["config", "get", "ignore-scripts"]).stdout.trim()).toBe("true");
      const installed = npm(["install", "--fetch-retries=0", `@repo-facts/bundle@${DETECTOR_RELEASE}`]);
      expect(installed.status).not.toBe(0);
      expect(requests.filter((url) => url.includes("repo-facts"))).toEqual([]);
      await expect(fs.access(path.join(directory, "node_modules", "@repo-facts"))).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => publicRegistry.close(() => resolve()));
    }
  }, 60_000);

  it.skipIf(process.env.REPO_FACTS_NPM_REGISTRY === undefined)("reproduces the recorded release from a clean script-disabled install", async () => {
    const directory = await temporary();
    await fs.copyFile(path.join(ROOT, ".npmrc"), path.join(directory, ".npmrc"));
    await fs.writeFile(path.join(directory, "empty-npmrc"), "");
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true, dependencies: pins() }));
    const installed = spawnSync("npm", ["install", "--userconfig", path.join(directory, "empty-npmrc")], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: directory, npm_config_cache: path.join(directory, "cache"), REPO_FACTS_NPM_REGISTRY: process.env.REPO_FACTS_NPM_REGISTRY },
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(await recordRepoFactsRelease({ root: directory })).toEqual(await recordRepoFactsRelease({ root: ROOT }));
  }, 180_000);
});

function pins(): Record<string, string> {
  return { "@repo-facts/bundle": DETECTOR_RELEASE, "@repo-facts/contract": DETECTOR_RELEASE };
}

async function temporary(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-repo-facts-")));
  temporaryDirectories.push(directory);
  return directory;
}
