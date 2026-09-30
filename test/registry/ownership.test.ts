import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseContract,
  type Catalog,
  type RegistryOwnership,
} from "../../src/contracts/index.js";
import { ownershipCoverageIssues } from "../../src/registry/ownership.js";

function readJson(path: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8")) as unknown;
}

const catalog = parseContract("catalog", readJson("../../registry/catalog.json")) as Catalog;
const ownership = parseContract(
  "registryOwnership",
  readJson("../../registry/ownership.json"),
) as RegistryOwnership;

describe("registry ownership", () => {
  it("resolves every contribution and portal to exactly one owner", () => {
    expect(ownershipCoverageIssues(catalog, ownership)).toEqual([]);
  });

  it("detects an owner whose namespace does not cover its contribution", () => {
    const changed = {
      ...ownership,
      owners: ownership.owners.map((owner) =>
        owner.id === "enterprise-accessibility" ? { ...owner, namespaces: ["firm/other"] } : owner,
      ),
    };

    expect(ownershipCoverageIssues(catalog, changed)).toContain(
      "Contribution firm/accessibility must resolve to exactly one owning team",
    );
  });

  it("protects the whole registry path with the platform review team", () => {
    const codeowners = fs.readFileSync(new URL("../../.github/CODEOWNERS", import.meta.url), "utf8").trim();

    expect(codeowners).toBe(`/registry/ ${ownership.platformReviewTeam}`);
  });
});