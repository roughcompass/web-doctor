import { describe, expect, it } from "vitest";
import { digestDocument, policyPackSchema } from "../../src/contracts/index.js";
import {
  advisorContentPolicy,
  firmwideAccessibilityPolicy,
  representativePolicyPacks,
  wealthBrandPolicy,
} from "../fixtures/policies.js";

describe("representative policy fixtures", () => {
  it("validates firmwide, portal, platform, and application packs", () => {
    expect(representativePolicyPacks.map((pack) => policyPackSchema.parse(pack))).toHaveLength(5);
  });

  it("normalizes every pack deterministically", () => {
    for (const pack of representativePolicyPacks) {
      const parsed = policyPackSchema.parse(pack);
      const { controls, ...metadata } = parsed;
      const reordered = { controls, ...metadata };

      expect(digestDocument(parsed)).toEqual(digestDocument(reordered));
    }
  });

  it("models shared axe evidence as distinct control obligations", () => {
    const firmEvidence = firmwideAccessibilityPolicy.controls[0].evidence[0];
    const advisorEvidence = advisorContentPolicy.controls[0].evidence[0];

    expect(firmEvidence).toEqual(advisorEvidence);
    expect(firmwideAccessibilityPolicy.controls[0].id).not.toBe(advisorContentPolicy.controls[0].id);
  });

  it("scopes the Wealth brand control to Wealth source", () => {
    expect(wealthBrandPolicy.controls[0].applicability).toEqual({
      portals: { anyOf: ["wealth"] },
      files: { include: ["src/wealth/**"] },
    });
  });
});