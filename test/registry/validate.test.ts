import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseContract,
  type Catalog,
  type CatalogEntry,
  type RegistryOwnership,
} from "../../src/contracts/index.js";
import { validateCatalog } from "../../src/registry/validate.js";

const catalog = parseContract(
  "catalog",
  JSON.parse(fs.readFileSync(new URL("../../registry/catalog.json", import.meta.url), "utf8")) as unknown,
) as Catalog;
const ownership = parseContract(
  "registryOwnership",
  JSON.parse(fs.readFileSync(new URL("../../registry/ownership.json", import.meta.url), "utf8")) as unknown,
) as RegistryOwnership;

describe("catalog validation", () => {
  it("accepts the checked-in catalog", () => {
    expect(validateCatalog(catalog, ownership)).toEqual({ valid: true, issues: [] });
  });

  it("reports every semantic error in one deterministic result", () => {
    const entries = catalog.entries.map((entry): CatalogEntry => {
      if (entry.id === "firm/accessibility") {
        return {
          ...entry,
          lifecycle: "deprecated",
          replacement: "application/engineering",
          dependencies: ["wealth/brand"],
          compatibility: { webDoctor: "<1" },
        };
      }
      if (entry.id === "wealth/brand") {
        return { ...entry, portals: ["legacy"], dependencies: ["firm/accessibility"], compatibility: { webDoctor: ">=2" } };
      }
      if (entry.id === "advisor/content") {
        return { ...entry, portals: ["unknown"], dependencies: ["missing/policy"] };
      }
      if (entry.id === "platform/runtime") return { ...entry, compatibility: { webDoctor: "not-a-range" } };
      return entry;
    });
    entries.push({ ...entries.find((entry) => entry.id === "platform/runtime")! });
    const changed: Catalog = {
      ...catalog,
      portals: [
        ...catalog.portals,
        { id: "legacy", lifecycle: "retired", replacement: "missing" },
      ],
      entries,
    };

    const result = validateCatalog(changed, ownership);
    const codes = new Set(result.issues.map((issue) => issue.code));

    expect(result.valid).toBe(false);
    expect(codes).toEqual(
      new Set([
        "cross_layer_weakening",
        "dependency_cycle",
        "duplicate_contribution",
        "inactive_portal",
        "incompatible_dependency",
        "incompatible_web_doctor",
        "invalid_compatibility",
        "invalid_portal_replacement",
        "missing_dependency",
        "missing_migration",
        "ownership",
        "unknown_portal",
      ]),
    );
    expect(result.issues).toEqual(
      [...result.issues].sort((left, right) =>
        `${left.code}\0${left.path}\0${left.message}`.localeCompare(`${right.code}\0${right.path}\0${right.message}`),
      ),
    );
  });
});