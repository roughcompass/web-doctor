import { describe, expect, it } from "vitest";
import { resolvePortalSelection } from "../../src/runtime/portal-selection.js";

describe("portal selection", () => {
  it("deduplicates repeated values and preserves explicit-source precedence", () => {
    expect(resolvePortalSelection({
      cli: ["wealth", "advisor", "wealth"],
      repository: ["advisor", "wealth"],
      assignment: ["wealth", "advisor"],
    })).toEqual({
      status: "resolved",
      portals: ["advisor", "wealth"],
      source: "cli",
      sources: [
        { source: "cli", portals: ["advisor", "wealth"] },
        { source: "repository", portals: ["advisor", "wealth"] },
        { source: "assignment", portals: ["advisor", "wealth"] },
      ],
    });
    expect(resolvePortalSelection({ mcp: ["wealth", "wealth"] })).toMatchObject({
      status: "resolved",
      portals: ["wealth"],
      source: "mcp",
    });
  });

  it("reports explanatory conflicts between non-empty sources", () => {
    expect(resolvePortalSelection({
      cli: ["wealth"],
      repository: ["advisor"],
      assignment: ["wealth", "advisor"],
    })).toEqual({
      status: "conflict",
      portals: [],
      sources: [
        { source: "cli", portals: ["wealth"] },
        { source: "repository", portals: ["advisor"] },
        { source: "assignment", portals: ["advisor", "wealth"] },
      ],
      message: "Portal sources disagree: explicit=[wealth]; repository=[advisor]; assignment=[advisor, wealth]",
    });
  });

  it("reports unresolved selection when every source is empty", () => {
    expect(resolvePortalSelection({ cli: [], repository: [] })).toEqual({ status: "unresolved", portals: [], sources: [] });
  });
});