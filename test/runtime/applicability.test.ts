import { describe, expect, it } from "vitest";
import { evaluateApplicability, type ApplicabilityFacts } from "../../src/runtime/applicability.js";

const applicability = {
  portals: { anyOf: ["wealth"] },
  files: { include: ["src/**"], exclude: ["src/generated/**"] },
  capabilities: [{ name: "react", range: ">=19" }],
  dependencies: [{ name: "react", range: "^19.0.0" }],
  runtimes: [{ name: "node", range: ">=24" }],
  applicationMetadata: { managed: true },
};

const matchingFacts: ApplicabilityFacts = {
  portals: ["wealth"],
  file: "src/app.tsx",
  capabilities: { react: "19.1.0" },
  dependencies: { react: "19.1.0" },
  runtimes: { node: "24.14.0" },
  applicationMetadata: { managed: true },
};

describe("bounded applicability", () => {
  it("matches every bounded predicate", () => {
    const result = evaluateApplicability(applicability, matchingFacts);
    expect(result.status).toBe("match");
    expect(result.reasons.map((entry) => entry.predicate)).toEqual([
      "portals", "files", "capabilities", "dependencies", "runtimes", "applicationMetadata",
    ]);
    expect(result.reasons.every((entry) => entry.status === "match")).toBe(true);
  });

  it.each([
    ["portals", { portals: ["advisor"] }],
    ["files", { file: "src/generated/output.ts" }],
    ["capabilities", { capabilities: { react: "18.0.0" } }],
    ["dependencies", { dependencies: { react: "18.0.0" } }],
    ["runtimes", { runtimes: { node: "22.0.0" } }],
    ["applicationMetadata", { applicationMetadata: { managed: false } }],
  ] as const)("returns no-match for %s", (predicate, replacement) => {
    const result = evaluateApplicability(applicability, { ...matchingFacts, ...replacement });
    expect(result.status).toBe("no-match");
    expect(result.reasons).toContainEqual(expect.objectContaining({ predicate, status: "no-match" }));
  });

  it.each([
    ["portals", "portals"],
    ["files", "file"],
    ["capabilities", "capabilities"],
    ["dependencies", "dependencies"],
    ["runtimes", "runtimes"],
    ["applicationMetadata", "applicationMetadata"],
  ] as const)("returns unresolved for missing %s facts", (predicate, key) => {
    const facts = { ...matchingFacts };
    delete facts[key];
    const result = evaluateApplicability(applicability, facts);
    expect(result.status).toBe("unresolved");
    expect(result.reasons).toContainEqual(expect.objectContaining({ predicate, status: "unresolved" }));
  });
});