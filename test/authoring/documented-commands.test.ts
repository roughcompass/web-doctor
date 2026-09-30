import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli-app.js";

const root = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("documented authoring commands", () => {
  it("executes every fixture-backed CLI example", async () => {
    const policy = await invoke([
      "policy", "validate",
      "--policy", at("templates/firmwide/policy.json"),
      "--provider", at("templates/eslint-plugin/provider.json"),
      "--fixture", at("templates/policy-accept.fixture.json"),
      "--fixture", at("templates/policy-reject.fixture.json"),
      "--json",
    ]);
    const provider = await invoke([
      "provider", "validate",
      "--manifest", at("templates/eslint-plugin/provider.json"),
      "--contribution", at("templates/eslint-plugin/web-doctor.json"),
      "--plugin", at("templates/eslint-plugin/plugin.mjs"),
      "--fixture", at("templates/eslint-plugin/fixtures/pass.json"),
      "--fixture", at("templates/eslint-plugin/fixtures/fail.json"),
      "--json",
    ]);
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-documented-pack-"));
    temporaryDirectories.push(output);
    const pack = await invoke([
      "contribution", "pack",
      "--root", at("templates/firmwide"),
      "--output", output,
      "--json",
    ]);

    expect([policy.exitCode, provider.exitCode, pack.exitCode]).toEqual([0, 0, 0]);
    expect(JSON.parse(policy.stdout)).toMatchObject({ valid: true });
    expect(JSON.parse(provider.stdout)).toMatchObject({ valid: true });
    expect(JSON.parse(pack.stdout)).toMatchObject({ packageName: "@example/firmwide-policy" });
  });
});

function at(relativePath: string): string {
  return path.join(root, relativePath);
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