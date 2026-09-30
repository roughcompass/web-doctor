import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli-app.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("policy validate", () => {
  it("aggregates schema, namespace, applicability, provider-reference, and compatibility issues as JSON", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-policy-"));
    temporaryDirectories.push(directory);
    const policyPath = path.join(directory, "policy.json");
    await fs.writeFile(policyPath, JSON.stringify({
      schema: "web-doctor.policy-pack",
      schemaVersion: 1,
      id: "firm/example",
      version: "1.0.0",
      owner: "Fixture Team",
      layer: "firmwide",
      compatibility: { webDoctor: ">=9" },
      controls: [{
        id: "other/control",
        title: "Invalid control",
        rationale: "Exercise aggregate validation.",
        strength: "required",
        applicability: {
          files: { include: ["../outside.ts"] },
          capabilities: [{ name: "react", range: "not-a-range" }],
        },
        evidence: [{ provider: "missing", rule: "unknown", kind: "static", required: true }],
        verification: [],
      }],
    }), "utf8");

    const result = await invoke(["policy", "validate", "--policy", policyPath, "--json"]);
    const report = JSON.parse(result.stdout) as { issues: { code: string }[] };

    expect(result.exitCode).toBe(2);
    expect(new Set(report.issues.map((issue) => issue.code))).toEqual(new Set([
      "schema",
      "namespace",
      "applicability",
      "provider_reference",
      "compatibility",
    ]));
  });

  it("validates provider references and deterministic accept/reject fixtures", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-policy-valid-"));
    temporaryDirectories.push(directory);
    const policy = validPolicy();
    const policyPath = path.join(directory, "policy.json");
    const providerPath = path.join(directory, "provider.json");
    const acceptPath = path.join(directory, "accept.json");
    const rejectPath = path.join(directory, "reject.json");
    await fs.writeFile(policyPath, JSON.stringify(policy), "utf8");
    await fs.writeFile(path.join(directory, "valid-input.json"), JSON.stringify(policy), "utf8");
    await fs.writeFile(path.join(directory, "invalid-input.json"), JSON.stringify({ ...policy, controls: [] }), "utf8");
    await fs.writeFile(providerPath, JSON.stringify({
      schema: "web-doctor.provider-manifest",
      schemaVersion: 1,
      id: "eslint",
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
      rules: [{ id: "example/rule", title: "Example", evidenceKind: "static" }],
      artifacts: [{ path: "dist/provider.js", digest: "a".repeat(64) }],
    }), "utf8");
    await fs.writeFile(acceptPath, JSON.stringify(fixture("accept", "valid-input.json", "accept")), "utf8");
    await fs.writeFile(rejectPath, JSON.stringify(fixture("reject", "invalid-input.json", "reject")), "utf8");

    const result = await invoke([
      "policy", "validate", "--policy", policyPath,
      "--provider", providerPath,
      "--fixture", acceptPath,
      "--fixture", rejectPath,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ valid: true, issues: [], fixtures: 2 });
  });
});

function validPolicy() {
  return {
    schema: "web-doctor.policy-pack",
    schemaVersion: 1,
    id: "firm/example",
    version: "1.0.0",
    owner: "Fixture Team",
    layer: "firmwide",
    compatibility: { webDoctor: ">=0.1.0" },
    controls: [{
      id: "firm/example/control",
      title: "Example control",
      rationale: "Exercise policy authoring validation.",
      strength: "required",
      applicability: {},
      evidence: [{ provider: "eslint", rule: "example/rule", kind: "static", required: true }],
      verification: [{ kind: "test", description: "Run the fixture." }],
    }],
  };
}

function fixture(id: string, input: string, expected: "accept" | "reject") {
  return {
    schema: "web-doctor.fixture",
    schemaVersion: 1,
    id: `policy/${id}`,
    contract: "policyPack",
    input,
    expected,
  };
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