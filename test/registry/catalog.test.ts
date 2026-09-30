import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseContract, type Catalog } from "../../src/contracts/index.js";

function readCatalog(): Catalog {
  const text = fs.readFileSync(new URL("../../registry/catalog.json", import.meta.url), "utf8");
  return parseContract("catalog", JSON.parse(text) as unknown) as Catalog;
}

describe("contribution catalog", () => {
  it("parses the checked-in GitOps catalog", () => {
    expect(readCatalog().entries).toHaveLength(5);
  });

  it("represents every policy layer and configured portal", () => {
    const catalog = readCatalog();

    expect(new Set(catalog.entries.flatMap((entry) => entry.layers))).toEqual(
      new Set(["firmwide", "portal", "platform", "application"]),
    );
    expect(catalog.portals.map((portal) => portal.id).sort()).toEqual(["advisor", "wealth"]);
  });

  it("pins every contribution to an exact internal npm artifact with provenance", () => {
    for (const entry of readCatalog().entries) {
      expect(entry.source.registry).toBe("internal");
      expect(entry.source.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.source.integrity).toMatch(/^sha512-/);
      expect(entry.source.provenance.commit).toMatch(/^[a-f0-9]{40}$/);
    }
  });
});