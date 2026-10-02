import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packContribution } from "../../src/authoring/contribution-package.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("contribution packaging", () => {
  it("produces byte-identical validated packages without rewriting author files", async () => {
    const root = await buildSource();
    const manifestPath = path.join(root, "web-doctor.json");
    const originalManifest = await fs.readFile(manifestPath);
    const firstOutput = path.join(root, "first");
    const secondOutput = path.join(root, "second");

    const first = await packContribution({ root, outputDirectory: firstOutput });
    const second = await packContribution({ root, outputDirectory: secondOutput });

    expect(await fs.readFile(path.join(firstOutput, first.filename))).toEqual(await fs.readFile(path.join(secondOutput, second.filename)));
    expect(first.integrity).toBe(second.integrity);
    expect(first.files).toEqual(expect.arrayContaining([
      "fixtures/input.json",
      "fixtures/policy.json",
      "web-doctor.json",
    ]));
    expect(await fs.readFile(manifestPath)).toEqual(originalManifest);
    expect(first.provenance.commit).toBe("c".repeat(40));
  });
});

async function buildSource(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-contribution-source-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "fixtures"), { recursive: true });
  const policy = {
    schema: "web-doctor.policy-pack",
    schemaVersion: 2,
    id: "firm/example",
    version: "1.0.0",
    owner: "Fixture Team",
    layer: "firmwide",
    compatibility: { webDoctor: ">=0.1.0" },
    controls: [{
      id: "firm/example/control",
      title: "Example",
      rationale: "Exercise packaging.",
      strength: "required",
      applicability: {},
      evidence: [{ provider: "eslint", rule: "example", kind: "static", required: true }],
      verification: [{ kind: "test", description: "Run fixture." }],
    }],
  };
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@firm/example", version: "1.0.0" }, null, 2), "utf8");
  await fs.writeFile(path.join(root, "policy.json"), JSON.stringify(policy, null, 2), "utf8");
  await fs.writeFile(path.join(root, "fixtures", "input.json"), JSON.stringify(policy), "utf8");
  await fs.writeFile(path.join(root, "fixtures", "policy.json"), JSON.stringify({
    schema: "web-doctor.fixture",
    schemaVersion: 1,
    id: "policy/accept",
    contract: "policyPack",
    input: "fixtures/input.json",
    expected: "accept",
  }), "utf8");
  await fs.writeFile(path.join(root, "web-doctor.json"), JSON.stringify({
    schema: "web-doctor.contribution",
    schemaVersion: 1,
    id: "firm/example",
    type: "policy",
    owner: "Fixture Team",
    compatibility: { webDoctor: ">=0.1.0" },
    portals: [],
    layers: ["firmwide"],
    documents: [{ kind: "policy", path: "policy.json" }],
    runtimeArtifacts: [],
    dependencies: [],
    fixtures: ["fixtures/policy.json"],
    provenance: { repository: "ssh://git.internal/firm/example.git", commit: "c".repeat(40) },
  }, null, 4), "utf8");
  expect(crypto.createHash("sha256").update(await fs.readFile(path.join(root, "web-doctor.json"))).digest("hex")).toHaveLength(64);
  return root;
}