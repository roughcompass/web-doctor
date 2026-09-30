import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseContract, type ContractKind } from "../../src/contracts/index.js";

const examples: readonly [ContractKind, string, string][] = [
  ["internalNpmSource", "web-doctor.npm-source", "npm-source.json"],
  ["contribution", "web-doctor.contribution", "contribution.json"],
  ["contributionFixture", "web-doctor.fixture", "contribution-fixture.json"],
  ["policyPack", "web-doctor.policy-pack", "policy-pack.json"],
  ["providerManifest", "web-doctor.provider-manifest", "provider-manifest.json"],
  ["catalog", "web-doctor.catalog", "catalog.json"],
  ["registryOwnership", "web-doctor.registry-ownership", "registry-ownership.json"],
  ["contributionLock", "web-doctor.contribution-lock", "contribution-lock.json"],
  ["registrySnapshot", "web-doctor.registry-snapshot", "registry-snapshot.json"],
  ["effectivePolicySnapshot", "web-doctor.effective-policy", "effective-policy.json"],
  ["normalizedFinding", "web-doctor.finding", "finding.json"],
  ["guidanceEntry", "web-doctor.guidance-entry", "guidance-entry.json"],
  ["mcpResponse", "web-doctor.mcp-response", "mcp-response.json"],
];

describe("contract documentation", () => {
  it("links every published schema and validated example", () => {
    const documentation = fs.readFileSync(new URL("../../docs/contracts.md", import.meta.url), "utf8");
    const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");

    expect(readme).toContain("docs/contracts.md");
    for (const [, schemaName, filename] of examples) {
      expect(documentation).toContain(`\`${schemaName}\``);
      expect(documentation).toContain(`examples/contracts/${filename}`);
    }
  });

  it("documents every contract boundary and compatibility guarantee", () => {
    const documentation = fs.readFileSync(new URL("../../docs/contracts.md", import.meta.url), "utf8");

    for (const heading of [
      "## Contract Layers",
      "## Exact Package Identity",
      "## Catalog, Lock, and Snapshot Guarantees",
      "## Compatibility Rules",
      "## Lifecycle and Migration",
      "## Validation and Offline Behavior",
    ]) {
      expect(documentation).toContain(heading);
    }
  });

  it("parses every published JSON example through the public contract parser", () => {
    for (const [kind, , filename] of examples) {
      const text = fs.readFileSync(new URL(`../../examples/contracts/${filename}`, import.meta.url), "utf8");
      expect(() => parseContract(kind, JSON.parse(text) as unknown)).not.toThrow();
    }
  });
});