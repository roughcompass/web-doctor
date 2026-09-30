import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePolicyAuthoring } from "../../src/authoring/policy.js";
import { validateProviderAuthoring } from "../../src/authoring/provider.js";

const root = path.resolve(import.meta.dirname, "../../examples/adobe-analytics-governance");
const fixtureNames = [
  "no-direct-alloy-pass.json",
  "no-direct-alloy-fail.json",
  "canonical-event-pass.json",
  "canonical-event-fail.json",
  "no-identifiers-pass.json",
  "no-identifiers-fail.json",
];

describe("Adobe Analytics governance example", () => {
  it("validates one package containing all provider rules, fixtures, and policy references", async () => {
    const provider = JSON.parse(await fs.readFile(path.join(root, "provider.json"), "utf8")) as {
      artifacts: Array<{ digest: string }>;
    };
    const plugin = await fs.readFile(path.join(root, "plugin.mjs"));
    const digest = crypto.createHash("sha256").update(plugin).digest("hex");

    expect(digest).toBe(provider.artifacts[0]?.digest);
    await expect(validateProviderAuthoring({
      manifestPath: path.join(root, "provider.json"),
      contributionPath: path.join(root, "web-doctor.json"),
      pluginPath: path.join(root, "plugin.mjs"),
      fixturePaths: fixtureNames.map((name) => path.join(root, "fixtures", name)),
    })).resolves.toEqual({ valid: true, issues: [], fixtures: 6, rules: 3 });
    await expect(validatePolicyAuthoring({
      policyPath: path.join(root, "policy.json"),
      providerPaths: [path.join(root, "provider.json")],
      fixturePaths: [],
    })).resolves.toEqual({ valid: true, issues: [], fixtures: 0 });
  });
});