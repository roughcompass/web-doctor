import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli-app.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("provider validate", () => {
  it("accepts declared deterministic pass and fail fixtures", async () => {
    const fixture = await buildFixture(deterministicPlugin());
    const result = await invoke(fixture.args);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ valid: true, issues: [], fixtures: 2, rules: 1 });
  });

  it("rejects nondeterministic and undeclared-rule fixtures", async () => {
    const nondeterministic = await buildFixture(nondeterministicPlugin());
    const nondeterministicResult = await invoke(nondeterministic.args);
    expect(JSON.parse(nondeterministicResult.stdout).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "nondeterministic" }),
    ]));

    const undeclared = await buildFixture(deterministicPlugin(), "not-declared");
    const undeclaredResult = await invoke(undeclared.args);
    expect(JSON.parse(undeclaredResult.stdout).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fixture", message: expect.stringContaining("undeclared rule") }),
    ]));
  });
});

async function buildFixture(plugin: string, fixtureRule = "no-bad") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-provider-"));
  temporaryDirectories.push(directory);
  const manifestPath = path.join(directory, "provider.json");
  const contributionPath = path.join(directory, "web-doctor.json");
  const pluginPath = path.join(directory, "plugin.mjs");
  const passPath = path.join(directory, "pass.json");
  const failPath = path.join(directory, "fail.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    schema: "web-doctor.provider-manifest",
    schemaVersion: 1,
    id: "fixture",
    version: "1.0.0",
    owner: "Fixture Team",
    adapterVersion: "1.0.0",
    engine: "eslint",
    engineRange: "^9.0.0",
    compatibility: { webDoctor: ">=0.1.0" },
    evidenceKinds: ["static"],
    completeness: ["complete"],
    capabilities: ["filesystem-read"],
    invocationModes: ["static"],
    rules: [{ id: "no-bad", title: "No bad identifiers", evidenceKind: "static" }],
    artifacts: [{ path: "plugin.mjs", digest: "a".repeat(64) }],
  }), "utf8");
  await fs.writeFile(contributionPath, JSON.stringify({
    schema: "web-doctor.contribution",
    schemaVersion: 1,
    id: "platform/fixture",
    type: "provider",
    owner: "Fixture Team",
    compatibility: { webDoctor: ">=0.1.0" },
    portals: [],
    layers: ["platform"],
    documents: [{ kind: "provider", path: "provider.json" }],
    runtimeArtifacts: [{ path: "plugin.mjs", digest: "a".repeat(64) }],
    dependencies: ["platform/eslint-adapter"],
    fixtures: ["pass.json", "fail.json"],
    provenance: { repository: "ssh://git.internal/platform/fixture.git", commit: "c".repeat(40) },
  }), "utf8");
  await fs.writeFile(pluginPath, plugin, "utf8");
  await fs.writeFile(path.join(directory, "pass.js"), "const good = true;\n", "utf8");
  await fs.writeFile(path.join(directory, "fail.js"), "const bad = true;\n", "utf8");
  await fs.writeFile(passPath, JSON.stringify(providerFixture("pass", fixtureRule, "pass.js", "pass")), "utf8");
  await fs.writeFile(failPath, JSON.stringify(providerFixture("fail", fixtureRule, "fail.js", "fail")), "utf8");
  return {
    args: [
      "provider", "validate",
      "--manifest", manifestPath,
      "--contribution", contributionPath,
      "--plugin", pluginPath,
      "--fixture", passPath,
      "--fixture", failPath,
      "--json",
    ],
  };
}

function providerFixture(id: string, rule: string, input: string, expected: "pass" | "fail") {
  return { schema: "web-doctor.provider-fixture", schemaVersion: 1, id: `fixture/${id}`, rule, input, filename: input, expected };
}

function deterministicPlugin(): string {
  return `export default { rules: { "no-bad": { create(context) { return { Identifier(node) { if (node.name === "bad") context.report({ node, message: "Bad identifier" }); } }; } } } };`;
}

function nondeterministicPlugin(): string {
  return `let calls = 0; export default { rules: { "no-bad": { create(context) { return { Program(node) { calls += 1; if (calls % 2 === 1) context.report({ node, message: "Alternating" }); } }; } } } };`;
}

async function invoke(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { exitCode, stdout, stderr };
}