import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  parseContract,
  sha256,
  type Catalog,
  type RegistryOwnership,
} from "../../src/contracts/index.js";
import { generateContributionLock } from "../../src/registry/lock.js";
import { validateCatalog } from "../../src/registry/validate.js";

const baseCatalog = parseContract(
  "catalog",
  JSON.parse(fs.readFileSync(new URL("../../registry/catalog.json", import.meta.url), "utf8")) as unknown,
) as Catalog;
const ownership = parseContract(
  "registryOwnership",
  JSON.parse(fs.readFileSync(new URL("../../registry/ownership.json", import.meta.url), "utf8")) as unknown,
) as RegistryOwnership;

describe("GitOps contribution lifecycle", () => {
  it.each(["deprecated", "retired"] as const)("accepts %s entries with migration guidance and an active compatible replacement", (lifecycle) => {
    const revised = replacementCatalog(lifecycle);
    expect(validateCatalog(revised, ownership)).toEqual({ valid: true, issues: [] });
  });

  it("rejects missing migration guidance and incompatible replacement type", () => {
    const revised = replacementCatalog("deprecated");
    const changed: Catalog = {
      ...revised,
      entries: revised.entries.map((entry) => {
        if (entry.id === "firm/accessibility") return { ...entry, migration: undefined };
        if (entry.id === "firm/accessibility/v2") return { ...entry, type: "guidance" };
        return entry;
      }) as Catalog["entries"],
    };
    const codes = validateCatalog(changed, ownership).issues.map((issue) => issue.code);

    expect(codes).toEqual(expect.arrayContaining(["missing_migration", "replacement_type"]));
  });

  it("keeps earlier revisions reproducible and makes a revert byte-identical", () => {
    const originalMetadata = metadataFor(baseCatalog);
    const originalLock = generateContributionLock(baseCatalog, originalMetadata);
    const revised = replacementCatalog("retired");
    const revisedLock = generateContributionLock(revised, metadataFor(revised));
    const revertedLock = generateContributionLock(baseCatalog, originalMetadata);

    expect(canonicalJson(revisedLock)).not.toBe(canonicalJson(originalLock));
    expect(canonicalJson(revertedLock)).toBe(canonicalJson(originalLock));
  });
});

function replacementCatalog(lifecycle: "deprecated" | "retired"): Catalog {
  const current = baseCatalog.entries.find((entry) => entry.id === "firm/accessibility")!;
  return {
    ...baseCatalog,
    entries: [
      ...baseCatalog.entries.map((entry) =>
        entry.id === current.id
          ? {
              ...entry,
              lifecycle,
              replacement: "firm/accessibility/v2",
              migration: { guidance: "Move to firm/accessibility/v2." },
            }
          : entry,
      ),
      {
        ...current,
        id: "firm/accessibility/v2",
        source: { ...current.source, packageName: "@firm/accessibility-policy-v2", version: "2.0.0" },
      },
    ],
  };
}

function metadataFor(catalog: Catalog) {
  return new Map(catalog.entries.map((entry) => [entry.id, { digest: sha256(entry.id), contractVersion: 1 }]));
}