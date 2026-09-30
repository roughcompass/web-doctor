import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalJson,
  digestDocument,
  schemaVersionEnvelopeSchema,
  stableIdentifier,
} from "../../src/contracts/index.js";

describe("canonical JSON", () => {
  it("sorts object keys lexicographically while preserving array order", () => {
    expect(canonicalJson({ 9: "nine", 10: "ten", items: ["b", "a"] })).toBe(
      '{"10":"ten","9":"nine","items":["b","a"]}',
    );
  });

  it("produces the same digest and identifier for equivalent object order", () => {
    const first = { schema: "example", schemaVersion: 1, payload: { beta: 2, alpha: 1 } };
    const second = { payload: { alpha: 1, beta: 2 }, schemaVersion: 1, schema: "example" };

    expect(digestDocument(first)).toEqual(digestDocument(second));
    expect(stableIdentifier("document", first)).toBe(stableIdentifier("document", second));
  });

  it("changes digests and identifiers when material content changes", () => {
    const first = { schema: "example", schemaVersion: 1, value: "first" };
    const second = { schema: "example", schemaVersion: 1, value: "second" };

    expect(digestDocument(first).digest).not.toBe(digestDocument(second).digest);
    expect(stableIdentifier("document", first)).not.toBe(stableIdentifier("document", second));
  });

  it("rejects values outside the canonical JSON domain", () => {
    expect(() => canonicalJson({ value: 1.5 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ value: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => stableIdentifier("Invalid Prefix", {})).toThrow(CanonicalJsonError);
  });

  it("recognizes schema-version envelopes without discarding document fields", () => {
    expect(
      schemaVersionEnvelopeSchema.parse({ schema: "web-doctor.policy-pack", schemaVersion: 1, id: "firm/accessibility" }),
    ).toEqual({ schema: "web-doctor.policy-pack", schemaVersion: 1 });
  });
});