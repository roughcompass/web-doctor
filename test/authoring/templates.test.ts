import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePolicyAuthoring } from "../../src/authoring/policy.js";
import { validateProviderAuthoring } from "../../src/authoring/provider.js";

const templates = path.resolve(import.meta.dirname, "../../templates");

describe("author templates", () => {
  it.each(["firmwide", "portal", "platform", "application"])("validates the %s policy template and fixtures", async (layer) => {
    const report = await validatePolicyAuthoring({
      policyPath: path.join(templates, layer, "policy.json"),
      providerPaths: [path.join(templates, "eslint-plugin", "provider.json")],
      fixturePaths: [
        path.join(templates, "policy-accept.fixture.json"),
        path.join(templates, "policy-reject.fixture.json"),
      ],
    });
    expect(report).toEqual({ valid: true, issues: [], fixtures: 2 });
  });

  it("validates the ESLint plugin template and deterministic fixtures", async () => {
    const root = path.join(templates, "eslint-plugin");
    const report = await validateProviderAuthoring({
      manifestPath: path.join(root, "provider.json"),
      contributionPath: path.join(root, "web-doctor.json"),
      pluginPath: path.join(root, "plugin.mjs"),
      fixturePaths: [path.join(root, "fixtures", "pass.json"), path.join(root, "fixtures", "fail.json")],
    });
    expect(report).toEqual({ valid: true, issues: [], fixtures: 2, rules: 1 });
  });
});